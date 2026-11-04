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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

/** displayName 的长度上限：超过就该被当成误填（llm-pi-ai 本身只要求非空）。 */
export const MAX_DISPLAY_NAME_LENGTH = 120

export function normalizeDisplayName(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CapabilityError('INVALID_DISPLAY_NAME', 'displayName 必须是非空字符串')
  }
  const trimmed = value.trim()
  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new CapabilityError('INVALID_DISPLAY_NAME',
      'displayName 长度不能超过 ' + MAX_DISPLAY_NAME_LENGTH + ' 个字符，收到 ' + trimmed.length + ' 个')
  }
  return trimmed
}

/** 凭据引用名必须是一个**合法的环境变量名**（宿主按名字从进程环境/凭据服务取值）。 */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function normalizeApiKeyEnv(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CapabilityError('INVALID_API_KEY_ENV', 'apiKeyEnv 必须是非空字符串')
  }
  const trimmed = value.trim()
  if (!ENV_NAME_PATTERN.test(trimmed)) {
    throw new CapabilityError('INVALID_API_KEY_ENV',
      'apiKeyEnv 必须是合法的环境变量名（字母或下划线开头，只含字母、数字、下划线），收到 ' + JSON.stringify(value))
  }
  return trimmed
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

/** provider/edit 允许改的字段（白名单 —— 这个端点不该被当成任意配置写入器）。 */
export const EDITABLE_PROVIDER_FIELDS = ['displayName', 'api', 'baseURL', 'apiKeyEnv']

/** provider/models 的写入模式：merge（新增默认语义）或 replace（旧的覆盖语义）。 */
export const MODEL_MODES = ['merge', 'replace']

export function normalizeModelsMode(value) {
  if (value === undefined || value === null) return 'merge'
  if (typeof value !== 'string' || !MODEL_MODES.includes(value)) {
    throw new CapabilityError('INVALID_MODE',
      'mode 只允许 ' + MODEL_MODES.join(' / ') + '，收到 ' + JSON.stringify(value))
  }
  return value
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

/**
 * POST /provider/edit：改一个 provider 的可编辑字段。
 *
 * - **已声明**的 provider：走 settings-bridge 的 mutate，**行级 set**（只 set 给出的字段），
 *   绝不整棵覆盖 —— 整棵覆盖会丢掉 models 数组以及我们不认识的字段。
 * - **pending 草稿**（prefs.json 的 pendingProviders）：只改草稿对象，**不碰 settings**。
 * - 未知 id ⇒ UNKNOWN_PROVIDER；patch 里没出现的字段**不许**被改动。
 */
export async function editProvider(ctx, body) {
  const id = normalizeProviderId(body.id)
  const patch = body.patch
  if (!isRecord(patch)) {
    throw new CapabilityError('INVALID_PATCH', 'patch 必须是对象')
  }
  // 白名单：未知键（带真实值的）一律拒绝 —— 免得这个端点变成通用配置写入器。
  const extra = Object.keys(patch).filter((key) => !EDITABLE_PROVIDER_FIELDS.includes(key) && patch[key] !== undefined)
  if (extra.length > 0) {
    throw new CapabilityError('UNSUPPORTED_FIELD', 'patch 不支持字段: ' + extra.join(', '))
  }
  // 校验复用 provider.js 既有规则（api 白名单 / baseURL 必须 http(s) / displayName 非空 / apiKeyEnv 合法名）。
  const fields = {}
  if (patch.displayName !== undefined) fields.displayName = normalizeDisplayName(patch.displayName)
  if (patch.api !== undefined) fields.api = normalizeProtocol(patch.api)
  if (patch.baseURL !== undefined) fields.baseURL = normalizeBaseURL(patch.baseURL)
  if (patch.apiKeyEnv !== undefined) fields.apiKeyEnv = normalizeApiKeyEnv(patch.apiKeyEnv)

  const prefs = await readPrefs()
  const entry = providerEntries(ctx).find((row) => row.provider === id)
  const draft = isRecord(prefs.pendingProviders[id]) ? prefs.pendingProviders[id] : undefined

  // pending 草稿：只改草稿对象，**绝不碰 settings**。
  if (entry === undefined && draft !== undefined) {
    const next = { ...draft, ...fields }
    await updatePrefs((d) => { d.pendingProviders[id] = next })
    return {
      ok: true,
      provider: id,
      pending: true,
      patched: Object.keys(fields),
      declaredAfter: null,
      draft: next,
      pendingProviders: Object.keys((await readPrefs()).pendingProviders),
    }
  }

  if (entry === undefined) {
    throw new CapabilityError('UNKNOWN_PROVIDER', '未知提供商 ' + id)
  }

  // 已声明：行级 set —— 只 set 给出的字段，没给的不动。
  const descriptor = describeSettings(ctx).get(entry.settingsNs)
  if (descriptor === undefined) {
    throw new CapabilityError('NAMESPACE_UNAVAILABLE', '设置命名空间 ' + entry.settingsNs + ' 不可编辑')
  }
  const declared = getPath(descriptor.user, entry.settingsPath)
  if (!isRecord(declared)) {
    throw new CapabilityError('UNKNOWN_PROVIDER', 'provider ' + id + ' 在 profile 里没有声明层配置')
  }
  const ops = []
  for (const field of EDITABLE_PROVIDER_FIELDS) {
    if (fields[field] === undefined) continue
    ops.push({ op: 'set', path: [...entry.settingsPath, field], value: fields[field] })
  }
  if (ops.length === 0) {
    // 没给任何可改字段 ⇒ no-op（不写盘），但仍回执当前声明层。
    return {
      ok: true,
      provider: id,
      pending: false,
      patched: [],
      declaredAfter: declared,
      draft: null,
      ops: [],
    }
  }
  const written = await writeNamespaceOps(ctx, entry.settingsNs, ops)
  const afterDescriptor = describeSettings(ctx).get(entry.settingsNs)
  const declaredAfter = afterDescriptor === undefined ? null : (getPath(afterDescriptor.user, entry.settingsPath) ?? null)
  return {
    ok: true,
    provider: id,
    pending: false,
    patched: Object.keys(fields),
    declaredAfter,
    draft: null,
    ops,
    revision: written.revision,
  }
}

/**
 * POST /provider/rename：给 provider 改 id（显示 ID）。
 *
 * - settings：把 providers.<id> 的值**整棵读出**，在**同一个 mutate** 里
 *   set providers.<newId> = 该值，再 unset providers.<id>（原子，避免中间态）。
 * - prefs：order / pinned 里的旧 id 换成新 id；overrides 的键 <oldId>/<model> 换成 <newId>/<model>；
 *   pendingProviders 的键也换。
 * - defaultModelReferences：**只报告**，不替用户改那处配置（它属于别的插件）。
 */
export async function renameProvider(ctx, body) {
  const id = normalizeProviderId(body.id)
  const newId = normalizeProviderId(body.newId)
  if (newId === id) {
    throw new CapabilityError('INVALID_PROVIDER_ID', 'newId 与当前 id 相同，无需改名')
  }

  const prefs = await readPrefs()
  const entry = providerEntries(ctx).find((row) => row.provider === id)
  const draft = isRecord(prefs.pendingProviders[id]) ? prefs.pendingProviders[id] : undefined
  const isPending = entry === undefined && draft !== undefined

  // 冲突检查：已存在的 provider（目录路由或 profile 里声明的）或 pending 草稿或出厂 id 都算冲突。
  const declared = providerEntries(ctx).find((row) => row.provider === newId)
  if (declared !== undefined || Object.prototype.hasOwnProperty.call(prefs.pendingProviders, newId)) {
    throw new CapabilityError('PROVIDER_EXISTS', 'provider ' + newId + ' 已经存在')
  }

  // pending 草稿：只在 prefs 里改键名。
  if (isPending) {
    const defaultModelReferences = defaultModelReferencesOf(ctx, id)
    await updatePrefs((d) => {
      d.pendingProviders[newId] = d.pendingProviders[id]
      delete d.pendingProviders[id]
      renameInPrefs(d, id, newId)
    })
    const saved = await readPrefs()
    return {
      ok: true,
      provider: id,
      newId,
      pending: true,
      renamed: true,
      draft: saved.pendingProviders[newId],
      declaredAfter: null,
      prefs: saved,
      defaultModelReferences,
    }
  }

  if (entry === undefined) {
    throw new CapabilityError('UNKNOWN_PROVIDER', '未知提供商 ' + id)
  }

  const descriptor = describeSettings(ctx).get(entry.settingsNs)
  if (descriptor === undefined) {
    throw new CapabilityError('NAMESPACE_UNAVAILABLE', '设置命名空间 ' + entry.settingsNs + ' 不可编辑')
  }
  const value = getPath(descriptor.user, entry.settingsPath)
  if (!isRecord(value)) {
    throw new CapabilityError('UNKNOWN_PROVIDER', 'provider ' + id + ' 在 profile 里没有声明层配置')
  }
  // ★ 出厂目录路由改名会失去目录回退：新 id 不在已安装目录里，于是 pi-ai 要求 models 被逐条列出。
  //   若 profile 里本来就没有 models 数组，这次改名**必然**被 llm-pi-ai 拒绝 —— 提前拦下，
  //   绝不发一个注定失败的写入（与 MODELS_REQUIRED 同一条纪律）。
  if (entry.declared === false && !Array.isArray(value.models)) {
    throw new CapabilityError('MODELS_REQUIRED',
      'provider ' + id + ' 的模型来自出厂目录，改名后新 id 不在目录里、必须逐条列出模型；请先给它写明 models 再改名')
  }
  // 新 id 的 settings 路径：**从目录根推导**（绝不硬编码 providers 前缀）。
  const root = providerDirectoryRoot(ctx)
  if (root === undefined) {
    throw new CapabilityError('NO_PROVIDER_DIRECTORY', '目录里没有任何可配置 provider，无法写入')
  }
  const newPath = [...root.prefix, newId]

  // ★ 同一个 mutate 里完成 set + unset —— 中间态（两个 id 同时存在或都不存在）绝不落盘。
  const ops = [
    { op: 'set', path: newPath, value },
    { op: 'unset', path: [...entry.settingsPath] },
  ]
  const written = await writeNamespaceOps(ctx, entry.settingsNs, ops)

  // prefs 联动：order / pinned / overrides / pendingProviders。
  await updatePrefs((d) => { renameInPrefs(d, id, newId) })
  const saved = await readPrefs()

  const afterDescriptor = describeSettings(ctx).get(entry.settingsNs)
  const declaredAfter = afterDescriptor === undefined ? null : (getPath(afterDescriptor.user, newPath) ?? null)

  return {
    ok: true,
    provider: id,
    newId,
    pending: false,
    renamed: true,
    draft: null,
    declaredAfter,
    prefs: saved,
    ops,
    revision: written.revision,
    defaultModelReferences: defaultModelReferencesOf(ctx, id),
  }
}

/** profile patch 里『默认模型』那一项的 entry id（属于 dsh-agent-default-model 插件）。 */
export const DEFAULT_MODEL_ENTRY_ID = 'agent-default-model'

/** prefs 里的 id 联动：order / pinned 换 id，overrides 换键前缀，pendingProviders 换键。 */
function renameInPrefs(draft, oldId, newId) {
  draft.order = draft.order.map((row) => (row === oldId ? newId : row))
  draft.pinned = draft.pinned.map((row) => (row === oldId ? newId : row))
  const prefix = oldId + '/'
  const nextOverrides = {}
  for (const [key, value] of Object.entries(draft.overrides)) {
    nextOverrides[key.startsWith(prefix) ? newId + '/' + key.slice(prefix.length) : key] = value
  }
  draft.overrides = nextOverrides
  if (Object.prototype.hasOwnProperty.call(draft.pendingProviders, oldId)) {
    draft.pendingProviders[newId] = draft.pendingProviders[oldId]
    delete draft.pendingProviders[oldId]
  }
}

/**
 * 报告 profile 的 patch 里 id 为 agent-default-model 的那一项，其 config.provider
 * 是否引用了旧 id。**只报告，不改** —— 那处配置属于别的插件（dsh-agent-default-model）。
 */
export function defaultModelReferencesOf(ctx, providerId) {
  const descriptor = describeSettings(ctx).get(DEFAULT_MODEL_ENTRY_ID)
  if (descriptor !== undefined) {
    const user = descriptor.user
    if (isRecord(user)) {
      const reference = user.provider
      return typeof reference === 'string' ? reference === providerId : false
    }
  }
  for (const row of profilePatchRows(ctx)) {
    if (row.id !== DEFAULT_MODEL_ENTRY_ID) continue
    const config = row.config
    if (!isRecord(config)) return false
    return config.provider === providerId
  }
  return false
}

/** 读 profile 的 patch 行（cordis.patch.yml 的条目）。读不到就返回空数组 —— 报告信号不该因此失败。 */
function profilePatchRows(ctx) {
  try {
    const profile = ctx.get('profileContext')
    const dir = profile === undefined ? undefined : profile.dir
    if (typeof dir !== 'string' || dir === '') return []
    const patchPath = join(dir, 'cordis.patch.yml')
    const text = readFileSync(patchPath, 'utf8')
    return parseProfilePatchRows(text)
  } catch {
    return []
  }
}

/**
 * 从 cordis.patch.yml 文本里取出顶层条目（id / config.provider）。
 *
 * 只做**够用**的解析：这是纯报告信号，解析失败就返回空数组（绝不因此让改名失败）。
 * 不引入 YAML 依赖（插件是零依赖的）。
 */
export function parseProfilePatchRows(text) {
  const rows = []
  const lines = String(text).split(/\r?\n/)
  let current = null
  for (const line of lines) {
    const top = /^-\s+id:\s*(.+?)\s*$/.exec(line)
    if (top !== null) {
      if (current !== null) rows.push(current)
      current = { id: unquoteYaml(top[1]), config: {} }
      continue
    }
    if (current === null) continue
    const nested = /^\s{2,}id:\s*(.+?)\s*$/.exec(line)
    if (nested !== null) {
      current = { id: unquoteYaml(nested[1]), config: {} }
      continue
    }
    const provider = /^\s{2,}provider:\s*(.+?)\s*$/.exec(line)
    if (provider !== null) {
      current.config.provider = unquoteYaml(provider[1])
      continue
    }
  }
  if (current !== null) rows.push(current)
  return rows
}

function unquoteYaml(value) {
  const trimmed = String(value).trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export async function writeProviderModels(ctx, provider, models, providerFields, options) {
  const root = providerDirectoryRoot(ctx)
  if (root === undefined) {
    throw new CapabilityError('NO_PROVIDER_DIRECTORY', '目录里没有任何可配置 provider，无法写入')
  }
  const mode = normalizeModelsMode(options === undefined ? undefined : options.mode)
  const normalized = normalizeModels(models)
  const entry = providerEntries(ctx).find((row) => row.provider === provider)

  if (entry !== undefined) {
    if (mode === 'merge') {
      // ---- 合并语义：已有条目整条原样保留，只有新 id 才追加 ----
      // ---- 合并语义：已有条目整条原样保留，只有新 id 才追加 ----
      // 参照 DSH 设置页（dsh-client-ui-settings-models/lib/client.js:969-990）：
      //   const byId = new Map(models.map((m) => [m.id, m]))
      //   for (const c of candidates) if (picked.has(c.id)) byId.set(c.id, byId.get(c.id) ?? adopt(c))
      //   onChange([...byId.values()])
      // ⇒ 已有 id 整条原样保留（连我们不认识的字段也不丢），顺序 = 原有在前、新增在后。
      const descriptor = describeSettings(ctx).get(entry.settingsNs)
      const declared = descriptor === undefined ? undefined : getPath(descriptor.user, entry.settingsPath)
      const rawModels = isRecord(declared) && Array.isArray(declared.models) ? declared.models : []
      const existingIds = new Set()
      for (const row of rawModels) {
        if (isRecord(row) && typeof row.id === 'string' && row.id !== '') existingIds.add(row.id)
      }
      // 候选按 id 去重：**重复 id 以第一条候选为准**（与设置页 Map 语义一致）。
      const candidates = new Map()
      for (const row of normalized) {
        if (!candidates.has(row.id)) candidates.set(row.id, row)
      }

      // kept = 原本就有、按 id 去重后保留的 id；顺序 = 声明层里的原顺序。
      const kept = []
      for (const id of existingIds) kept.push(id)
      // merged = 原有条目**整条原样**（绝不 normalize / 投影 —— 那会丢我们不认识的字段）
      //        + 新 id 的候选条目追加在后。
      const merged = [...rawModels]
      const added = []
      for (const [id, candidate] of candidates) {
        if (existingIds.has(id)) continue
        added.push(id)
        merged.push(candidate)
      }

      // 空数组 = no-op：**不写盘**（绝不把渠道写空 —— llm-pi-ai 会拒绝没有模型的路由）。
      if (normalized.length === 0) {
        return {
          ok: true,
          count: kept.length,
          created: false,
          mode,
          added: [],
          kept,
          noop: true,
          ns: entry.settingsNs,
          settingsPath: entry.settingsPath,
          ops: [],
          revision: undefined,
        }
      }
      const path = [...entry.settingsPath, 'models']
      const ops = [{ op: 'set', path, value: merged }]
      const written = await writeNamespaceOps(ctx, entry.settingsNs, ops)
      return {
        ok: true,
        count: merged.length,
        created: false,
        mode,
        added,
        kept,
        noop: false,
        ns: entry.settingsNs,
        settingsPath: entry.settingsPath,
        ops,
        revision: written.revision,
      }
    }
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
      mode,
      added: [],
      kept: normalized.map((row) => row.id),
      noop: false,
      ns: entry.settingsNs,
      settingsPath: entry.settingsPath,
      ops,
      revision: written.revision,
    }
  }

  if (normalized.length === 0) {
    if (mode === 'merge') {
      // merge + 空数组 = no-op：provider 还没声明 ⇒ 什么都不写，也不报错。
      // （绝不能因此创建一个没有模型的渠道 —— llm-pi-ai 会拒绝那种写入。）
      return {
        ok: true,
        count: 0,
        created: false,
        mode,
        added: [],
        kept: [],
        noop: true,
        ns: root.ns,
        settingsPath: [...root.prefix, provider],
        ops: [],
        revision: undefined,
      }
    }
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
    mode,
    added: normalized.map((row) => row.id),
    kept: [],
    noop: false,
    ns: root.ns,
    settingsPath: path,
    ops,
    revision: written.revision,
  }
}
