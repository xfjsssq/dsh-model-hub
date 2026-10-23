// dsh-model-hub — settings 写入桥（宿主侧核心）。
//
// 复用 DSH 设置页『模型』所用的同一条路径：
//   ctx.settings.describe({redactSecrets:true})  →  {ns, revision, value, user, base}
//   ctx.settings.mutate(ns, ops, revision)       →  configEditor.edit()
//        → 原子写 profile 的 cordis.patch.yml + reconcileProfilePatches(root, patches, 'dsh', [ns])
// llm-pi-ai 的 Config 把 providers 整棵声明为 .volatile()，且监听
// 'loader/volatile-update' 重建注册表 —— 所以改完立即生效，无需重启。

import { getPath, isRecord } from './util.js'

/** 面向前端的失败码；客户端据此给出可读文案而不是未知错误。 */
export class CapabilityError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CapabilityError'
    this.code = code
  }
}

export function settingsService(ctx) {
  try {
    return ctx.get('settings')
  } catch {
    return undefined
  }
}

export function llmService(ctx) {
  try {
    return ctx.get('llm')
  } catch {
    return undefined
  }
}

// describe() 的读缓存。TTL 只服务读路径：它每调用一次都会刷新 revision 并广播
// 'settings/document-updated'，而 model-selection 的会话目录在监听该事件 ——
// 打开一次弹窗不该引发一串无谓重拉。
//
// 写路径必须 ttlMs=0（默认）：revision 是 mutate 的 CAS 前置条件，用缓存值会误报冲突。
const describeCache = new WeakMap()

/** 写成功后主动作废缓存，避免'刚写完又读到旧目录'的窗口。 */
export function invalidateDescribeCache(ctx) {
  describeCache.delete(ctx)
}

/**
 * 一次 describe() 换一张 ns→descriptor 表。
 *
 * @param ctx 宿主上下文
 * @param options.ttlMs 复用窗口；0（默认）表示每次都问 settings，写路径必须用 0
 */
export function describeSettings(ctx, options) {
  const ttlMs = options !== undefined && typeof options.ttlMs === 'number' ? options.ttlMs : 0
  if (ttlMs > 0) {
    const cached = describeCache.get(ctx)
    if (cached !== undefined && Date.now() - cached.at < ttlMs) return cached.map
  }
  const map = new Map()
  const settings = settingsService(ctx)
  if (settings === undefined || typeof settings.describe !== 'function') return map
  let rows
  try {
    rows = settings.describe({ redactSecrets: true })
  } catch {
    return map
  }
  if (Array.isArray(rows)) {
    for (const row of rows) if (isRecord(row) && typeof row.ns === 'string') map.set(row.ns, row)
  }
  if (ttlMs > 0) describeCache.set(ctx, { at: Date.now(), map })
  return map
}

/** 目录项由 llm-pi-ai 注册：{provider, displayName, settingsNs, settingsPath, declared, error?}。
 *  这是 ns 与 settingsPath 的唯一权威来源 —— 绝不硬编码 llm-pi-ai。 */
export function providerEntries(ctx) {
  const llm = llmService(ctx)
  if (llm === undefined || typeof llm.listConfigurableProviders !== 'function') return []
  let list
  try {
    list = llm.listConfigurableProviders()
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  return list.filter((entry) => isRecord(entry)
    && typeof entry.provider === 'string' && entry.provider !== ''
    && typeof entry.settingsNs === 'string' && entry.settingsNs !== ''
    && Array.isArray(entry.settingsPath))
}

export function findProviderEntry(ctx, provider) {
  for (const entry of providerEntries(ctx)) if (entry.provider === provider) return entry
  return undefined
}

/** 解析出 live 配置（value 层）里的 provider 对象。 */
export function providerConfigOf(entry, descriptors) {
  const descriptor = descriptors.get(entry.settingsNs)
  if (descriptor === undefined) return undefined
  const value = getPath(descriptor.value, entry.settingsPath)
  return isRecord(value) ? value : undefined
}

/** 算出目标模型在 profile 里可寻址的位置。
 *
 *  为什么必须区分 user 层：applyPathOp 在数组上按索引写；如果 profile 层根本没有 models
 *  （模型来自继承层），索引写会生成 {0: {...}} 这样的坏结构。所以只认 profile 自己声明的
 *  models 数组；否则退到 modelOverrides（pi-ai 只对 catalog 路由此字段才合法）。
 */
export function resolveModelBase(descriptor, settingsPath, provider, model) {
  const user = descriptor === undefined ? undefined : getPath(descriptor.user, settingsPath)
  const userModels = isRecord(user) && Array.isArray(user.models) ? user.models : undefined
  if (userModels !== undefined && userModels.length > 0) {
    const index = userModels.findIndex((entry) => isRecord(entry) && entry.id === model)
    if (index < 0) {
      throw new CapabilityError('UNKNOWN_MODEL',
        '提供商 ' + provider + ' 在 profile 里声明了 models 列表，但其中没有 ' + model)
    }
    return { base: [...settingsPath, 'models', String(index)], layer: 'models', index }
  }
  const live = descriptor === undefined ? undefined : getPath(descriptor.value, settingsPath)
  const liveModels = isRecord(live) && Array.isArray(live.models) ? live.models : []
  if (liveModels.length > 0) {
    throw new CapabilityError('INHERITED_MODELS',
      '提供商 ' + provider + ' 的 models 列表来自继承层，本插件无法按索引安全改写')
  }
  return { base: [...settingsPath, 'modelOverrides', model], layer: 'modelOverrides' }
}

/** 读 profile(user 层)里声明的模型行原值。
 *
 *  catalog 用它给出 declaredInputModalities / declaredReasoningEfforts（客户端读初值）；
 *  apply 用它验证『unset 之后该字段确实没了』。
 *  继承层（profile 没有声明这个模型）返回 undefined —— 与契约 v1.2 一致。
 */
export function declaredModelRow(ctx, provider, model) {
  const entry = findProviderEntry(ctx, provider)
  if (entry === undefined) return undefined
  const descriptor = describeSettings(ctx).get(entry.settingsNs)
  if (descriptor === undefined) return undefined
  return declaredModelRowOf(descriptor, entry.settingsPath, model)
}

/** 同上，但直接吃已经在手上的 descriptor（catalog 一次 describe 要服务多个模型，避免重复 describe）。 */
export function declaredModelRowOf(descriptor, settingsPath, model) {
  const user = descriptor === undefined ? undefined : getPath(descriptor.user, settingsPath)
  if (!isRecord(user)) return undefined
  const models = Array.isArray(user.models) ? user.models : []
  const found = models.find((row) => isRecord(row) && row.id === model)
  if (found !== undefined) return found
  const overrides = isRecord(user.modelOverrides) ? user.modelOverrides : {}
  return isRecord(overrides[model]) ? overrides[model] : undefined
}

/** pi-ai 接受的输入模态，也是设置页复选框的顺序。 */
export const MODALITIES = ['text', 'image']

/** 设置页在取消 image 时一并删除这两个字段（见 dsh-client-ui-settings-models ModelInputTypes）。
 *  它们不是 llm-pi-ai 模型 schema 的字段，所以 unset 通常是无害的 no-op；
 *  但只要 profile 里存在，就必须和设置页一样被清掉。 */
export const IMAGE_BUDGET_FIELDS = ['imagePixelBudget', 'imageMaxBytes']

/** 校验输入模态并归一化：只允许 text/image、去重、固定 text→image 顺序、不能为空。
 *  归一化规则与设置页 ['text','image'].filter(...) 完全一致。 */
export function normalizeInputModalities(value) {
  if (!Array.isArray(value)) {
    throw new CapabilityError('INVALID_INPUT_MODALITIES', 'inputModalities 必须是字符串数组，收到 ' + JSON.stringify(value))
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !MODALITIES.includes(entry)) {
      throw new CapabilityError('INVALID_INPUT_MODALITIES',
        'inputModalities 只允许 ' + MODALITIES.join('/') + '，收到 ' + JSON.stringify(entry))
    }
  }
  const canonical = MODALITIES.filter((modality) => value.includes(modality))
  if (canonical.length === 0) {
    throw new CapabilityError('INVALID_INPUT_MODALITIES', 'inputModalities 不能为空：模型至少要接受一种输入')
  }
  return canonical
}

/** 校验推理档位：键非空；值必须是非空字符串，或**仅当键为 off** 时的 null；至少一个非 off 档。
 *  null（整个字段）表示 unset —— 那是 JSON 里表达『删掉这个字段』的方式，与写 YAML null 不同
 *  （llm-pi-ai 明确拒绝 reasoningEfforts: null）。
 *
 *  **已知限制（契约 v1.2 有意不覆盖）**：pi-ai 的 `reasoningEfforts: false`（表示『该模型不推理』）
 *  不受支持，会返回 INVALID_REASONING_EFFORTS。这与设置页一致 —— 设置页的 readEfforts() 同样把
 *  `false` 当成『没有这个字段』（返回 undefined，不显示编辑器），它的开关关闭就是删除字段。
 *  要表达『该模型不推理』，请传 null 删除该字段。
 */
export function normalizeReasoningEfforts(value) {
  if (value === null) return null
  if (value === false) {
    throw new CapabilityError('INVALID_REASONING_EFFORTS',
      'reasoningEfforts: false 不受支持（pi-ai 用它表示该模型不推理）；要表达这个语义请传 null 删除该字段')
  }
  if (!isRecord(value)) {
    throw new CapabilityError('INVALID_REASONING_EFFORTS',
      'reasoningEfforts 必须是对象或 null，收到 ' + JSON.stringify(value))
  }
  const entries = Object.entries(value)
  if (entries.length === 0) {
    throw new CapabilityError('INVALID_REASONING_EFFORTS', 'reasoningEfforts 不能是空对象：至少要有一个非 off 档')
  }
  for (const [level, wire] of entries) {
    if (level === '') {
      throw new CapabilityError('INVALID_REASONING_EFFORTS', 'reasoningEfforts 的档位名不能为空')
    }
    if (typeof wire === 'string') {
      if (wire.length === 0) {
        throw new CapabilityError('INVALID_REASONING_EFFORTS', 'reasoningEfforts.' + level + ' 的 wire 值不能是空字符串')
      }
      continue
    }
    if (wire === null && level === 'off') continue
    throw new CapabilityError('INVALID_REASONING_EFFORTS',
      'reasoningEfforts.' + level + ' 必须是非空字符串'
      + (level === 'off' ? '，或 null（off 表示不发该字段）' : '；只有 off 允许 null'))
  }
  if (!entries.some(([level]) => level !== 'off')) {
    throw new CapabilityError('INVALID_REASONING_EFFORTS', 'reasoningEfforts 至少要有一个非 off 档')
  }
  return Object.fromEntries(entries)
}

/** 校验并生成 settings 路径操作；不写盘、不碰 ctx，便于单测与 selftest 复用。 */
export function buildOps(provider, base, patch) {
  const ops = []
  if (patch.contextWindow !== undefined) {
    const value = patch.contextWindow
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new CapabilityError('INVALID_CONTEXT_WINDOW', 'contextWindow 必须是正整数，收到 ' + JSON.stringify(value))
    }
    ops.push({ op: 'set', path: [...base, 'contextWindow'], value })
  }
  if (patch.maxTokens !== undefined) {
    const value = patch.maxTokens
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new CapabilityError('INVALID_MAX_TOKENS', 'maxTokens 必须是正整数，收到 ' + JSON.stringify(value))
    }
    ops.push({ op: 'set', path: [...base, 'maxTokens'], value })
  }

  // 输入模态：inputModalities（v1.2）优先，vision（v1.1 布尔简写）作为向后兼容的退化。
  // 两者同时给时 inputModalities 胜出 —— 同一字段不能有两个互相矛盾的来源。
  let modalities
  if (patch.inputModalities !== undefined) {
    modalities = normalizeInputModalities(patch.inputModalities)
  } else if (patch.vision !== undefined) {
    if (typeof patch.vision !== 'boolean') {
      throw new CapabilityError('INVALID_VISION', 'vision 必须是布尔值，收到 ' + JSON.stringify(patch.vision))
    }
    modalities = patch.vision ? ['text', 'image'] : ['text']
  }
  if (modalities !== undefined) {
    // 注意：不能用 [] 表示无输入 —— llm-pi-ai 的 declaredInput() 把空数组当成未声明，
    // 会继续继承上层。normalizeInputModalities 已保证非空。
    ops.push({ op: 'set', path: [...base, 'input'], value: modalities })
    if (!modalities.includes('image')) {
      // 与设置页一致：取消 image 时同时删除图片预算字段。
      for (const field of IMAGE_BUDGET_FIELDS) ops.push({ op: 'unset', path: [...base, field] })
    }
  }

  if (patch.reasoningEfforts !== undefined) {
    const efforts = normalizeReasoningEfforts(patch.reasoningEfforts)
    ops.push(efforts === null
      ? { op: 'unset', path: [...base, 'reasoningEfforts'] }
      : { op: 'set', path: [...base, 'reasoningEfforts'], value: efforts })
  }
  return ops
}

/** 只接受契约 v1.2 里的字段；多一个键就拒绝，避免被当成任意配置写入器。 */
export function pickPatch(raw) {
  if (!isRecord(raw)) throw new CapabilityError('INVALID_PATCH', 'patch 必须是对象')
  const allowed = ['contextWindow', 'maxTokens', 'vision', 'inputModalities', 'reasoningEfforts']
  // 值为 undefined 的键视为不存在（JSON 也表达不出 undefined），但任何带真实值的未知键都拒绝 ——
  // 这保证这个端点不会被当成通用配置写入器。
  const extra = Object.keys(raw).filter((key) => !allowed.includes(key) && raw[key] !== undefined)
  if (extra.length > 0) {
    throw new CapabilityError('UNSUPPORTED_FIELD', 'patch 不支持字段: ' + extra.join(', '))
  }
  const patch = {}
  for (const field of allowed) if (raw[field] !== undefined) patch[field] = raw[field]
  return patch
}

function isConflict(err) {
  if (!isRecord(err) && typeof err !== 'object') return false
  if (err === null) return false
  return err.name === 'SettingsConflictError' || err.code === 'SETTINGS_CONFLICT'
}

/** 真正的写盘动作：定位 ns/path → buildOps → settings.mutate（冲突重试一次）。
 *  ops 为空表示无需写盘，直接返回当前 revision。
 */
export async function writeModelPatch(ctx, provider, model, patch) {
  const settings = settingsService(ctx)
  if (settings === undefined || typeof settings.mutate !== 'function') {
    throw new CapabilityError('SETTINGS_UNAVAILABLE', 'settings 服务不可用，无法写入模型能力')
  }
  const entry = findProviderEntry(ctx, provider)
  if (entry === undefined) {
    throw new CapabilityError('UNKNOWN_PROVIDER', '未知提供商 ' + provider)
  }
  let descriptors = describeSettings(ctx)
  let descriptor = descriptors.get(entry.settingsNs)
  if (descriptor === undefined) {
    throw new CapabilityError('NAMESPACE_UNAVAILABLE',
      '设置命名空间 ' + entry.settingsNs + ' 不可编辑（可能没有 volatile 字段）')
  }
  const { base, layer } = resolveModelBase(descriptor, entry.settingsPath, provider, model)
  const ops = buildOps(provider, base, patch)
  if (ops.length === 0) return { ns: entry.settingsNs, ops, base, layer, written: false }

  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      descriptors = describeSettings(ctx)
      descriptor = descriptors.get(entry.settingsNs) || descriptor
    }
    try {
      await settings.mutate(entry.settingsNs, ops, descriptor.revision)
      invalidateDescribeCache(ctx)
      return { ns: entry.settingsNs, ops, base, layer, written: true, revision: descriptor.revision }
    } catch (err) {
      lastError = err
      if (!isConflict(err) || attempt === 1) break
    }
  }
  throw lastError
}

/** 写入前该模型在 profile(user 层)里的原值，供 selftest 还原与诊断。 */
export function rawModelFields(descriptor, base) {
  const raw = descriptor === undefined ? undefined : getPath(descriptor.user, base)
  return isRecord(raw) ? { ...raw } : {}
}

/** 所有可写字段：buildOps 能改的，restore 就必须能改回来。
 *  缺一个都会让 selftest 在还原后留下痕迹（尤其是被 unset 的 image 预算字段与 reasoningEfforts）。 */
export const WRITABLE_MODEL_FIELDS = [
  'contextWindow',
  'maxTokens',
  'input',
  'imagePixelBudget',
  'imageMaxBytes',
  'reasoningEfforts',
]

/** 生成把每个可写字段还原到 before 状态的 ops（字段原本不存在就 unset）。 */
export function restoreOps(base, before) {
  const ops = []
  for (const field of WRITABLE_MODEL_FIELDS) {
    if (isRecord(before) && Object.prototype.hasOwnProperty.call(before, field)) {
      ops.push({ op: 'set', path: [...base, field], value: before[field] })
    } else {
      ops.push({ op: 'unset', path: [...base, field] })
    }
  }
  return ops
}

export async function mutateRaw(ctx, ns, ops, revision) {
  const settings = settingsService(ctx)
  if (settings === undefined || typeof settings.mutate !== 'function') {
    throw new CapabilityError('SETTINGS_UNAVAILABLE', 'settings 服务不可用')
  }
  return settings.mutate(ns, ops, revision)
}
