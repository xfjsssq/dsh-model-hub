// dsh-model-hub — 宿主侧自测：改前/改后对比（契约 §5.1 B + task-4）。
//
// 两层证据，缺一不可：
//   1) before / after                 —— ctx.llm.resolveModelInfo()：模型能力元数据的真实值
//   2) beforePrepared / afterPrepared —— ctx.llm.prepareCall()：**真正要发出去的请求参数**
//      maxTokens 会由适配器默认物化（provider 未显式给就用 defaultMaxTokens），所以这一层才是
//      '改动确实影响请求' 的主证据；只看元数据分辨不出'配好了'和'真用上了'。
//
// 只读承诺：prepareCall 只做能力解析，不发出任何上游请求；它返回的 stream() 我们**绝不调用**。
// 取消：prepareCall 接收 AbortSignal —— 外部可传 options.signal，否则用 options.timeoutMs 兜底。
//      该信号**只**作用于 prepareCall 读取；写入与还原绝不被信号跳过，
//      否则一次断开连接就可能留下改了一半、没还原的 profile。

import { effectiveModel } from './catalog.js'
import {
  declaredModelRow,
  describeSettings,
  findProviderEntry,
  llmService,
  mutateRaw,
  rawModelFields,
  resolveModelBase,
  restoreOps,
  writeModelPatch,
} from './settings-bridge.js'

const DEFAULT_PREPARE_TIMEOUT_MS = 5000

/** 请求级字段：这些值只有 prepareCall 物化之后才存在。 */
const PREPARED_FIELDS = [
  { field: 'maxTokens', read: (value) => (value.config === null ? undefined : value.config.maxTokens) },
  { field: 'reasoningEffort', read: (value) => (value.config === null ? undefined : value.config.reasoningEffort) },
  { field: 'contextWindow', read: (value) => (value.context === null ? undefined : value.context.contextWindow) },
  { field: 'inputModalities', read: (value) => value.inputModalities },
]

/** 键序无关的稳定序列化：对象（如 reasoningEfforts）比较值，数组（如 input / efforts）比较顺序。
 *  还原时被删的键会重新追加到末尾，用 JSON.stringify 直接比会误报『没还原干净』。 */
function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
  }
  return JSON.stringify(value === undefined ? null : value)
}

function sameValue(left, right) {
  return stableStringify(left) === stableStringify(right)
}

/** 元数据字段。efforts 折成档位 id 列表：好读，且不受对象键序影响。
 *
 *  ⚠️ efforts 必须在这里 —— 它是 reasoningEfforts 的唯一元数据投影。
 *  漏掉它会让『unset reasoningEfforts』这种**成功**的改动被 diff/changed 判成『什么都没发生』。
 */
const METADATA_FIELDS = [
  { field: 'contextWindow', read: (value) => value.contextWindow },
  { field: 'maxTokens', read: (value) => value.maxTokens },
  { field: 'vision', read: (value) => value.vision },
  { field: 'inputModalities', read: (value) => value.inputModalities },
  { field: 'efforts', read: (value) => readableEfforts(value.efforts) },
]

/** 把 efforts 折成 ['off','low',...]；不是数组就原样返回。 */
function readableEfforts(value) {
  if (!Array.isArray(value)) return value
  return value.map((entry) => (entry !== null && typeof entry === 'object' ? entry.id : entry))
}

function diffOf(before, after) {
  const diff = [];
  for (const entry of METADATA_FIELDS) {
    const from = before === undefined ? null : entry.read(before);
    const to = after === undefined ? null : entry.read(after);
    if (!sameValue(from, to)) diff.push({ field: entry.field, before: from, after: to });
  }
  return diff;
}

/** profile 里每个可写字段 —— 声明层必须逐个覆盖，否则 unset 类改动会沉默。 */
const CONFIGURED_FIELDS = [
  'contextWindow',
  'maxTokens',
  'input',
  'imagePixelBudget',
  'imageMaxBytes',
  'reasoningEfforts',
]

/** beforeConfigured 与 afterConfigured 之间的差异。
 *  reasoningEfforts 传 null（删除声明）在这里表现为 {field:'reasoningEfforts', before:{...}, after:null}。 */
function configuredDiffOf(before, after) {
  const left = before === null || before === undefined ? {} : before
  const right = after === null || after === undefined ? {} : after
  const diff = []
  for (const field of CONFIGURED_FIELDS) {
    const hasLeft = Object.prototype.hasOwnProperty.call(left, field)
    const hasRight = Object.prototype.hasOwnProperty.call(right, field)
    if (!hasLeft && !hasRight) continue
    const from = hasLeft ? left[field] : undefined
    const to = hasRight ? right[field] : undefined
    if (!sameValue(from, to)) {
      diff.push({ field, before: from === undefined ? null : from, after: to === undefined ? null : to })
    }
  }
  return diff
}

/** 安全克隆：prepareCall 的返回是 deepFreeze 过的；万一含不可克隆值也不能让 /selftest 变成 500。 */
function safeClone(value) {
  if (value === undefined) return null;
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  }
}

/**
 * 只投影 prepareCall 结果里可序列化的请求级字段。
 *
 * 这里**故意**不碰 prepared.stream / prepared.retryPolicy：stream() 一旦被调用就会真的发起上游请求。
 * 用白名单投影（而不是删除敏感键）保证将来 prepareCall 多返回任何函数或句柄都不会漏进响应。
 */
function projectPrepared(prepared, requested) {
  const config = safeClone(prepared.config);
  // 真实 ctx.llm.prepareCall 的返回里**没有**顶层 provider/model —— 身份在 config 里
  // （它把 {provider, model, ...controls} 一起物化）。所以优先读 config，再退回请求时用的那一对。
  const sentProvider = config !== null && typeof config.provider === 'string' && config.provider !== '' ? config.provider : requested.provider;
  const sentModel = config !== null && typeof config.model === 'string' && config.model !== '' ? config.model : requested.model;
  return {
    provider: sentProvider,
    model: sentModel,
    config,
    adapterDefaults: safeClone(prepared.adapterDefaults),
    context: safeClone(prepared.context),
    inputModalities: Array.isArray(prepared.inputModalities) ? [...prepared.inputModalities] : null,
    systemPromptUpdate: prepared.systemPromptUpdate === undefined ? null : prepared.systemPromptUpdate,
    toolUpdate: prepared.toolUpdate === undefined ? null : prepared.toolUpdate,
  };
}

/** 失败的 prepareCall 用 prepareError 表达，不抛 —— 自测的主结论是'写入是否生效'，
 *  请求层读不到不该把整次自测变成 500。 */
function preparedValue(result) {
  if (result.ok) return result.value;
  return { prepareError: { code: result.code, message: result.message } };
}

function preparedFieldsOf(value) {
  if (value === undefined || value === null || value.prepareError !== undefined) return undefined;
  return value;
}

function preparedDiff(before, after) {
  const left = preparedFieldsOf(before);
  const right = preparedFieldsOf(after);
  if (left === undefined || right === undefined) return [];
  const diff = [];
  for (const entry of PREPARED_FIELDS) {
    const from = entry.read(left);
    const to = entry.read(right);
    if (!sameValue(from, to)) diff.push({ field: entry.field, before: from === undefined ? null : from, after: to === undefined ? null : to });
  }
  return diff;
}

/**
 * 物化一次调用：ctx.llm.prepareCall({provider, model, ...controls}, signal)。
 *
 * @returns {ok:true, value:{config, adapterDefaults, context, inputModalities, ...}}
 *          或 {ok:false, code, message}（含 ABORTED / PREPARE_CALL_UNAVAILABLE）
 */
export async function materializeCall(ctx, provider, model, options) {
  const llm = llmService(ctx);
  if (llm === undefined || typeof llm.prepareCall !== 'function') {
    return { ok: false, code: 'PREPARE_CALL_UNAVAILABLE', message: 'llm.prepareCall 不可用' };
  }
  const settings = options === undefined ? {} : options;
  const signal = settings.signal;
  const controls = settings.controls === undefined ? {} : settings.controls;
  if (signal !== undefined && signal.aborted) {
    return { ok: false, code: 'ABORTED', message: 'prepareCall 在调用前已被取消' };
  }
  try {
    // prepareCall 只解析能力与默认值，不做任何网络 I/O。
    const prepared = await llm.prepareCall({ provider, model, ...controls }, signal);
    if (prepared === undefined || prepared === null) {
      return { ok: false, code: 'PREPARE_CALL_EMPTY', message: 'prepareCall 返回空结果' };
    }
    return { ok: true, value: projectPrepared(prepared, { provider, model }) };
  } catch (err) {
    if (signal !== undefined && signal.aborted) {
      return { ok: false, code: 'ABORTED', message: 'prepareCall 被取消' };
    }
    const code = err !== null && typeof err === 'object' && typeof err.code === 'string' ? err.code : 'PREPARE_CALL_FAILED';
    return { ok: false, code, message: err instanceof Error ? err.message : String(err) };
  }
}

/** 把外部 signal 与兜底超时合成一个信号；dispose() 负责清定时器与监听器。 */
function prepareBudget(external, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (external !== undefined) {
    if (external.aborted) controller.abort();
    else if (typeof external.addEventListener === 'function') external.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      if (external !== undefined && typeof external.removeEventListener === 'function') external.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * 跑一次 before → write → after（→ restore）对比。
 *
 * @param options.provider / .model / .patch {contextWindow?|maxTokens?|vision?|inputModalities?|reasoningEfforts?} / .restore
 * @param options.signal 可选 AbortSignal，只作用于 prepareCall 读取
 * @param options.timeoutMs prepareCall 兜底超时，默认 5000
 */
export async function runSelftest(ctx, options) {
  const { provider, model, patch } = options;
  const restore = options.restore !== false;
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_PREPARE_TIMEOUT_MS;
  const budget = prepareBudget(options.signal, timeoutMs);

  try {
    const before = await effectiveModel(ctx, provider, model);
    const beforeCall = await materializeCall(ctx, provider, model, { signal: budget.signal });

    if (!before.ok) {
      return {
        ok: false,
        code: 'BEFORE_UNREADABLE',
        message: before.message,
        provider,
        model,
        patch,
        beforePrepared: preparedValue(beforeCall),
      };
    }

    // 记录 profile(user 层)里的原值，用于精确还原（字段原本不存在则 unset）。
    const entry = findProviderEntry(ctx, provider);
    const descriptor = entry === undefined ? undefined : describeSettings(ctx).get(entry.settingsNs);
    let baseSlice;
    let beforeRaw = {};
    try {
      if (entry === undefined || descriptor === undefined) throw new Error('找不到设置命名空间，无法还原');
      baseSlice = resolveModelBase(descriptor, entry.settingsPath, provider, model);
      beforeRaw = rawModelFields(descriptor, baseSlice.base);
    } catch (err) {
      return {
        ok: false,
        code: err.code || 'LOCATE_FAILED',
        message: err.message,
        provider,
        model,
        patch,
        before: before.value,
        beforePrepared: preparedValue(beforeCall),
      };
    }

    let written;
    try {
      written = await writeModelPatch(ctx, provider, model, patch);
    } catch (err) {
      return {
        ok: false,
        code: err.code || 'WRITE_FAILED',
        message: err.message,
        provider,
        model,
        patch,
        before: before.value,
        beforePrepared: preparedValue(beforeCall),
      };
    }

    const after = await effectiveModel(ctx, provider, model);
    const afterCall = await materializeCall(ctx, provider, model, { signal: budget.signal });
    // 写入后声明层原值：reasoningEfforts 的 unset 这类改动在元数据之外还要靠它佐证。
    const afterRaw = declaredModelRow(ctx, provider, model);
    const diff = diffOf(before.value, after.ok ? after.value : undefined);
    const configuredDiff = configuredDiffOf(beforeRaw, afterRaw === undefined ? null : afterRaw);
    const beforePrepared = preparedValue(beforeCall);
    const afterPrepared = preparedValue(afterCall);
    const requestDiff = preparedDiff(beforePrepared, afterPrepared);

    const result = {
      ok: true,
      provider,
      model,
      patch,
      ns: written.ns,
      settingsPath: written.base,
      layer: written.layer,
      ops: written.ops,
      before: before.value,
      beforeConfigured: beforeRaw,
      after: after.ok ? after.value : null,
      afterConfigured: afterRaw === undefined ? null : afterRaw,
      diff,
      configuredDiff,
      // changed 必须同时看两层：否则只改声明层的改动（典型是 unset）会被判成『什么都没发生』。
      changed: diff.length > 0 || configuredDiff.length > 0,
      changedConfigured: configuredDiff.length > 0,
      // —— task-4：请求级证据（prepareCall 物化后的真实请求参数）——
      beforePrepared,
      afterPrepared,
      requestDiff,
      changedRequest: requestDiff.length > 0,
    };

    if (!restore) return result;

    // 还原：**不受 signal 影响** —— 一次断开连接不能留下没还原的配置。
    try {
      await mutateRaw(ctx, written.ns, restoreOps(written.base, beforeRaw), undefined);
      const restored = await effectiveModel(ctx, provider, model);
      const restoredCall = await materializeCall(ctx, provider, model, { signal: budget.signal });
      const restoredRaw = declaredModelRow(ctx, provider, model);
      result.restored = restored.ok ? restored.value : null;
      result.restoredConfigured = restoredRaw === undefined ? null : restoredRaw;
      result.restoreDiff = diffOf(result.before, restored.ok ? restored.value : undefined);
      result.restoredCleanly = result.restoreDiff.length === 0;
      result.restoreConfiguredDiff = configuredDiffOf(beforeRaw, result.restoredConfigured);
      result.restoredCleanlyConfigured = result.restoreConfiguredDiff.length === 0;
      result.restoredPrepared = preparedValue(restoredCall);
      result.restoreRequestDiff = preparedDiff(beforePrepared, result.restoredPrepared);
      result.restoredCleanlyRequest = result.restoreRequestDiff.length === 0;
    } catch (err) {
      result.restoreError = err instanceof Error ? err.message : String(err);
    }
    return result;
  } finally {
    budget.dispose();
  }
}
