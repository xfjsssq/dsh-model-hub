#!/usr/bin/env node
// tools/mock-openai.mjs -- 本地假上游，用来**零费用**验证"能力卡里设的参数真的进了请求体"。
//
//   node tools/mock-openai.mjs                       # 随机端口，日志 = _recon/verify/mock-openai-<ts>.jsonl
//   node tools/mock-openai.mjs --port 45999
//   node tools/mock-openai.mjs --expect-max-tokens 262144
//
// 用法：把它作为某个 provider 的 baseURL（http://127.0.0.1:<port>/v1），在 GUI 里选那个模型发一句 hi。
// 断言：收到的 JSON body 里 max_tokens（或 max_completion_tokens / max_output_tokens）等于你在能力卡里设的值。
//
// 安全：只 bind 127.0.0.1，绝不向外转发任何东西，不调用任何上游，因此不产生任何费用。
// 结束后记得把临时 provider 的 baseURL 还原（settings 是 live 写入，无需重启）。

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE = path.resolve(HERE, '..')

const argv = process.argv.slice(2)
const opt = { port: 0 }
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') { opt.port = Number(argv[++i]); continue }
  if (argv[i] === '--expect-max-tokens') { opt.expectMaxTokens = Number(argv[++i]); continue }
  if (argv[i] === '--log') { opt.log = argv[++i]; continue }
  if (argv[i] === '--out') { opt.outDir = argv[++i]; continue }
}
const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
const outDir = opt.outDir ? path.resolve(opt.outDir) : path.join(WORKSPACE, '_recon', 'verify')
fs.mkdirSync(outDir, { recursive: true })
const logFile = opt.log ? path.resolve(opt.log) : path.join(outDir, 'mock-openai-' + stamp + '.jsonl')

const TOKEN_FIELDS = ['max_tokens', 'max_completion_tokens', 'max_output_tokens', 'maxTokens', 'n_predict']
let verdict = null

function sseWrite(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n') }

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = null }
    const rec = {
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      headers: { 'content-type': req.headers['content-type'], authorization: req.headers['authorization'] ? '(present)' : undefined },
      body, rawBody: raw,
    }
    fs.appendFileSync(logFile, JSON.stringify(rec) + '\n')

    console.log('')
    console.log('--- ' + req.method + ' ' + req.url + ' ---')
    if (opt.expectMaxTokens !== undefined) {
      let seen = null
      let field = null
      for (const f of TOKEN_FIELDS) {
        const v = body && typeof body === 'object' ? body[f] : undefined
        if (v !== undefined && v !== null) { seen = v; field = f; break }
      }
      const pass = Number(seen) === Number(opt.expectMaxTokens)
      verdict = { pass, field, seen, expected: opt.expectMaxTokens }
      console.log((pass ? '[ok] ' : '[x] ') + 'max-tokens 断言: 期望 ' + opt.expectMaxTokens + '，收到 ' + (field ? (field + '=' + seen) : '(没有任何 max-token 字段)'))
    } else {
      const interesting = {}
      if (body && typeof body === 'object') {
        for (const k of ['model', 'stream', ...TOKEN_FIELDS, 'temperature', 'reasoning_effort', 'reasoning', 'thinking', 'context_window', 'contextWindow']) {
          if (body[k] !== undefined) interesting[k] = body[k]
        }
      }
      console.log('  body 关键字段: ' + JSON.stringify(interesting))
    }

    // GET /v1/models —— 给 GUI settings 探测用
    if (req.method === 'GET' && /\/models\/?$/.test(req.url || '')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }] }))
      return
    }

    const wantsStream = !!(body && body.stream) || /stream=true/.test(req.url || '')
    const id = 'chatcmpl-mock-' + Date.now()
    const model = (body && body.model) || 'mock-model'
    if (wantsStream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      sseWrite(res, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: 'mock-ok' }, finish_reason: null }] })
      sseWrite(res, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'mock-ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })
})

server.listen(opt.port, '127.0.0.1', () => {
  const port = server.address().port
  console.log('mock-openai listening on http://127.0.0.1:' + port)
  console.log('PORT=' + port)
  console.log('baseURL 请填: http://127.0.0.1:' + port + '/v1')
  console.log('日志: ' + logFile)
  if (opt.expectMaxTokens !== undefined) console.log('断言: max-token 字段应等于 ' + opt.expectMaxTokens)
  console.log('（Ctrl+C 退出。退出后记得还原临时 provider 的 baseURL。）')
})

function shutdown() {
  console.log('')
  console.log('mock-openai 收到请求日志: ' + logFile)
  if (verdict) {
    console.log((verdict.pass ? '[ok] ' : '[x] ') + '最终断言: 期望 ' + verdict.expected + '，收到 ' + (verdict.field ? (verdict.field + '=' + verdict.seen) : '(缺失)'))
    process.exitCode = verdict.pass ? 0 : 1
  }
  server.close(() => {})
  setTimeout(() => { process.exitCode = process.exitCode || 0 }, 100)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
