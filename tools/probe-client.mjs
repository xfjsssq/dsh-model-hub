#!/usr/bin/env node
// tools/probe-client.mjs -- 客户端半边集成证据（不需要 GUI，也不需要 cookie 之外的东西）。
//
//   node tools/probe-client.mjs --base http://127.0.0.1:3080 --token <launchToken>
//   node tools/probe-client.mjs --base http://127.0.0.1:3080 --token <t> --pkg dsh-model-hub
//
// 做三件事：
//   1) 用 launch token 换一个浏览器会话 cookie（GET /?token=...  -> 303 + set-cookie）。
//   2) 带 cookie 取 index HTML，断言**启动清单（boot manifest）里出现了我们的客户端包 id**
//      —— 这证明宿主已经发现我们的 client bundle 并且会把它注入页面。
//   3) 直接取 /plugins/<pkg>/client.js（宿主给客户端资源的前缀，常量 PLUGIN_ROUTE="/plugins"，
//      见 @deepseek-ai/dsh-client-modules/lib/index.js:202），断言 HTTP 200 且开头是
//      window.__ModuleLoader__.load({ id: '<pkg>'。
//
// 只读：不写 profile、不调上游。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE = path.resolve(HERE, '..')

const argv = process.argv.slice(2)
const opt = { base: 'http://127.0.0.1:3080', pkg: 'dsh-model-hub' }
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--base') { opt.base = argv[++i]; continue }
  if (argv[i] === '--token') { opt.token = argv[++i]; continue }
  if (argv[i] === '--pkg') { opt.pkg = argv[++i]; continue }
  if (argv[i] === '--out') { opt.out = argv[++i]; continue }
}
const base = String(opt.base).replace(/\/+$/, '')
const pkg = String(opt.pkg)
const outDir = opt.out ? path.resolve(opt.out) : path.join(WORKSPACE, '_recon', 'verify')
const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)

const report = { stamp, base, pkg, calls: [], checks: [] }
const checks = []
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail: String(detail) })
  console.log((pass ? '[ok] ' : '[x] ') + ' ' + name + '  -- ' + detail)
}

// ------------------------------------------------------------ 1) 换 cookie ----
let cookie = ''
if (opt.token) {
  const url = base + '/?token=' + encodeURIComponent(opt.token)
  const res = await fetch(url, { redirect: 'manual' })
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  const sc = setCookie.find((c) => /^dsh-auth-/.test(c)) || setCookie[0] || ''
  cookie = sc.split(';')[0]
  const rec = { step: 'mint-cookie', url: url.replace(opt.token, '<token>'), status: res.status, location: res.headers.get('location'), setCookieNames: setCookie.map((c) => c.split('=')[0]) }
  report.calls.push(rec)
  console.log('')
  console.log('--- GET /?token=<token> ---')
  console.log('  HTTP ' + res.status + '  location=' + (res.headers.get('location') || '(none)'))
  console.log('  set-cookie: ' + (setCookie.map((c) => c.split('=')[0] + '=<redacted>').join('; ') || '(none)'))
  check('launch token 能换到会话 cookie', cookie.length > 0 && (res.status === 303 || res.status === 302), 'status=' + res.status + ' cookieName=' + (cookie.split('=')[0] || '(none)'))
} else {
  console.log('')
  console.log('(未提供 --token：跳过换 cookie，index/boot manifest 可能拿不到)')
}

const H = cookie ? { cookie } : {}

// ------------------------------------------------- 2) boot manifest 里有没有我们 ----
console.log('')
console.log('--- GET /  (index HTML / boot manifest) ---')
let indexStatus = null
let indexBody = ''
try {
  const res = await fetch(base + '/', { headers: H })
  indexStatus = res.status
  indexBody = await res.text()
  console.log('  HTTP ' + res.status + '  len=' + indexBody.length)
} catch (e) { console.log('  ERR ' + e.message) }
report.calls.push({ step: 'index', status: indexStatus, len: indexBody.length })

if (indexStatus === 200) {
  const idx = indexBody.indexOf(pkg)
  const hasPkg = idx >= 0
  check('index/boot manifest 里出现 ' + pkg, hasPkg, hasPkg ? '首次出现在偏移 ' + idx : '未出现（客户端半边可能还没被宿主纳入启动清单）')
  if (hasPkg) {
    const snippet = indexBody.slice(Math.max(0, idx - 260), idx + 260)
    console.log('  上下文片段: ' + JSON.stringify(snippet))
    report.bootSnippet = snippet
  }
  // 顺带找出 boot manifest 里的 plugin 资源前缀与 rev
  const m = indexBody.match(/\/plugins\/[^"'\s\\]*/g)
  if (m) { report.pluginUrlsInIndex = [...new Set(m)].slice(0, 12); console.log('  index 里出现的 /plugins/ URL 样例: ' + report.pluginUrlsInIndex.join(' , ')) }
} else if (indexStatus === 401) {
  check('index 可达', false, 'HTTP 401（需要有效 cookie / token）')
}

// ------------------------------------------------- 3) 取真实 client bundle ----
// 客户端入口走的是 **combo** 形式：/plugins/??<id>/client.js,<id>/client.js&rev=<rev>
// （comboUrl()，@deepseek-ai/dsh-client-modules/lib/index.js:204-210）。
// 单个 /plugins/<pkg>/client.js 只服务包内 client.<hash>.js 分片（chunkUrl()），所以 404 是正常的。
console.log('')
console.log('--- combo：/plugins/??.../client.js&rev=... ---')
const rawUrls = (indexBody.match(/\/?plugins\/\?\?[^"'\s\\<>]+/g) || [])
  .map((u) => u.replace(/&amp;/g, '&').replace(/\\u0026/g, '&'))
  .map((u) => (u.startsWith('/') ? u : '/' + u))
const combos = [...new Set(rawUrls)].filter((u) => u.includes(pkg + '/client.js'))
report.comboCandidates = combos.length
console.log('  index 里含 ' + pkg + ' 的 combo URL 数: ' + combos.length)
if (combos.length === 0) {
  check('能定位到含 ' + pkg + ' 的 combo URL', false, 'index 里没找到 combo（boot manifest 形式可能变了）')
} else {
  const cu = combos[0]
  console.log('  取第一个（URL 长 ' + cu.length + '，含 ' + (cu.match(/client\.js/g) || []).length + ' 个 client.js）')
  for (const withCookie of [true, false]) {
    let status = null, body = ''
    try {
      const res = await fetch(base + cu, { headers: withCookie ? H : {} })
      status = res.status
      body = await res.text()
    } catch (e) { body = 'ERR ' + e.message }
    console.log('  ' + (withCookie ? '[with cookie]   ' : '[without cookie]') + ' HTTP ' + status + '  len=' + body.length)
    report.calls.push({ step: 'combo', withCookie, status, len: body.length })
    if (withCookie) {
      check('combo client bundle 可取到 (HTTP 200)', status === 200, 'status=' + status + ' len=' + body.length)
      // 真实写法是多行的：
      //   window.__ModuleLoader__.load({
      //     id: 'dsh-model-hub',
      //     factory: (require) => {
      // 所以用容忍空白的正则，不要用精确字符串。
      const esc = pkg.split('').map(function (ch) { return '\\^$.*+?()[]{}|'.indexOf(ch) >= 0 ? '\\' + ch : ch }).join('')
      const loaderRe = new RegExp('window\\.__ModuleLoader__\\.load\\(\\{\\s*id:\\s*[\'\"]' + esc + '[\'\"]')
      const m2 = body.match(loaderRe)
      const at = m2 ? m2.index : -1
      check('combo 内容含 __ModuleLoader__.load({ id: "' + pkg + '" })', at >= 0, at >= 0 ? '匹配于偏移 ' + at : '未找到 ' + loaderRe.source)
      if (at >= 0) {
        const snip = body.slice(at, at + 200)
        console.log('  片段: ' + JSON.stringify(snip))
        report.comboSnippet = snip
        report.loaderRegex = loaderRe.source
      }
    } else {
      check('combo 路由是否需要 cookie', true, 'without-cookie status=' + status + '（200=免 cookie）')
    }
  }
}

// ---------------------------------------------------------------- 汇总 --------
const failed = checks.filter((c) => !c.pass)
report.checks = checks
console.log('')
console.log('checks: ' + (checks.length - failed.length) + ' / ' + checks.length + ' passed')
for (const f of failed) console.log('[x] ' + f.name + '  -- ' + f.detail)
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'probe-client-' + stamp + '.json')
fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
console.log('JSON 报告: ' + outFile)
process.exitCode = failed.length > 0 ? 1 : 0
