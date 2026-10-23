// dsh-model-hub — provider 模板 / 模型发现 / 模型列表写入（契约 v1.3）。
//
// ⚠️ 一条源码级硬约束决定了本模块的形状（task-8 阻塞项的根因，已报 lead）：
//   llm-pi-ai **拒绝『没有任何模型的已声明路由』**：
//     dsh-llm-pi-ai/lib/index.js:656-678
//       const configured = request.models ?? []
//       const entries = configured.length > 0 ? configured : [...catalogModels(provider).values()]...
//       :678  if (entries.length === 0) invalid(provider, 'resolves no models; ...')
//     invalid() 抛 PiAiCatalogError（:552）；它经 assertServiceable()（:1092，validation 默认 strict）
//     挂在 internal/config waterfall（:2885）上，而 configEditor.edit() 在**写盘前**就会跑这个 waterfall。
//     catalogModels()（:387）对手写 id 永远返回空 Map。
//   ⇒ 『先创建一个空 provider、稍后再加模型』在 settings 路径上**不可能**：写入会被拒绝。
//   ⇒ provider 与它的 models 必须**一次性写入**（见 writeProviderModels）；
//      `models: []` 只对**出厂目录里已有**的路由合法（那种情况下会回落到目录模型）。

import { effectiveModel } from './catalog.js'
import { readPrefs, updatePrefs } from './prefs.js'
import { CapabilityError, describeSettings, invalidateDescribeCache, llmService, providerEntries, settingsService } from './settings-bridge.js'
import { getPath, isRecord } from './util.js'

/** pi-ai 接受的 wire 协议，顺序 = 展示顺序 = 源码 PROTOCOLS 的键序。
 *  dsh-llm-pi-ai/lib/index.js:834 `const PROTOCOLS = { 'openai-completions', 'openai-responses', 'anthropic-messages' }`
 *  首个是默认值（源码注释：最常被手写网关使用、也是端点探测能读的那个）。 */
export const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

/** 设置页的 provider id 规则：dsh-client-ui-settings-models/lib/client.js:1544。 */
export const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** 设置页由 id 派生凭据引用名：client.js:1230 `deriveKeyRef`。 */
export function deriveKeyRef(provider) {
  return provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'
}

/** 设置页的 baseURL 校验：client.js:1545 `isHttpUrl`（必须能被 URL 解析且是 http/https）。 */
export function isHttpUrl(value) {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function normalizeProviderId(value) {
  if (typeof value !== 'string' || value === '') {
    throw new CapabilityError('INVALID_PROVIDER_ID', 'provider id 必须是非空字符串')
  }
  if (!ROUTE_PATTERN.test(value)) {
    throw new CapabilityError('INVALID_PROVIDER_ID',
      'provider id 必须匹配 ' + String(ROUTE_PATTERN) + '（小写字母开头，可含数字与单个连字符段），收到 ' + JSON.stringify(value))
  }
  return value
}

export function normalizeProtocol(value) {
  if (value === undefined) return PROTOCOLS[0]
  if (typeof value !== 'string' || !PROTOCOLS.includes(value)) {
    throw new CapabilityError('INVALID_PROTOCOL',
      'api 只允许 ' + PROTOCOLS.join(' / ') + '，收到 ' + JSON.stringify(value))
  }
  return value
}

export function normalizeDisplayName(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CapabilityError('INVALID_DISPLAY_NAME', 'displayName 必须是非空字符串')
  }
  return value.trim()
}

/** 凭据引用名：设置页由 id 派生（deriveKeyRef），这里只要求非空字符串。 */
export function normalizeApiKeyEnv(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CapabilityError('INVALID_API_KEY_ENV', 'apiKeyEnv 必须是非空字符串')
  }
  return value.trim()
}

export function normalizeBaseURL(value) {
  if (typeof value !== 'string' || value === '') {
    throw new CapabilityError('INVALID_BASE_URL', 'baseURL 必须是非空字符串')
  }
  const trimmed = value.trim()
  if (!isHttpUrl(trimmed)) {
    throw new CapabilityError('INVALID_BASE_URL', 'baseURL 必须是 http(s) URL，收到 ' + JSON.stringify(value))
  }
  return trimmed
}

/**
 * 校验并规范化一个模型列表（覆盖写用的那份）。
 *
 * 规则与 llm-pi-ai 的 modelProfile 字段对齐：id 非空且不重复；
 * contextWindow / maxTokens 为正整数；input 只允许 text/image、去重、非空；name 字符串。
 */
export function normalizeModels(value) {
  if (!Array.isArray(value)) {
    throw new CapabilityError('INVALID_MODELS', 'models 必须是数组')
  }
  const seen = new Set()
  const out = []
  for (const entry of value) {
    if (!isRecord(entry)) throw new CapabilityError('INVALID_MODELS', 'models 的每一项必须是对象')
    const id = entry.id
    if (typeof id !== 'string' || id === '') {
      throw new CapabilityError('INVALID_MODELS', 'models[].id 必须是非空字符串')
    }
    if (seen.has(id)) throw new CapabilityError('DUPLICATE_MODEL', 'models 里重复出现 ' + JSON.stringify(id))
    seen.add(id)
    const model = { id }
    if (entry.name !== undefined) {
      if (typeof entry.name !== 'string' || entry.name === '') {
        throw new CapabilityError('INVALID_MODELS', 'models[' + id + '].name 必须是非空字符串')
      }
      model.name = entry.name
    }
    for (const field of ['contextWindow', 'maxTokens']) {
      if (entry[field] === undefined) continue
      const number = entry[field]
      if (!Number.isSafeInteger(number) || number <= 0) {
        throw new CapabilityError('INVALID_MODELS', 'models[' + id + '].' + field + ' 必须是正整数')
      }
      model[field] = number
    }
    if (entry.input !== undefined) {
      if (!Array.isArray(entry.input)) {
        throw new CapabilityError('INVALID_MODELS', 'models[' + id + '].input 必须是数组')
      }
      for (const modality of entry.input) {
        if (modality !== 'text' && modality !== 'image') {
          throw new CapabilityError('INVALID_MODELS', 'models[' + id + '].input 只允许 text/image')
        }
      }
      const canonical = ['text', 'image'].filter((modality) => entry.input.includes(modality))
      if (canonical.length === 0) {
        throw new CapabilityError('INVALID_MODELS', 'models[' + id + '].input 不能为空（空数组会被 pi-ai 当成未声明）')
      }
      model.input = canonical
    }
    out.push(model)
  }
  return out
}

/**
 * 从运行时目录发现 llm-pi-ai 的命名空间与 providers 路径前缀 —— 绝不硬编码。
 * 目录形状：{provider, displayName, settingsNs, settingsPath: ['providers', <id>]}。
 * @returns {ns, prefix} 或 undefined（目录为空）
 */
export function providerDirectoryRoot(ctx) {
  for (const entry of providerEntries(ctx)) {
    const at = entry.settingsPath.lastIndexOf('providers')
    if (at >= 0) return { ns: entry.settingsNs, prefix: entry.settingsPath.slice(0, at + 1) }
  }
  return undefined
}

/** GET /provider-templates：拿 ctx.llm.listConfigurableProviders() 里能当模板的条目。
 *  defaultBaseURL / baseURLEnv / nativeAuth 都经 detachDirectoryEntry 保留（dsh-llm/lib/index.js:2416），
 *  所以客户端可以直接拿它填表单默认值。 */
export function listProviderTemplates(ctx) {
  const templates = []
  for (const entry of providerEntries(ctx)) {
    templates.push({
      provider: entry.provider,
      displayName: entry.displayName,
      settingsNs: entry.settingsNs,
      settingsPath: [...entry.settingsPath],
      declared: entry.declared !== false,
      ...(entry.defaultBaseURL === undefined ? {} : { defaultBaseURL: entry.defaultBaseURL }),
      ...(entry.baseURLEnv === undefined ? {} : { baseURLEnv: [...entry.baseURLEnv] }),
      ...(entry.nativeAuth === undefined ? {} : { nativeAuth: { ...entry.nativeAuth } }),
      ...(typeof entry.error === 'string' && entry.error !== '' ? { error: entry.error } : {}),
    })
  }
  return { ok: true, protocols: [...PROTOCOLS], protocolDefault: PROTOCOLS[0], templates }
}

/** 凭据引用 → 明文 key。优先 credentials 服务（设置页就是这么存的），其次进程环境变量。
 *  pending provider 没有已存 profile，所以发现阶段必须由我们把 key 递进去。 */
export async function resolveApiKey(ctx, ref) {
  if (typeof ref !== 'string' || ref === '') return undefined
  try {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve(ref)
      const value = isRecord(hit) ? hit.value : hit
      if (typeof value === 'string' && value.length > 0) return value
    }
  } catch {
    /* 凭据服务缺失或拒绝：退回环境变量 */
  }
  const fromEnv = process.env[ref]
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined
}

/**
 * POST /provider/discover：问端点有哪些模型。
 *
 * 直接转发给 ctx.llm.discoverModels(settingsNs, request, signal)（dsh-llm/lib/index.js:1998）。
 * 它的报错码会原样带出来：NO_DISCOVERY / INVALID_DISCOVERY / DISCOVERY_FAILED /
 * DISCOVERY_UNSUPPORTED / ABORTED（都来自 llm-pi-ai 的 discoverModels）。
 *
 * apiKeyEnv 是**可选追加字段**：provider 尚未落盘时目录里没有它的 profile，
 * 宿主拿不到 key 就会 401，所以由调用方给引用名、我们解析后作为 request.apiKey 传入
 * （pi-ai 明确支持 request.apiKey，见 dsh-llm-pi-ai/lib/index.js:2401）。
 */
export async function discoverProviderModels(ctx, request, options) {
  const llm = llmService(ctx)
  if (llm === undefined || typeof llm.discoverModels !== 'function') {
    throw new CapabilityError('DISCOVERY_UNAVAILABLE', 'llm.discoverModels 不可用')
  }
  const provider = typeof request.provider === 'string' && request.provider !== '' ? request.provider : undefined
  const rawBaseURL = typeof request.baseURL === 'string' && request.baseURL !== '' ? request.baseURL : undefined
  if (provider === undefined && rawBaseURL === undefined) {
    throw new CapabilityError('INVALID_DISCOVERY', 'discover 至少需要 provider 或 baseURL')
  }
  const root = providerDirectoryRoot(ctx)
  if (root === undefined) {
    throw new CapabilityError('NO_PROVIDER_DIRECTORY', '目录里没有任何可配置 provider，无法注册发现请求')
  }
  const discovery = {}
  if (provider !== undefined) discovery.provider = provider
  if (rawBaseURL !== undefined) discovery.baseURL = normalizeBaseURL(rawBaseURL)
  if (request.api !== undefined) discovery.api = normalizeProtocol(request.api)
  const apiKey = await resolveApiKey(ctx, request.apiKeyEnv)
  if (apiKey !== undefined) discovery.apiKey = apiKey

  const signal = options === undefined ? undefined : options.signal
  try {
    const models = await llm.discoverModels(root.ns, discovery, signal)
    return { ok: true, ns: root.ns, models: Array.isArray(models) ? models.map((model) => ({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] }),
    })) : [] }
  } catch (err) {
    return {
      ok: false,
      code: err !== null && typeof err === 'object' && typeof err.code === 'string' ? err.code : 'DISCOVERY_FAILED',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/** 带 revision 冲突重试的 settings 写入（与 settings-bridge 的 writeModelPatch 同一套语义：
 *  写路径 ttl=0 取新鲜 revision，冲突重试一次）。写成功后作废读缓存。 */
async function writeNamespaceOps(ctx, ns, ops) {
  const settings = settingsService(ctx)
  if (settings === undefined || typeof settings.mutate !== 'function') {
    throw new CapabilityError('SETTINGS_UNAVAILABLE', 'settings 服务不可用，无法写入提供商配置')
  }
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const descriptor = describeSettings(ctx).get(ns)
    if (descriptor === undefined) {
      throw new CapabilityError('NAMESPACE_UNAVAILABLE', '设置命名空间 ' + ns + ' 不可编辑')
    }
    try {
      await settings.mutate(ns, ops, descriptor.revision)
      // 读缓存必须作废：catalog 走 300ms TTL，否则刚删完模型又会在目录里看到它（假失败）。
      invalidateDescribeCache(ctx)
      return { revision: descriptor.revision }
    } catch (err) {
      lastError = err
      const conflict = err !== null && typeof err === 'object'
        && (err.name === 'SettingsConflictError' || err.code === 'SETTINGS_CONFLICT')
      if (!conflict || attempt === 1) break
    }
  }
  throw lastError
}

/**
 * POST /provider：保存/删除一个**待建** provider 草稿。
 *
 * 为什么是草稿而不是直接写 profile：llm-pi-ai 拒绝无模型路由（见文件头），所以
 * 『保存但先不取模型』只能先存在本插件的 prefs 里；等用户勾选模型时，
 * writeProviderModels 用 {...草稿, models} **一次性原子落盘**。
 *
 * body：{ id, displayName?, api?, baseURL?, apiKeyEnv? } 或 { id, remove: true }。
 *  - remove 只允许删 pending；对已落盘的真实 provider 拒绝（PROVIDER_NOT_PENDING），绝不碰真实配置。
 */
export async function writeProviderDraft(ctx, body) {
  const id = normalizeProviderId(body.id)
  const root = providerDirectoryRoot(ctx)
  const entry = providerEntries(ctx).find((row) => row.provider === id)
  const prefs = await readPrefs()
  const isPending = isRecord(prefs.pendingProviders[id])

  if (body.remove === true) {
    if (entry !== undefined) {
      throw new CapabilityError('PROVIDER_NOT_PENDING',
        'provider ' + id + ' 已经是真实配置，本端点只删待建草稿；删除真实 provider 请走设置页')
    }
    if (!isPending) {
      throw new CapabilityError('PROVIDER_NOT_PENDING', 'provider ' + id + ' 不是待建草稿，没有可删除的内容')
    }
    const saved = await updatePrefs((draft) => { delete draft.pendingProviders[id] })
    return { ok: true, removed: true, pending: false, provider: id, declaredAfter: null, pendingProviders: Object.keys(saved.pendingProviders) }
  }

  if (entry !== undefined) {
    throw new CapabilityError('PROVIDER_EXISTS', 'provider ' + id + ' 已经存在（真实配置或目录路由）')
  }
  const fields = {
    ...(body.displayName === undefined ? {} : { displayName: normalizeDisplayName(body.displayName) }),
    api: normalizeProtocol(body.api),
    baseURL: normalizeBaseURL(body.baseURL),
    ...(body.apiKeyEnv === undefined ? {} : { apiKeyEnv: normalizeApiKeyEnv(body.apiKeyEnv) }),
  }
  const saved = await updatePrefs((draft) => { draft.pendingProviders[id] = fields })
  return {
    ok: true,
    pending: true,
    created: !isPending,
    provider: id,
    fields,
    // 还没有真实配置可回执 —— 客户端应把 declaredAfter 当成『尚未落盘』。
    declaredAfter: null,
    appliedVia: {
      ns: root === undefined ? null : root.ns,
      settingsPath: root === undefined ? null : [...root.prefix, id],
      pending: true,
    },
    pendingProviders: Object.keys(saved.pendingProviders),
  }
}

/**
 * POST /provider/models：**覆盖写**某个 provider 的 models（= 用户勾选启用的那些）。
 *
 * 两种情形：
 *  - provider **已声明**：只覆盖 providers.<id>.models；
 *  - provider **尚未声明**：必须把 provider 字段与 models 一起写（见文件头的硬约束），
 *    因此调用方要通过 providerFields 给出 api / baseURL / displayName / apiKeyEnv。
 *
 * 空数组：对**出厂目录里已有**的路由合法（会回落到目录模型）；对自定义 id 会被 pi-ai 拒绝，
 * 这里提前拦下并给 MODELS_REQUIRED，避免把一个必然失败的写入发出去。
 */
/** 声明层里仍然声明的模型 id（models[] 顺序在前，modelOverrides 键随后，去重）。 */
export function declaredModelIds(providerConfig) {
  if (!isRecord(providerConfig)) return []
  const ids = []
  const rows = Array.isArray(providerConfig.models) ? providerConfig.models : []
  for (const row of rows) {
    if (isRecord(row) && typeof row.id === 'string' && row.id !== '' && !ids.includes(row.id)) ids.push(row.id)
  }
  if (isRecord(providerConfig.modelOverrides)) {
    for (const key of Object.keys(providerConfig.modelOverrides)) if (!ids.includes(key)) ids.push(key)
  }
  return ids
}

/**
 * POST /provider/model-remove：把某个模型从 provider 的**声明层**里去掉。
 *
 * ★ 关键实现约束：删 models[] 里的项时必须『读**原始**数组 → 删一项 → 原样写回』。
 *   绝不能把数组解析成我们认识的模型形状再写回 —— 那会静默丢掉用户手写的、
 *   我们不认识的键（image 预算、自定义 compat 等），属于不可逆的数据破坏。
 *   所以这里只 filter 原始数组，不经过 normalizeModels。
 *
 * 分支：models[] 命中 → 写回删项后的数组；modelOverrides 命中 → unset 该键。
 * 两边都没有 → MODEL_NOT_DECLARED（明确拒绝，绝不静默）。
 * 删空且该路由不是出厂目录路由 → MODELS_REQUIRED，且**不写盘**（llm-pi-ai 硬约束）。
 */
export async function removeDeclaredModel(ctx, provider, model) {
  if (typeof model !== 'string' || model === '') {
    throw new CapabilityError('INVALID_REQUEST', 'model 必须是非空字符串')
  }
  const root = providerDirectoryRoot(ctx)
  if (root === undefined) {
    throw new CapabilityError('NO_PROVIDER_DIRECTORY', '目录里没有任何可配置 provider，无法写入')
  }
  const entry = providerEntries(ctx).find((row) => row.provider === provider)
  if (entry === undefined) throw new CapabilityError('UNKNOWN_PROVIDER', '未知提供商 ' + provider)
  const descriptor = describeSettings(ctx).get(entry.settingsNs)
  if (descriptor === undefined) {
    throw new CapabilityError('NAMESPACE_UNAVAILABLE', '设置命名空间 ' + entry.settingsNs + ' 不可编辑')
  }

  const providerConfig = getPath(descriptor.user, entry.settingsPath)
  if (!isRecord(providerConfig)) {
    throw new CapabilityError('MODEL_NOT_DECLARED', 'provider ' + provider + ' 在 profile 里没有声明层配置')
  }
  const rawModels = Array.isArray(providerConfig.models) ? providerConfig.models : []
  const index = rawModels.findIndex((row) => isRecord(row) && row.id === model)
  const overrides = isRecord(providerConfig.modelOverrides) ? providerConfig.modelOverrides : {}
  const inOverrides = Object.prototype.hasOwnProperty.call(overrides, model)
  if (index < 0 && !inOverrides) {
    throw new CapabilityError('MODEL_NOT_DECLARED', 'provider ' + provider + ' 的声明层里没有模型 ' + model)
  }

  let ops
  let branch
  if (index >= 0) {
    branch = 'models'
    // 原样保留其余项 —— 只按位置摘掉一项，其余对象**原封不动**。
    const remaining = rawModels.filter((row, at) => at !== index)
    const catalogBacked = entry.declared === false
    if (remaining.length === 0 && !catalogBacked) {
      throw new CapabilityError('MODELS_REQUIRED',
        'llm-pi-ai 拒绝没有模型的自定义路由：删掉最后一个模型会让写入被拒，本次未写盘')
    }
    ops = [{ op: 'set', path: [...entry.settingsPath, 'models'], value: remaining }]
  } else {
    branch = 'modelOverrides'
    ops = [{ op: 'unset', path: [...entry.settingsPath, 'modelOverrides', model] }]
  }

  const written = await writeNamespaceOps(ctx, entry.settingsNs, ops)

  // 写后回读校验：声明层里必须已经没有它了。
  const afterDescriptor = describeSettings(ctx).get(entry.settingsNs)
  const declaredAfter = afterDescriptor === undefined ? undefined : getPath(afterDescriptor.user, entry.settingsPath)
  const remainingIds = declaredModelIds(declaredAfter)
  if (remainingIds.includes(model)) {
    throw new CapabilityError('NOT_REMOVED', '已写盘但声明层里仍然能看到模型 ' + model)
  }
  // 参考信号：出厂目录路由删掉「声明」后，模型仍会由目录提供（所以那种行本来就不该有删除按钮）。
  const resolvableAfter = (await effectiveModel(ctx, provider, model)).ok

  return {
    ok: true,
    removed: model,
    branch,
    remaining: remainingIds,
    declaredAfter: declaredAfter === undefined ? null : declaredAfter,
    resolvableAfter,
    ns: entry.settingsNs,
    settingsPath: entry.settingsPath,
    ops,
    revision: written.revision,
  }
}

export async function writeProviderModels(ctx, provider, models, providerFields) {
  const root = providerDirectoryRoot(ctx)
  if (root === undefined) {
    throw new CapabilityError('NO_PROVIDER_DIRECTORY', '目录里没有任何可配置 provider，无法写入')
  }
  const normalized = normalizeModels(models)
  const entry = providerEntries(ctx).find((row) => row.provider === provider)

  if (entry !== undefined) {
    const catalogBacked = entry.declared === false
    if (normalized.length === 0 && !catalogBacked) {
      throw new CapabilityError('MODELS_REQUIRED',
        'llm-pi-ai 拒绝没有模型的自定义路由：清空 models 会让写入被拒。请保留至少一个模型。')
    }
    const path = [...entry.settingsPath, 'models']
    const ops = [normalized.length === 0 ? { op: 'unset', path } : { op: 'set', path, value: normalized }]
    const written = await writeNamespaceOps(ctx, entry.settingsNs, ops)
    return {
      ok: true,
      count: normalized.length,
      created: false,
      ns: entry.settingsNs,
      settingsPath: entry.settingsPath,
      ops,
      revision: written.revision,
    }
  }

  if (normalized.length === 0) {
    throw new CapabilityError('MODELS_REQUIRED',
      'provider ' + provider + ' 还不存在，而 llm-pi-ai 拒绝没有模型的路由；请至少勾选一个模型一起写入')
  }
  // 方案 A：provider 字段优先取请求，其次取待建草稿（客户端只需传 {provider, models}）。
  const prefs = await readPrefs()
  const draft = isRecord(prefs.pendingProviders[provider]) ? prefs.pendingProviders[provider] : undefined
  const fields = isRecord(providerFields) ? providerFields : draft
  if (!isRecord(fields)) {
    throw new CapabilityError('PROVIDER_FIELDS_REQUIRED',
      'provider ' + provider + ' 尚未声明且没有待建草稿，写入 models 时必须同时给出 api / baseURL 等字段')
  }
  const profile = {
    ...(fields.displayName === undefined ? {} : { displayName: normalizeDisplayName(fields.displayName) }),
    ...(fields.apiKeyEnv === undefined ? {} : { apiKeyEnv: normalizeApiKeyEnv(fields.apiKeyEnv) }),
    api: normalizeProtocol(fields.api),
    baseURL: normalizeBaseURL(fields.baseURL),
    models: normalized,
  }
  const path = [...root.prefix, provider]
  const ops = [{ op: 'set', path, value: profile }]
  const written = await writeNamespaceOps(ctx, root.ns, ops)
  // 落盘成功 → 清掉待建草稿；清理失败不该让写入看起来失败（草稿残留只是下次会重复写同样的值）。
  let clearedPending = false
  if (draft !== undefined) {
    try {
      await updatePrefs((d) => { delete d.pendingProviders[provider] })
      clearedPending = true
    } catch {
      clearedPending = false
    }
  }
  return {
    clearedPending,
    ok: true,
    count: normalized.length,
    created: true,
    ns: root.ns,
    settingsPath: path,
    ops,
    revision: written.revision,
  }
}
