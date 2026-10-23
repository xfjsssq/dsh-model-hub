// dsh-model-hub — 偏好持久化（~/.dsh/model-hub/prefs.json）。
// 与 profile 无关：这个文件完全属于本插件，删掉即回到默认顺序，不影响 DSH 配置。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isRecord } from './util.js'

/** DSH home：优先环境变量，其次 ~/.dsh（与 dsh-mobile-plus 的 dshHome() 约定一致）。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * 本插件自己的数据目录。
 *
 * `DSH_MODEL_HUB_HOME` 直接指定这个目录 —— 测试与多实例都靠它隔离，
 * 从而既不需要写真实的 ~/.dsh，也不需要模拟 homedir。
 */
export function modelHubDir() {
  const override = process.env.DSH_MODEL_HUB_HOME
  if (typeof override === 'string' && override.trim() !== '') return override
  return join(dshHome(), 'model-hub')
}

export function prefsPath() {
  return join(modelHubDir(), 'prefs.json')
}

/** 偏好形状。`pendingProviders` 是**只属于本插件**的待建提供商草稿：
 *  llm-pi-ai 拒绝无模型的路由（源码 :678），所以『保存但先不取模型』只能存在这里，
 *  等用户勾选模型时再一次性落盘成真实 providers.<id>。 */
export function emptyPrefs() {
  return { order: [], pinned: [], overrides: {}, pendingProviders: {} }
}

/** 把磁盘上任意内容收敛成契约形状；坏文件不抛，退化成空偏好。 */
function normalizePrefs(raw) {
  const out = emptyPrefs()
  if (!isRecord(raw)) return out
  if (Array.isArray(raw.order)) {
    for (const id of raw.order) if (typeof id === 'string' && id !== '' && !out.order.includes(id)) out.order.push(id)
  }
  if (Array.isArray(raw.pinned)) {
    for (const id of raw.pinned) if (typeof id === 'string' && id !== '' && !out.pinned.includes(id)) out.pinned.push(id)
  }
  if (isRecord(raw.overrides)) {
    for (const [key, value] of Object.entries(raw.overrides)) if (isRecord(value)) out.overrides[key] = { ...value }
  }
  if (isRecord(raw.pendingProviders)) {
    for (const [id, value] of Object.entries(raw.pendingProviders)) {
      if (typeof id !== 'string' || id === '' || !isRecord(value)) continue
      out.pendingProviders[id] = { ...value }
    }
  }
  return out
}

export async function readPrefs() {
  try {
    return normalizePrefs(JSON.parse(await readFile(prefsPath(), 'utf8')))
  } catch {
    return emptyPrefs()
  }
}

// 串行化写入：并发 POST 不会产生半个文件，也不会互相覆盖。
let writeQueue = Promise.resolve()

async function writeAtomic(prefs) {
  const path = prefsPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp-' + process.pid + '-' + Date.now().toString(36)
  await writeFile(tmp, JSON.stringify(prefs, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, path)
  return prefs
}

export function savePrefs(prefs) {
  const normalized = normalizePrefs(prefs)
  const run = writeQueue.then(() => writeAtomic(normalized))
  writeQueue = run.then(() => undefined, () => undefined)
  return run
}

/** 读—改—写；mutate 收到的 draft 可以安全地就地改。 */
export async function updatePrefs(mutate) {
  const current = await readPrefs()
  const draft = {
    order: [...current.order],
    pinned: [...current.pinned],
    overrides: { ...current.overrides },
    pendingProviders: { ...current.pendingProviders },
  }
  await mutate(draft)
  return savePrefs(draft)
}

/** 记录一条能力覆盖（键为 provider/model），供 UI 标记为已自定义。 */
export function recordOverride(draft, provider, model, patch) {
  const key = provider + '/' + model
  const merged = isRecord(draft.overrides[key]) ? { ...draft.overrides[key] } : {}
  for (const field of ['contextWindow', 'maxTokens', 'vision', 'inputModalities', 'reasoningEfforts']) {
    if (patch[field] !== undefined) merged[field] = patch[field]
  }
  draft.overrides[key] = merged
}
