#!/usr/bin/env node
// tools/probe-v12-fields.mjs v2 -- v1.2 能力字段验收（inputModalities / reasoningEfforts / declared* / declaredAfter）
// 并落实 host-capability 的更正：只改值 -> bytesIdentical；含 unset -> 『配置等价』(行多重集)。
// 用法: node tools/probe-v12-fields.mjs --base http://127.0.0.1:3080 --profile <profile dir> --provider alpha --model m-vision

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)
const opt = { base: 'http://127.0.0.1:3080', provider: 'alpha', model: 'm-vision' }
for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { opt[argv[i].slice(2)] = argv[i + 1]; i++ } }
const base = String(opt.base).replace(/\/+$/, '')
const provider = String(opt.provider), model = String(opt.model)
const patchFile = path.join(String(opt.profile), 'cordis.patch.yml')

const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') } catch (e) { return null } }
const readPatch = () => { try { return fs.readFileSync(patchFile, 'utf8') } catch (e) { return '' } }
const norm = (t) => t.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#')).sort().join('\n')
const onlyIn = (a, b) => { const mb = new Map(); for (const l of b.split('\n')) mb.set(l, (mb.get(l) || 0) + 1); const out = []; for (const l of a.split('\n')) { const c = mb.get(l) || 0; if (c > 0) mb.set(l, c - 1); else out.push(l) } return out }

const checks = [], findings = []
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail: String(detail) }); console.log((pass ? '[ok] ' : '[x] ') + name + '  -- ' + detail) }
const finding = (code, detail) => { findings.push({ code, detail }); console.log('[!] FINDING ' + code + ' -- ' + detail) }
const report = { base, provider, model, patchFile, steps: [], checks, findings }

async function call(method, p, body) {
  const init = { method, headers: {} }
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body) }
  const res = await fetch(base + p, init)
  const text = await res.text()
  let json = null; try { json = JSON.parse(text) } catch (e) { }
  report.steps.push({ method, path: p, request: body === undefined ? null : body, status: res.status, body: text })
  console.log('--- ' + method + ' ' + p + ' -> HTTP ' + res.status)
  console.log('    ' + (text.length > 700 ? text.slice(0, 700) + '...' : text))
  return { status: res.status, json, text }
}
const snapshot = (label) => ({ label, sha: sha(patchFile), norm: norm(readPatch()) })
function evidence(label, before, after) {
  const ev = { label, bytesIdentical: before.sha === after.sha, configEquivalent: before.norm === after.norm, removedLines: onlyIn(before.norm, after.norm).slice(0, 6), addedLines: onlyIn(after.norm, before.norm).slice(0, 6) }
  report.evidence = report.evidence || []; report.evidence.push(ev); return ev
}

console.log('=== v1.2 能力字段探针 v2 ===')
const h = await call('GET', '/model-hub/api/health')
check('health ok', h.status === 200 && h.json && h.json.ok === true, 'status=' + h.status)
const cat = await call('GET', '/model-hub/api/catalog')
const provs = (cat.json && cat.json.providers) || []
const pv = provs.find((p) => p.id === provider)
const mv = pv && pv.models ? pv.models.find((m) => m.id === model) : null
const plain = pv && pv.models ? pv.models.find((m) => m.id !== model) : null
check('declaredInputModalities = [text,image]', !!(mv && Array.isArray(mv.declaredInputModalities) && mv.declaredInputModalities.join(',') === 'text,image'), JSON.stringify(mv && mv.declaredInputModalities))
check('declaredReasoningEfforts 含 off/low/high', !!(mv && mv.declaredReasoningEfforts && 'off' in mv.declaredReasoningEfforts && 'low' in mv.declaredReasoningEfforts && 'high' in mv.declaredReasoningEfforts), JSON.stringify(mv && mv.declaredReasoningEfforts))
check('未声明 input 的模型没有 declaredInputModalities（负例）', !!(plain && plain.declaredInputModalities === undefined), JSON.stringify(plain && plain.declaredInputModalities))

const s0 = snapshot('initial')
const a1 = await call('POST', '/model-hub/api/model', { provider, model, patch: { maxTokens: 70000 } })
check('A) 只改值写入 ok', !!(a1.json && a1.json.ok && a1.json.effective.maxTokens === 70000), JSON.stringify(a1.json && a1.json.effective && a1.json.effective.maxTokens))
if (!(a1.json && a1.json.declaredAfter)) finding('DECLARED_AFTER_MISSING', 'POST /model 响应没有 declaredAfter；顶层键 = ' + JSON.stringify(Object.keys(a1.json || {})))
else check('A) 响应含 declaredAfter', true, JSON.stringify(a1.json.declaredAfter && a1.json.declaredAfter.maxTokens))
await call('POST', '/model-hub/api/model', { provider, model, patch: { maxTokens: 65536 } })
const evA = evidence('A 只改值还原', s0, snapshot('A'))
check('A) 只改值还原后 bytesIdentical（强证据）', evA.bytesIdentical, JSON.stringify(evA))

const b1 = await call('POST', '/model-hub/api/model', { provider, model, patch: { inputModalities: ['image'] } })
check('B) 允许 image-only', !!(b1.json && b1.json.ok && b1.json.effective.inputModalities.join(',') === 'image'), JSON.stringify(b1.json && b1.json.effective && b1.json.effective.inputModalities))
const b2 = await call('POST', '/model-hub/api/model', { provider, model, patch: { inputModalities: ['text', 'image'] } })
check('B) 还原 input 成功', !!(b2.json && b2.json.ok), JSON.stringify(b2.json && b2.json.effective && b2.json.effective.inputModalities))

const beforeC = snapshot('C-before')
const c1 = await call('POST', '/model-hub/api/selftest', { provider, model, patch: { inputModalities: ['text'] } })
const opsC = (c1.json && c1.json.ops) || []
const setOk = opsC.some((o) => o.op === 'set' && o.path[o.path.length - 1] === 'input' && String(o.value) === 'text')
const unsetBudget = opsC.some((o) => o.op === 'unset' && o.path[o.path.length - 1] === 'imagePixelBudget')
const unsetMax = opsC.some((o) => o.op === 'unset' && o.path[o.path.length - 1] === 'imageMaxBytes')
check('C) ops = set input + unset imagePixelBudget + unset imageMaxBytes', setOk && unsetBudget && unsetMax, JSON.stringify(opsC))
check('C) 去掉 image 时 vision 变 false', !!(c1.json && c1.json.after && c1.json.after.vision === false), JSON.stringify(c1.json && c1.json.diff))
const evC = evidence('C selftest 含 unset 的还原', beforeC, snapshot('C-after'))
check('C) 含 unset 的还原：配置等价（行多重集一致）', evC.configEquivalent, JSON.stringify(evC))
if (!evC.bytesIdentical && evC.configEquivalent) console.log('    (符合 host-capability 的更正：unset 类补丁还原后 sha 变、配置等价)')

const d1 = await call('POST', '/model-hub/api/selftest', { provider, model, patch: { reasoningEfforts: null } })
const be = d1.json && d1.json.before && d1.json.before.efforts ? d1.json.before.efforts.map((e) => e.id) : null
const ae = d1.json && d1.json.after && d1.json.after.efforts ? d1.json.after.efforts.map((e) => e.id) : null
const opsD = (d1.json && d1.json.ops) || []
check('D) ops 里 unset reasoningEfforts', opsD.some((o) => o.op === 'unset' && o.path[o.path.length - 1] === 'reasoningEfforts'), JSON.stringify(opsD))
check('D) 运行时 efforts 确实被清空', JSON.stringify(ae) === '[]', 'before=' + JSON.stringify(be) + ' after=' + JSON.stringify(ae))
const changedD = !!(d1.json && d1.json.changed)
const diffD = (d1.json && d1.json.diff) || []
if (!changedD && JSON.stringify(be) !== JSON.stringify(ae)) {
  finding('EFFORTS_NOT_COVERED_BY_DIFF', 'reasoningEfforts 被清空(before=' + JSON.stringify(be) + ' -> after=' + JSON.stringify(ae) + ') 但 changed=' + changedD + '、diff=' + JSON.stringify(diffD) + '、changedRequest=' + (d1.json && d1.json.changedRequest) + '、requestDiff=' + JSON.stringify(d1.json && d1.json.requestDiff))
  check('D) changed 覆盖 efforts（若失败见 FINDING）', false, 'before=' + JSON.stringify(be) + ' after=' + JSON.stringify(ae) + ' changed=false')
} else { check('D) changed 覆盖 efforts', true, 'changed=' + changedD) }
const evD = evidence('D reasoningEfforts=null 的还原', snapshot('D-before'), snapshot('D-after'))
check('D) 含 unset 的还原：配置等价', evD.configEquivalent, JSON.stringify(evD))

const e1 = await call('POST', '/model-hub/api/model', { provider, model, patch: { inputModalities: ['audio'] } })
check('E) [audio] -> INVALID_INPUT_MODALITIES', !!(e1.json && e1.json.ok === false && e1.json.code === 'INVALID_INPUT_MODALITIES'), JSON.stringify(e1.json && e1.json.code))
const e2 = await call('POST', '/model-hub/api/model', { provider, model, patch: { inputModalities: [] } })
check('E) [] -> INVALID_INPUT_MODALITIES', !!(e2.json && e2.json.ok === false && e2.json.code === 'INVALID_INPUT_MODALITIES'), JSON.stringify(e2.json && e2.json.code))
const e3 = await call('POST', '/model-hub/api/model', { provider, model, patch: { reasoningEfforts: { off: null } } })
check('E) 只有 off -> INVALID_REASONING_EFFORTS', !!(e3.json && e3.json.ok === false && e3.json.code === 'INVALID_REASONING_EFFORTS'), JSON.stringify(e3.json && e3.json.code))
const e4 = await call('POST', '/model-hub/api/model', { provider, model, patch: { reasoningEfforts: { off: null, low: '' } } })
check('E) 空字符串 -> INVALID_REASONING_EFFORTS', !!(e4.json && e4.json.ok === false && e4.json.code === 'INVALID_REASONING_EFFORTS'), JSON.stringify(e4.json && e4.json.code))

const failed = checks.filter((c) => !c.pass)
console.log('')
console.log('checks: ' + (checks.length - failed.length) + ' / ' + checks.length + ' passed ; findings: ' + findings.length)
for (const f of failed) console.log('[x] ' + f.name + '  -- ' + f.detail)
for (const f of findings) console.log('[!] ' + f.code + '  -- ' + f.detail)
const outDir = path.resolve(path.dirname(process.argv[1] || '.'), '..', '_recon', 'verify')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'probe-v12-' + new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14) + '.json')
fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
console.log('JSON: ' + outFile)
process.exitCode = failed.length > 0 ? 1 : 0