// dsh-model-hub — 运行时目录构建。
//
// 关键不变量：模型元数据一律以 ctx.llm 的运行时结果为准（resolveModelInfo），
// profile 的 YAML 只在运行时拿不到时作为兜底 —— 这样'改完是否真生效'才是可验证的。

import { declaredModelRowOf, describeSettings, llmService, providerConfigOf, providerEntries } from './settings-bridge.js'
import { isRecord } from './util.js'

/** 名单里没有的字段统一补 null，客户端不必处理 undefined。 */
function orNull(value) {
  return value === undefined ? null : value
}

/** 把 llm.resolveModelInfo() 的返回压成本插件契约里的形状。 */
function projectModelInfo(info) {
  const efforts = [];
  const raw = info.reasoning && Array.isArray(info.reasoning.efforts) ? info.reasoning.efforts : [];
  for (const effort of raw) {
    if (!isRecord(effort) || typeof effort.id !== 'string') continue;
    const name = typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id;
    // name 是 v1.1 契约字段；label 是 §5 旧字段，一并给出，客户端用哪个都行。
    efforts.push({ id: effort.id, name, label: name });
  }
  const modalities = Array.isArray(info.inputModalities) ? [...info.inputModalities] : undefined;
  return {
    name: typeof info.name === 'string' ? info.name : undefined,
    contextWindow: orNull(info.context ? info.context.contextWindow : undefined),
    maxTokens: orNull(info.defaultMaxTokens),
    vision: modalities === undefined ? null : modalities.includes('image'),
    inputModalities: orNull(modalities),
    efforts,
    defaultEffort: orNull(info.reasoning ? info.reasoning.defaultEffort : undefined),
  }
}

/** 单个模型的运行时求解结果；失败返回 { error } 而不是抛，目录不能因为一个坏模型整片消失。 */
export async function effectiveModel(ctx, provider, model) {
  const llm = llmService(ctx)
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') {
    return { ok: false, code: 'LLM_UNAVAILABLE', message: 'llm 服务不可用' }
  }
  try {
    const info = await llm.resolveModelInfo(provider, model)
    const projected = projectModelInfo(info)
    return { ok: true, value: {
      contextWindow: projected.contextWindow,
      maxTokens: projected.maxTokens,
      vision: projected.vision,
      inputModalities: projected.inputModalities,
      efforts: projected.efforts,
      defaultEffort: projected.defaultEffort,
      name: projected.name,
    } }
  } catch (err) {
    return {
      ok: false,
      code: (err && err.code) || 'RESOLVE_FAILED',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/** pi-ai 在缺凭证时 listModels() 返回 []，所以'非空'就是可用的正信号。 */
async function listRuntimeModels(ctx, provider) {
  const llm = llmService(ctx)
  if (llm === undefined || typeof llm.listModels !== 'function') return { models: [], reachable: false }
  try {
    const list = await llm.listModels(provider)
    return { models: Array.isArray(list) ? list.filter(isRecord) : [], reachable: true }
  } catch {
    return { models: [], reachable: false }
  }
}

/** 显式查凭证（有 apiKeyEnv 时）；查不到就返回 undefined，交由 listModels 结论兜底。 */
async function credentialPresent(ctx, ref) {
  if (typeof ref !== 'string' || ref === '') return undefined
  let credentials;
  try {
    credentials = ctx.get('credentials')
  } catch {
    return undefined
  }
  if (credentials === undefined || typeof credentials.resolve !== 'function') return undefined
  try {
    const hit = await credentials.resolve(ref)
    const value = isRecord(hit) ? hit.value : hit
    return typeof value === 'string' && value.length > 0
  } catch {
    return false
  }
}

/** 默认排序：置顶 → 用户 order → 其余；其余里 DeepSeek 官方族提到最前（design-spec §4）。 */
export function applyOrder(ids, prefs) {
  const known = new Set(ids)
  const out = [];
  const push = (id) => {
    if (!known.has(id) || out.includes(id)) return;
    out.push(id);
  };
  for (const id of prefs.pinned) push(id);
  for (const id of prefs.order) push(id);
  const rest = ids.filter((id) => !out.includes(id));
  const preferred = (id) => (id === 'deepseek' || id.startsWith('deepseek-') ? 0 : 1);
  rest.sort((a, b) => preferred(a) - preferred(b));
  for (const id of rest) push(id);
  return out;
}

/** 组装 GET /model-hub/api/catalog 的响应体。 */
export async function buildCatalog(ctx, prefs) {
  // 读路径：300ms TTL。目录内容对 300ms 的陈旧不敏感（生效值来自 resolveModelInfo，
  // 不是 descriptor），但能挡住'打开弹窗 → profile 事件 → 目录重拉'的风暴。
  const descriptors = describeSettings(ctx, { ttlMs: 300 })
  const entries = providerEntries(ctx)
  const providers = [];

  for (const entry of entries) {
    const cfg = providerConfigOf(entry, descriptors) || {}
    const runtime = await listRuntimeModels(ctx, entry.provider)
    const runtimeIds = new Set(runtime.models.map((m) => m.id).filter((id) => typeof id === 'string'))
    const declaredList = Array.isArray(cfg.models) ? cfg.models.filter(isRecord) : []
    const declaredIds = declaredList.map((m) => m.id).filter((id) => typeof id === 'string' && id !== '')
    const overrideIds = isRecord(cfg.modelOverrides) ? Object.keys(cfg.modelOverrides) : []

    const ids = [];
    for (const id of [...declaredIds, ...overrideIds, ...runtimeIds]) if (!ids.includes(id)) ids.push(id);

    const models = [];
    for (const id of ids) {
      const resolved = await effectiveModel(ctx, entry.provider, id)
      const declared = declaredList.find((m) => m.id === id)
      const fromRuntime = runtime.models.find((m) => m.id === id)
      const fallbackInput = isRecord(declared) && Array.isArray(declared.input) ? declared.input : undefined
      // 声明层（profile 的 user 层）原值：客户端用它读编辑初值。
      // 继承层没有声明过这个模型 → undefined，客户端据此区分『已声明』与『继承』。
      const userRow = declaredModelRowOf(descriptors.get(entry.settingsNs), entry.settingsPath, id)
      const declaredInput = isRecord(userRow) && Array.isArray(userRow.input) && userRow.input.length > 0
        ? [...userRow.input]
        : undefined
      const declaredEfforts = isRecord(userRow) && isRecord(userRow.reasoningEfforts)
        ? { ...userRow.reasoningEfforts }
        : undefined
      models.push({
        id,
        // 该模型是否真的在**该 provider 的 profile 声明层**里（models[] 某项，或 modelOverrides 的键）。
        // 客户端只在这为 true 的行上给删除按钮：出厂目录/运行时带出来的模型删不掉。
        declared: isRecord(userRow),
        name: (resolved.ok && resolved.value.name) || (declared && declared.name) || (fromRuntime && fromRuntime.name) || id,
        contextWindow: resolved.ok && resolved.value.contextWindow !== null
          ? resolved.value.contextWindow
          : orNull((declared && declared.contextWindow) !== undefined ? declared.contextWindow : cfg.defaultContextWindow),
        maxTokens: resolved.ok && resolved.value.maxTokens !== null
          ? resolved.value.maxTokens
          : orNull((declared && declared.maxTokens) !== undefined ? declared.maxTokens : cfg.defaultMaxTokens),
        vision: resolved.ok && resolved.value.vision !== null
          ? resolved.value.vision
          : (fallbackInput === undefined ? false : fallbackInput.includes('image')),
        efforts: resolved.ok ? resolved.value.efforts : [],
        defaultEffort: resolved.ok ? resolved.value.defaultEffort : null,
        ...(declaredInput === undefined ? {} : { declaredInputModalities: declaredInput }),
        ...(declaredEfforts === undefined ? {} : { declaredReasoningEfforts: declaredEfforts }),
        upstreamSupported: runtimeIds.has(id),
        resolved: resolved.ok,
        ...(resolved.ok ? {} : { resolveError: { code: resolved.code, message: resolved.message } }),
      });
    }

    const credentialFlag = await credentialPresent(ctx, cfg.apiKeyEnv)
    providers.push({
      id: entry.provider,
      name: (typeof entry.displayName === 'string' && entry.displayName !== '' ? entry.displayName : undefined)
        || cfg.displayName || entry.provider,
      api: orNull(cfg.api),
      baseURL: orNull(cfg.baseURL),
      hasKey: runtime.models.length > 0 || credentialFlag === true,
      declared: entry.declared !== false,
      settingsNs: entry.settingsNs,
      ...(typeof entry.error === 'string' && entry.error !== '' ? { error: entry.error } : {}),
      models,
    });
  }

  // 待建 provider（方案 A）：llm-pi-ai 拒绝无模型路由，所以它们只存在于本插件的 prefs 里。
  // 这里并进目录，用户保存后就能立刻在面板里看到它（models 为空 + pending:true），
  // 客户端据此显示『待选模型』的淡提示，而不是当成一个普通的空 provider。
  const pendingProviders = isRecord(prefs.pendingProviders) ? prefs.pendingProviders : {}
  const known = new Set(providers.map((provider) => provider.id))
  const root = (() => {
    for (const entry of entries) {
      const at = entry.settingsPath.lastIndexOf('providers')
      if (at >= 0) return { ns: entry.settingsNs, prefix: entry.settingsPath.slice(0, at + 1) }
    }
    return undefined
  })()
  for (const [id, draft] of Object.entries(pendingProviders)) {
    if (known.has(id)) continue
    const credentialFlag = await credentialPresent(ctx, draft.apiKeyEnv)
    providers.push({
      id,
      name: typeof draft.displayName === 'string' && draft.displayName !== '' ? draft.displayName : id,
      api: typeof draft.api === 'string' ? draft.api : null,
      baseURL: typeof draft.baseURL === 'string' ? draft.baseURL : null,
      hasKey: credentialFlag === true,
      declared: true,
      pending: true,
      settingsNs: root === undefined ? null : root.ns,
      models: [],
    })
    known.add(id)
  }

  // 空目录 = 运行时注册表读不到提供商。这时必须明确失败，让客户端退回只读展示，
  // 而不是渲染一个空白的模型中心（那会变成'看着能用其实没有内容'）。
  if (providers.length === 0) {
    return {
      ok: false,
      code: 'NO_PROVIDER_DIRECTORY',
      message: 'ctx.llm.listConfigurableProviders() 没有返回任何提供商；模型中心无法工作',
      providers: [],
      order: [],
    }
  }

  const order = applyOrder(providers.map((provider) => provider.id), prefs)
  return { ok: true, providers, order, pinned: [...prefs.pinned] }
}
