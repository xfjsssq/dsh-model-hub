// dsh-model-hub — 客户端诊断状态（**只存内存，不写盘**）。
//
// 为什么存在（issue #1）：前端永不出现、且**没有任何可见错误**。用户不打开 DevTools 时
// 无法区分三种状态：bundle 没加载 / 加载了但 apply 没跑 / 槽位注册失败。
// 所以客户端把关键阶段 POST 上来，宿主保存**最近一次**，由 GET /health 暴露出来。
//
// ⚠️ 刻意只存内存：
//   1) 诊断信息不该污染 prefs.json（那是用户配置，写坏要人工修）；
//   2) 重启/插件重载后清空是**正确**的 —— 我们要看的就是『这一次运行』的状态。
//
// 状态是**按插件实例**的（工厂函数），所以重载天然复位，测试之间也天然隔离。

import { readFileSync } from 'node:fs'

/** 契约白名单。其余阶段**原样保存**但标 unknown:true —— 这样客户端可以先上线、宿主后跟进。 */
export const CLIENT_STAGES = [
  'bundle-loaded',
  'apply-start',
  'apply-ok',
  'waiting-services',
  'slot-registered',
  'slot-register-failed',
  'build-failed',
  'apply-failed',
]

const MAX_ERROR_CHARS = 4000
const MAX_USER_AGENT_CHARS = 400
const MAX_MISSING = 32

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function capped(value, limit) {
  return value !== undefined && value.length > limit ? value.slice(0, limit) + '…（已截断）' : value
}

function serviceList(value) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') continue
    if (out.includes(entry)) continue
    out.push(entry)
    if (out.length >= MAX_MISSING) break
  }
  return out
}

/**
 * 建一个客户端状态仓。**极度宽容**：诊断口最糟的失败模式是『让用户更困惑』，
 * 所以空体 / 坏 JSON / 未知阶段 / 非字符串字段一律照收，绝不报错。
 */
export function createClientStateStore() {
  let last = null
  // 版本是**粘性**的：后到的不带版本的上报（例如 apply-failed）不会把它抹掉，
  // 否则用户一报错，/health 就再也看不到『浏览器里到底跑的哪一版』。
  let clientVersion = null

  const record = (body, now = Date.now()) => {
    const raw = isPlainRecord(body) ? body : {}
    const stageText = text(raw.stage)
    const entry = { stage: stageText === undefined ? 'unknown' : stageText }
    if (stageText === undefined || !CLIENT_STAGES.includes(stageText)) entry.unknown = true

    const error = capped(text(raw.error), MAX_ERROR_CHARS)
    if (error !== undefined) entry.error = error
    const missing = serviceList(raw.missing)
    if (missing !== undefined) entry.missing = missing
    const at = text(raw.at)
    if (at !== undefined) entry.at = at
    const userAgent = capped(text(raw.userAgent), MAX_USER_AGENT_CHARS)
    if (userAgent !== undefined) entry.userAgent = userAgent

    // 版本字段名以 clientVersion 为准；build 作为别名一起收（客户端常量名尚未冻结）。
    const version = text(raw.clientVersion) ?? text(raw.build)
    if (version !== undefined) clientVersion = version
    if (clientVersion !== null) entry.clientVersion = clientVersion

    // 宿主接收时间：clientStateAgeMs 以它为准（客户端时钟不可信）。
    entry.receivedAt = now
    last = entry
    return entry
  };

  const read = (now = Date.now()) => {
    if (last === null) return { clientState: null, clientStateAgeMs: null, clientVersion: null }
    return {
      clientState: { ...last },
      clientStateAgeMs: Math.max(0, now - last.receivedAt),
      clientVersion,
    }
  };

  const reset = () => {
    last = null
    clientVersion = null
  };

  return { record, read, reset };
}

/** 宿主插件版本（读包内 package.json）。读不到返回 null —— 诊断口不该因此炸掉。 */
let cachedPluginVersion
export function pluginVersion() {
  if (cachedPluginVersion !== undefined) return cachedPluginVersion
  try {
    const parsed = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    cachedPluginVersion = typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : null
  } catch {
    cachedPluginVersion = null
  }
  return cachedPluginVersion;
}
