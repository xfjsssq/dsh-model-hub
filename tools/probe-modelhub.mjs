#!/usr/bin/env node
// tools/probe-modelhub.mjs -- 对 dsh-model-hub 宿主路由取证。
//
//   node tools/probe-modelhub.mjs                       # 默认：只读探测（health/catalog/prefs）
//   node tools/probe-modelhub.mjs --mode selftest        # health + selftest 四字段 + restore
//   node tools/probe-modelhub.mjs --mode write           # 只读 + POST /model + prefs 往返
//   node tools/probe-modelhub.mjs --mode all             # 全跑
//
// 选项：
//   --base <url>        默认 http://127.0.0.1:57826
//   --cookie <cookie>   需要浏览器会话时的 Cookie 头（也可用环境变量 DSH_COOKIE）
//   --provider <id> --model <id>   默认取 catalog 里第一个 provider 的第一个 model
//   --verbose           连 catalog 全文一起打印
//   --out <dir>         报告目录，默认 <工作区>/_recon/verify
//
// 行为约定（Lead 要求）：
//   * 每一次调用都同时打印 **HTTP 状态码 + 响应体**。
//   * 默认先只做只读探测；写操作必须显式 --mode write/selftest/all。
//   * selftest 会临时改 profile\cordis.patch.yml 再写回：本脚本在整轮前后各算一次
//     sha256，并在结尾断言 profile patch 文件是否**逐字节复原**。
//   * 如果 selftest 响应里**没有** prepareCall 物化后的 config，脚本会大声报出来
//     （Lead 要求：直接上报，不许自己绕过）。
//
// 不产生任何上游费用：只打本机 127.0.0.1 的宿主路由。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE = path.resolve(HERE, '..')

// ------------------------------------------------------------------ args -----
const argv = process.argv.slice(2)
const opt = { mode: 'readonly', base: 'http://127.0.0.1:57826', verbose: false }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--verbose') { opt.verbose = true; continue }
  if (a.startsWith('--')) {
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) { opt[k] = true; continue }
    opt[k] = v; i++
  }
}
const base = String(opt.base).replace(/\/+$/, '')
const cookie = opt.cookie || process.env.DSH_COOKIE || ''
const outDir = opt.out ? path.resolve(opt.out) : path.join(WORKSPACE, '_recon', 'verify')
const profileDir = opt.profile ? path.resolve(opt.profile) : path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop')
const PATCH_FILE = path.join(profileDir, 'cordis.patch.yml')

const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
const report = { stamp, base, mode: opt.mode, cookieUsed: cookie.length > 0, calls: [], checks: [], notes: [] }
const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: String(detail) })
  const tag = pass ? '[ok]' : '[x] '
  console.log(tag + ' ' + name + '  -- ' + detail)
}
function sha(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null }
}

// ---------------------------------------------------------------- http -------
async function call(method, p, body, how) {
  const url = base + p
  const init = { method, headers: {} }
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body) }
  if (cookie) init.headers['cookie'] = cookie
  let status = null, text = '', ctype = '', err = null, json = null
  try {
    const res = await fetch(url, init)
    status = res.status
    ctype = res.headers.get('content-type') || ''
    text = await res.text()
    try { json = JSON.parse(text) } catch { json = null }
  } catch (e) {
    err = String(e && e.message ? e.message : e)
  }
  const rec = { method, path: p, requestBody: body === undefined ? null : body, status, contentType: ctype, error: err, body: text }
  report.calls.push(rec)
  const label = method + ' ' + p
  console.log('')
  console.log('--- ' + label + ' ---')
  if (err) { console.log('  (no HTTP response) ' + err) }
  else { console.log('  HTTP ' + status + '   content-type: ' + (ctype || '(none)')) }
  const showFull = how === 'summary' ? false : true
  if (showFull) {
    console.log('  body: ' + (text.length > 4000 ? text.slice(0, 4000) + ' ...(truncated, full body saved in report)' : text))
  } else {
    console.log('  body: ' + (text.length > 300 ? text.slice(0, 300) + ' ...(truncated; --verbose 可打印全文)' : text))
  }
  return { status, text, json, ctype, err, rec }
}

function findModel(catalog, provider, model) {
  const provs = (catalog && catalog.providers) || []
  for (const p of provs) {
    if (provider && p.id !== provider) continue
    for (const m of (p.models || [])) {
      if (model && m.id !== model) continue
      return { provider: p.id, model: m.id, info: m, providerRec: p }
    }
  }
  return null
}
function visionOf(m) {
  if (typeof m.vision === 'boolean') return m.vision
  if (Array.isArray(m.input)) return m.input.includes('image')
  if (Array.isArray(m.inputModalities)) return m.inputModalities.includes('image')
  return false
}
function pickDifferent(cur, candidates) {
  for (const c of candidates) if (c !== cur) return c
  return candidates[0]
}

// ---------------------------------------------------- prepareCall 检查 -------
function findPrepareCallish(obj, trail = '', depth = 0, hits = []) {
  if (!obj || typeof obj !== 'object' || depth > 6) return hits
  for (const [k, v] of Object.entries(obj)) {
    if (/preparecall|prepared|callconfig|requestconfig|materiali[sz]ed|wireparams|requestdiff|changedrequest/i.test(k)) hits.push(trail + '.' + k)
    if (v && typeof v === 'object') findPrepareCallish(v, trail + '.' + k, depth + 1, hits)
  }
  return hits
}

// ------------------------------------------------------------------ main -----
console.log('=== dsh-model-hub 取证探测 ===')
console.log('base    : ' + base)
console.log('mode    : ' + opt.mode)
console.log('cookie  : ' + (cookie ? '已提供 (' + cookie.length + ' 字符)' : '未提供（若遇 401 见文末提示）'))
console.log('profile : ' + profileDir)

const patchShaBefore = sha(PATCH_FILE)
console.log('cordis.patch.yml sha256(before) = ' + (patchShaBefore || '(读不到)'))

// ---- 1) health ----
console.log('')
console.log('=== 1) /model-hub/api/health ===')
const h = await call('GET', '/model-hub/api/health')
check('health 路由可达 (HTTP 200)', h.status === 200, 'status=' + h.status)
if (h.json) {
  check('health.ok 为 true', h.json.ok === true, 'ok=' + h.json.ok)
  check('health.hasSettings 为 true（否则不能写）', h.json.hasSettings === true, 'hasSettings=' + h.json.hasSettings)
  report.health = h.json
} else if (h.status === 401) {
  report.notes.push('health 返回 401：需要浏览器会话 Cookie')
}
if (h.status === 404) check('路由不存在 -> 说明插件还没被宿主加载（需要装 + 激活/重启）', false, 'HTTP 404')

const mode = String(opt.mode)
const doRead = true
const doWrite = mode === 'write' || mode === 'all'
const doSelftest = mode === 'selftest' || mode === 'all'

// ---- 2) catalog ----
let catalog = null
if (doRead) {
  console.log('')
  console.log('=== 2) /model-hub/api/catalog ===')
  const c = await call('GET', '/model-hub/api/catalog', undefined, opt.verbose ? 'full' : 'summary')
  catalog = c.json
  check('catalog 路由可达 (HTTP 200)', c.status === 200, 'status=' + c.status)
  if (catalog) {
    const providers = catalog.providers || []
    const models = providers.reduce((n, p) => n + ((p.models || []).length), 0)
    check('catalog 有 providers', providers.length > 0, 'providers=' + providers.length + ' models=' + models)
    const meta = findModel(catalog)
    check('catalog 带元数据(contextWindow/maxTokens/vision)', !!meta && (meta.info.contextWindow !== undefined || meta.info.maxTokens !== undefined || meta.info.vision !== undefined), meta ? JSON.stringify({ contextWindow: meta.info.contextWindow, maxTokens: meta.info.maxTokens, vision: meta.info.vision, efforts: meta.info.efforts }) : 'no model')
    report.catalogSummary = { providers: providers.length, models, order: catalog.order || null }
  }

  console.log('')
  console.log('=== 3) /model-hub/api/prefs ===')
  const pr = await call('GET', '/model-hub/api/prefs')
  check('prefs 路由可达 (HTTP 200)', pr.status === 200, 'status=' + pr.status)
  if (pr.json) report.prefs = pr.json
}

// ---- 选定 provider/model ----
let provider = opt.provider
let model = opt.model
let info = null
if (catalog) {
  const found = (provider && model) ? findModel(catalog, provider, model) : findModel(catalog, provider, model)
  if (found) { provider = found.provider; model = found.model; info = found.info }
}
if (!provider || !model) { provider = provider || 'alpha'; model = model || 'm-flash-1017' }
console.log('')
console.log('目标模型: ' + provider + ' / ' + model + (info ? '' : '   (catalog 里没找到，仍尝试)'))
report.target = { provider, model, info: info || null }

// ---- 4) POST /model 写路径 ----
if (doWrite) {
  console.log('')
  console.log('=== 4) POST /model-hub/api/model（真实写路径 + 还原） ===')
  const cur = info ? Number(info.contextWindow) || 0 : 0
  const targetCw = pickDifferent(cur, [131072, 262144, 1000000])
  const w = await call('POST', '/model-hub/api/model', { provider, model, patch: { contextWindow: targetCw } })
  check('POST /model 返回 HTTP 200', w.status === 200, 'status=' + w.status)
  if (w.json) {
    check('POST /model ok:true', w.json.ok === true, 'ok=' + w.json.ok)
    check('POST /model 回传 effective.contextWindow == 请求值', !!(w.json.effective && Number(w.json.effective.contextWindow) === targetCw), JSON.stringify(w.json.effective || null))
    check('POST /model verify.contextWindow:true', !!(w.json.verify && w.json.verify.contextWindow === true), JSON.stringify(w.json.verify || null))
    check('POST /model 带 prepared 物化结果', !!w.json.prepared, w.json.prepared ? 'config=' + JSON.stringify(w.json.prepared.config || null) + ' inputModalities=' + JSON.stringify(w.json.prepared.inputModalities || null) + ' adapterDefaults=' + JSON.stringify(w.json.prepared.adapterDefaults || null) : '缺少 prepared（可能还在跑旧代码）')
    if (w.json.prepared && w.json.effective && w.json.prepared.context) {
      check('POST /model prepared.context 与 effective 两层一致 (contextWindow)', Number(w.json.prepared.context.contextWindow) === Number(w.json.effective.contextWindow), 'prepared.context.contextWindow=' + w.json.prepared.context.contextWindow + ' effective.contextWindow=' + w.json.effective.contextWindow)
    }
    report.modelWrite = w.json
  }
  // 还原
  if (cur) {
    const r = await call('POST', '/model-hub/api/model', { provider, model, patch: { contextWindow: cur } })
    check('POST /model 还原回原值', r.status === 200 && r.json && r.json.ok === true, 'status=' + r.status + ' effective=' + JSON.stringify(r.json && r.json.effective))
  }
}

// ---- 5) selftest 四字段 + restore ----
if (doSelftest) {
  console.log('')
  console.log('=== 5) POST /model-hub/api/selftest（contextWindow / maxTokens / vision / restore） ===')
  const scenarios = []
  const cw0 = info ? Number(info.contextWindow) || 0 : 0
  const mt0 = info ? Number(info.maxTokens) || 0 : 0
  const v0 = info ? visionOf(info) : false
  scenarios.push({ name: 'contextWindow', expectField: 'contextWindow', patch: { contextWindow: pickDifferent(cw0, [131072, 262144, 1000000]) } })
  scenarios.push({ name: 'maxTokens', expectField: 'maxTokens', patch: { maxTokens: pickDifferent(mt0, [65536, 131072, 262144, 384000]) } })
  scenarios.push({ name: 'vision', expectField: 'inputModalities', patch: { vision: !v0 } })
  scenarios.push({ name: 'restore', patch: { contextWindow: pickDifferent(cw0, [131072, 262144]) }, restore: true })

  report.selftest = []
  for (const sc of scenarios) {
    const body = { provider, model, patch: sc.patch }
    if (sc.restore) body.restore = true
    const s = await call('POST', '/model-hub/api/selftest', body)
    const entry = { scenario: sc.name, request: body, status: s.status, response: s.json, rawBody: s.text }
    report.selftest.push(entry)
    check('selftest[' + sc.name + '] HTTP 200', s.status === 200, 'status=' + s.status)
    if (s.json) {
      check('selftest[' + sc.name + '] ok:true', s.json.ok === true, 'ok=' + s.json.ok + (s.json.code ? ' code=' + s.json.code : '') + (s.json.pending ? ' pending=' + JSON.stringify(s.json.pending) : ''))
      if (sc.name !== 'restore') {
        check('selftest[' + sc.name + '] changed:true（运行时信息真的变了）', s.json.changed === true, 'changed=' + s.json.changed + ' diff=' + JSON.stringify(s.json.diff || null))
      } else {
        check('selftest[restore] restoredCleanly:true', s.json.restoredCleanly === true, 'restoredCleanly=' + s.json.restoredCleanly + ' restored=' + JSON.stringify(s.json.restored || null))
      }
      // --- 请求级证据：prepareCall() 物化结果（host-capability task-4 新增） ---
      const hasBefore = !!s.json.beforePrepared
      const hasAfter = !!s.json.afterPrepared
      entry.prepared = {
        hasBeforePrepared: hasBefore,
        hasAfterPrepared: hasAfter,
        beforeConfig: s.json.beforePrepared ? s.json.beforePrepared.config : null,
        afterConfig: s.json.afterPrepared ? s.json.afterPrepared.config : null,
        beforeContext: s.json.beforePrepared ? s.json.beforePrepared.context : null,
        beforeInputModalities: s.json.beforePrepared ? s.json.beforePrepared.inputModalities : null,
        afterInputModalities: s.json.afterPrepared ? s.json.afterPrepared.inputModalities : null,
        adapterDefaults: s.json.afterPrepared ? s.json.afterPrepared.adapterDefaults : null,
        requestDiff: s.json.requestDiff || null,
        changedRequest: s.json.changedRequest,
        restoreRequestDiff: s.json.restoreRequestDiff || null,
        restoredCleanlyRequest: s.json.restoredCleanlyRequest,
      }
      check('selftest[' + sc.name + '] 带 prepareCall 物化 (beforePrepared/afterPrepared)', hasBefore && hasAfter, 'hasBeforePrepared=' + hasBefore + ' hasAfterPrepared=' + hasAfter + (s.json.afterPrepared && s.json.afterPrepared.prepareError ? ' prepareError=' + JSON.stringify(s.json.afterPrepared.prepareError) : ''))
      if (sc.name === 'restore') {
        check('selftest[restore] restoredCleanlyRequest:true', s.json.restoredCleanlyRequest === true, 'restoredCleanlyRequest=' + s.json.restoredCleanlyRequest + ' restoreRequestDiff=' + JSON.stringify(s.json.restoreRequestDiff || null))
      } else {
        check('selftest[' + sc.name + '] changedRequest:true', s.json.changedRequest === true, 'changedRequest=' + s.json.changedRequest)
        const rd = s.json.requestDiff
        const hasField = Array.isArray(rd) && rd.some((d) => d && d.field === sc.expectField)
        check('selftest[' + sc.name + '] requestDiff 含 ' + sc.expectField, hasField, JSON.stringify(rd))
      }
      if (sc.name === 'maxTokens' && s.json.afterPrepared && s.json.afterPrepared.config) {
        const gotMt = Number(s.json.afterPrepared.config.maxTokens)
        const wantMt = Number(sc.patch.maxTokens)
        check('selftest[maxTokens] afterPrepared.config.maxTokens == 请求值（真正要发出去的参数）', gotMt === wantMt, 'after=' + gotMt + ' want=' + wantMt + ' before=' + (s.json.beforePrepared && s.json.beforePrepared.config ? s.json.beforePrepared.config.maxTokens : 'n/a'))
      }
      if (sc.name === 'contextWindow' && s.json.afterPrepared && s.json.afterPrepared.context) {
        const gotCw = Number(s.json.afterPrepared.context.contextWindow)
        const wantCw = Number(sc.patch.contextWindow)
        check('selftest[contextWindow] afterPrepared.context.contextWindow == 请求值', gotCw === wantCw, 'after=' + gotCw + ' want=' + wantCw)
      }
      if (sc.name === 'vision' && s.json.afterPrepared) {
        const im = s.json.afterPrepared.inputModalities
        check('selftest[vision] afterPrepared.inputModalities 不再含 image', Array.isArray(im) && !im.includes('image'), JSON.stringify(im) + '  before=' + JSON.stringify(s.json.beforePrepared ? s.json.beforePrepared.inputModalities : null))
      }
      const hits = findPrepareCallish(s.json)
      entry.prepareCallishKeys = hits
      if (hits.length === 0) {
        report.notes.push('selftest[' + sc.name + '] 响应里没有 prepareCall 物化后的 config（Lead 要求：直接上报，不许绕过）')
      }
    }
  }
  const anyHits = report.selftest.some((e) => (e.prepareCallishKeys || []).length > 0)
  check('selftest 响应包含 prepareCall 物化后的 config（Lead 的主证据要求）', anyHits, anyHits ? '命中键：' + JSON.stringify(report.selftest.flatMap((e) => e.prepareCallishKeys || [])) : '未找到 prepareCall/preparedConfig/callConfig/requestConfig 等键 -> 需要报 lead')
}

// ---- 6) patch 文件是否逐字节复原 ----
const patchShaAfter = sha(PATCH_FILE)
check('profile cordis.patch.yml 在整轮探测后逐字节复原', patchShaBefore === patchShaAfter, 'before=' + patchShaBefore + ' after=' + patchShaAfter)
report.patchFile = { before: patchShaBefore, after: patchShaAfter, restored: patchShaBefore === patchShaAfter }

// ------------------------------------------------------------------ 汇总 -----
const failed = checks.filter((c) => !c.pass)
report.checks = checks
console.log('')
console.log('=== 汇总 ===')
console.log('checks: ' + (checks.length - failed.length) + ' / ' + checks.length + ' passed')
for (const f of failed) console.log('[x] ' + f.name + '  -- ' + f.detail)
if (!cookie) {
  console.log('')
  console.log('提示：若出现 401，需要带浏览器会话 Cookie：')
  console.log('  node tools/probe-modelhub.mjs --cookie "dsh_web_session=...."')
  console.log('  或设环境变量 DSH_COOKIE。Cookie 名形如 dsh_web_session@127.0.0.1:57826（见 dsh-client-connection 的 cookieName(authority)）。')
}
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'probe-' + stamp + '.json')
fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
console.log('')
console.log('JSON 报告: ' + outFile)
// 不要用 process.exit()：Windows 上 undici 的 socket 还在关闭时会触发 libuv 断言。
process.exitCode = failed.length > 0 ? 1 : 0
