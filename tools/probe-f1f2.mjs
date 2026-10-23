#!/usr/bin/env node
// tools/probe-f1f2.mjs v2 -- 复验 F1(declaredAfter) / F2(changed 覆盖 efforts) 与声明层 diff
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const argv = process.argv.slice(2)
const opt = { base: 'http://127.0.0.1:3080', provider: 'alpha', model: 'm-vision', model2: 'epsilon/m-haiku' }
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { opt[argv[i].slice(2)] = argv[i + 1]; i++ }
const base = String(opt.base).replace(/\/+$/, '')
const patchFile = path.join(String(opt.profile), 'cordis.patch.yml')
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') } catch (e) { return null } }
const read = () => { try { return fs.readFileSync(patchFile, 'utf8') } catch (e) { return '' } }
const norm = (t) => t.split('\n').map((l) => l.trim()).filter((l) => l.length && !l.startsWith('#')).sort().join('\n')
const checks = [], findings = []
const check = (n, p2, d) => { checks.push({ n, p: !!p2, d: String(d) }); console.log((p2 ? '[ok] ' : '[x] ') + n + '  -- ' + d) }
const finding = (c, d) => { findings.push({ c, d }); console.log('[!] FINDING ' + c + ' -- ' + d) }
const report = { base, checks, findings, steps: [] }
async function call(m, p2, b) {
  const init = { method: m, headers: {} }
  if (b !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(b) }
  const res = await fetch(base + p2, init); const text = await res.text(); let j = null; try { j = JSON.parse(text) } catch (e) { }
  report.steps.push({ m, p: p2, req: b === undefined ? null : b, status: res.status, body: text })
  console.log('--- ' + m + ' ' + p2 + ' -> ' + res.status)
  return { status: res.status, j }
}
const snap = () => ({ sha: sha(patchFile), norm: norm(read()) })
const ev = (label, a, b) => { const e = { label, bytesIdentical: a.sha === b.sha, configEquivalent: a.norm === b.norm }; report.evidence = report.evidence || []; report.evidence.push(e); return e }
const cat = await call('GET', '/model-hub/api/catalog')
const provs = (cat.j && cat.j.providers) || []
const find = (p2, m) => { const P = provs.find((x) => x.id === p2); return P && P.models ? P.models.find((x) => x.id === m) : null }
const mv = find(opt.provider, opt.model)

console.log('=== F1: POST /model 的 declaredAfter（目标 ' + opt.provider + '/' + opt.model + '）===')
const s0 = snap()
const a1 = await call('POST', '/model-hub/api/model', { provider: opt.provider, model: opt.model, patch: { maxTokens: 70000 } })
const keys = a1.j ? Object.keys(a1.j) : []
check('F1) 顶层键含 declaredAfter', keys.includes('declaredAfter'), JSON.stringify(keys))
if (keys.includes('declaredAfter')) {
  const da = a1.j.declaredAfter
  check('F1) declaredAfter.maxTokens = 70000（写入后声明层原值）', Number(da.maxTokens) === 70000, JSON.stringify(da.maxTokens))
  check('F1) declaredAfter.contextWindow = 1000000', Number(da.contextWindow) === 1000000, JSON.stringify(da.contextWindow))
  check('F1) declaredAfter.input = [text,image]', Array.isArray(da.input) && da.input.join(',') === 'text,image', JSON.stringify(da.input))
  const i1 = keys.indexOf('declaredAfter'), i2 = keys.indexOf('appliedVia')
  check('F1) declaredAfter 在 appliedVia 之前', i1 >= 0 && i2 >= 0 && i1 < i2, 'idx=' + i1 + '/' + i2)
} else finding('DECLARED_AFTER_MISSING', JSON.stringify(keys))
await call('POST', '/model-hub/api/model', { provider: opt.provider, model: opt.model, patch: { maxTokens: 65536 } })
const eA = ev('F1 还原', s0, snap())
check('F1) 只改值还原后 bytesIdentical', eA.bytesIdentical, JSON.stringify(eA))

console.log('=== F1b: 含 unset 的补丁 —— 声明层 diff 应可见（selftest 去 image）===')
const r1 = await call('POST', '/model-hub/api/selftest', { provider: opt.provider, model: opt.model, patch: { inputModalities: ['text'] } })
const j1 = r1.j || {}
const cfgFields = Array.isArray(j1.configuredDiff) ? j1.configuredDiff.map((d) => d.field) : null
check('F1b) afterConfigured.input = [text]', !!(j1.afterConfigured && Array.isArray(j1.afterConfigured.input) && j1.afterConfigured.input.join(',') === 'text'), JSON.stringify(j1.afterConfigured && j1.afterConfigured.input))
check('F1b) afterConfigured 无 imagePixelBudget/imageMaxBytes（键已删除可见）', !!(j1.afterConfigured && j1.afterConfigured.imagePixelBudget === undefined && j1.afterConfigured.imageMaxBytes === undefined), JSON.stringify({ b: j1.afterConfigured && j1.afterConfigured.imagePixelBudget, m: j1.afterConfigured && j1.afterConfigured.imageMaxBytes }))
if (cfgFields === null) finding('CONFIGURED_DIFF_MISSING', '响应无 configuredDiff')
else {
  check('F1b) configuredDiff 含 input 相关项', cfgFields.some((f) => f === 'input' || f === 'inputModalities'), JSON.stringify(cfgFields))
  check('F1b) configuredDiff 含 imagePixelBudget 的 unset', cfgFields.includes('imagePixelBudget'), JSON.stringify(cfgFields))
  check('F1b) configuredDiff 含 imageMaxBytes 的 unset', cfgFields.includes('imageMaxBytes'), JSON.stringify(cfgFields))
}
check('F1b) changedConfigured = true', j1.changedConfigured === true, 'changedConfigured=' + j1.changedConfigured)
check('F1b) restoredConfigured 有 image* (还原后声明层)', !!(j1.restoredConfigured && j1.restoredConfigured.imagePixelBudget !== undefined && j1.restoredConfigured.imageMaxBytes !== undefined), JSON.stringify({ b: j1.restoredConfigured && j1.restoredConfigured.imagePixelBudget, m: j1.restoredConfigured && j1.restoredConfigured.imageMaxBytes }))

console.log('=== F2: reasoningEfforts=null（必须选真正声明了档位的模型）===')
for (const [p2, m] of [[opt.provider, opt.model], ['epsilon', 'm-haiku']]) {
  const info = find(p2, m)
  if (!info || !info.declaredReasoningEfforts) { console.log('  (skip ' + p2 + '/' + m + '：未声明 reasoningEfforts)'); continue }
  const before = snap()
  const rr = await call('POST', '/model-hub/api/selftest', { provider: p2, model: m, patch: { reasoningEfforts: null } })
  const j = rr.j || {}
  const be = j.before && j.before.efforts ? j.before.efforts.map((x) => x.id) : null
  const ae = j.after && j.after.efforts ? j.after.efforts.map((x) => x.id) : null
  check('F2[' + p2 + ']) after.efforts = []', JSON.stringify(ae) === '[]', 'before=' + JSON.stringify(be) + ' after=' + JSON.stringify(ae))
  check('F2[' + p2 + ']) diff 含 efforts', Array.isArray(j.diff) && j.diff.some((d) => d.field === 'efforts'), JSON.stringify(j.diff))
  check('F2[' + p2 + ']) changed = true（核心修复）', j.changed === true, 'changed=' + j.changed)
  check('F2[' + p2 + ']) configuredDiff 的 reasoningEfforts: before=对象 after=null', Array.isArray(j.configuredDiff) && j.configuredDiff.some((d) => d.field === 'reasoningEfforts' && d.after === null && d.before && typeof d.before === 'object'), JSON.stringify(j.configuredDiff))
  check('F2[' + p2 + ']) changedConfigured = true', j.changedConfigured === true, 'changedConfigured=' + j.changedConfigured)
  check('F2[' + p2 + ']) restoredCleanly* 均 true', j.restoredCleanly === true && j.restoredCleanlyConfigured === true, JSON.stringify({ a: j.restoredCleanly, b: j.restoredCleanlyConfigured }))
  check('F2[' + p2 + ']) restoreConfiguredDiff = []', Array.isArray(j.restoreConfiguredDiff) && j.restoreConfiguredDiff.length === 0, JSON.stringify(j.restoreConfiguredDiff))
  check('F2[' + p2 + ']) afterConfigured 无 reasoningEfforts', !!(j.afterConfigured && j.afterConfigured.reasoningEfforts === undefined), JSON.stringify(j.afterConfigured && j.afterConfigured.reasoningEfforts))
  check('F2[' + p2 + ']) restoredConfigured 有 reasoningEfforts', !!(j.restoredConfigured && j.restoredConfigured.reasoningEfforts), JSON.stringify(j.restoredConfigured && j.restoredConfigured.reasoningEfforts))
  check('F2[' + p2 + ']) requestDiff=[] / changedRequest=false（语义正确，不算失败）', Array.isArray(j.requestDiff) && j.requestDiff.length === 0 && j.changedRequest === false, 'changedRequest=' + j.changedRequest)
  const e = ev('F2 ' + p2 + ' 自还原', before, snap())
  check('F2[' + p2 + ']) 自还原后配置等价', e.configEquivalent, JSON.stringify(e))
}

console.log('=== F2 反向回归：只改 maxTokens 时 changed 必须仍为 true ===')
const rv = await call('POST', '/model-hub/api/selftest', { provider: opt.provider, model: opt.model, patch: { maxTokens: 70000 } })
check('反向) changed = true', rv.j && rv.j.changed === true, 'changed=' + (rv.j && rv.j.changed) + ' diff=' + JSON.stringify(rv.j && rv.j.diff))

const failed = checks.filter((c) => !c.p)
console.log(''); console.log('checks: ' + (checks.length - failed.length) + ' / ' + checks.length + ' ; findings: ' + findings.length)
for (const f of failed) console.log('[x] ' + f.n + ' -- ' + f.d)
for (const f of findings) console.log('[!] ' + f.c + ' -- ' + f.d)
const outDir = path.resolve(path.dirname(process.argv[1] || '.'), '..', '_recon', 'verify')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'probe-f1f2-' + new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14) + '.json')
fs.writeFileSync(outFile, JSON.stringify(report, null, 2)); console.log('JSON: ' + outFile)
process.exitCode = failed.length ? 1 : 0