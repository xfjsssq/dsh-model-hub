// dsh-model-hub — 宿主侧共享工具。
// 只做纯函数与最小 HTTP 辅助，保持零依赖（只用 node 内置模块）。

export const PREFIX = '/model-hub'
export const API_PREFIX = PREFIX + '/api'
export const MAX_BODY_BYTES = 1024 * 1024

/** 写一个 JSON 响应；始终带 no-store，避免代理/浏览器缓存把能力改动缓存住。 */
export function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** 读取并解析 JSON 请求体；空体算 {},数组/标量一律拒绝。 */
export async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  if (!isRecord(parsed)) throw new Error('request body must be a JSON object')
  return parsed
}

/** 按路径取值；任何一段不是对象就返回 undefined（不抛）。 */
export function getPath(root, path) {
  let node = root
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[key]
  }
  return node
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只保留非空字符串，用于校验 order/pinned 之类的字符串数组。 */
export function stringArray(value) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') return undefined
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

export function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

/** 宿主侧控件出错时的统一失败体；code 供客户端做精确分支。 */
export function fail(res, status, code, message) {
  json(res, status, { ok: false, code, message })
}
