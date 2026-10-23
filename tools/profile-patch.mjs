#!/usr/bin/env node
// profile-patch.mjs -- exact, idempotent edits to a DSH profile manifest.
//
//   node tools/profile-patch.mjs install   --profile <dir> --plugin <dir> [--dry-run]
//   node tools/profile-patch.mjs uninstall --profile <dir> --plugin <dir> [--dry-run]
//   node tools/profile-patch.mjs disable   --profile <dir> --plugin <dir> [--dry-run]
//   node tools/profile-patch.mjs enable    --profile <dir> --plugin <dir> [--dry-run]
//
// Emits exactly one JSON object on stdout; exit 0 = ok, 1 = refused / verify failed.
//
// WHY NOT STRING REPLACEMENT
//   profile/package.json is JSON.parse'd, mutated, re-serialised (2-space indent,
//   key order preserved) and re-parsed before writing, so the file can never be
//   corrupted and the diff stays minimal. cordis.patch.yml is only ever touched
//   through marker-delimited blocks that this very script wrote, and only when the
//   plugin does NOT ship its own dsh.bundle.patch (DSH then applies that patch
//   itself -- the dsh-mobile-plus precedent). Because the blocks are marker
//   delimited and matched by exact marker text, both edits are idempotent.
//
// SAFETY
//   - Nothing is written unless the new text differs from the old text.
//   - An unparsable profile package.json is a hard refusal (never rewritten).
//   - A declared-but-missing dsh.bundle.patch path is a hard refusal.
//   - --dry-run performs every computation but writes nothing.

import fs from 'node:fs'
import path from 'node:path'

const EMIT = (o, code) => {
  process.stdout.write(JSON.stringify(o, null, 2) + '\n')
  process.exit(typeof code === 'number' ? code : 0)
}
const refuse = (code, message) => EMIT({ ok: false, code, message }, 1)

// ---------------------------------------------------------------- arguments --
const argv = process.argv.slice(2)
const mode = argv[0]
const opt = {}
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--dry-run') { opt.dryRun = true; continue }
  if (a.startsWith('--')) { opt[a.slice(2)] = argv[i + 1]; i++; continue }
  refuse('bad-args', 'unexpected argument: ' + a)
}
const MODES = ['install', 'uninstall', 'disable', 'enable']
if (!MODES.includes(mode)) refuse('bad-mode', 'mode must be one of ' + MODES.join(' | '))
if (!opt.profile) refuse('bad-args', '--profile is required')
if (!opt.plugin) refuse('bad-args', '--plugin is required')

const dryRun = !!opt.dryRun
const profileDir = path.resolve(opt.profile)
const pluginDir = path.resolve(opt.plugin)
const manifestPath = path.join(profileDir, 'package.json')
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const pluginManifestPath = path.join(pluginDir, 'package.json')

if (!fs.existsSync(profileDir)) refuse('profile-missing', profileDir + ' does not exist')
if (!fs.statSync(profileDir).isDirectory()) refuse('profile-not-a-dir', profileDir + ' is not a directory')
if (!fs.existsSync(pluginManifestPath)) refuse('plugin-manifest-missing', pluginManifestPath + ' not found')
if (!fs.existsSync(manifestPath)) refuse('profile-manifest-missing', manifestPath + ' not found')

let pluginManifest
try { pluginManifest = JSON.parse(fs.readFileSync(pluginManifestPath, 'utf8')) }
catch (e) { refuse('plugin-manifest-invalid', pluginManifestPath + ': ' + e.message) }

const name = pluginManifest.name
if (typeof name !== 'string' || name.length === 0) {
  refuse('plugin-name-missing', pluginManifestPath + ' has no non-empty "name"')
}

const manifestText = fs.readFileSync(manifestPath, 'utf8')
let manifest
try { manifest = JSON.parse(manifestText) }
catch (e) { refuse('profile-manifest-invalid', 'refusing to touch an unparsable profile package.json: ' + e.message) }

// ------------------------------------------------------- plugin self-check ----
const spec = 'file:' + pluginDir.split(path.sep).join('/')
const notes = []
const declaredPatch = pluginManifest.dsh && pluginManifest.dsh.bundle && pluginManifest.dsh.bundle.patch
  ? String(pluginManifest.dsh.bundle.patch)
  : null
if (declaredPatch) {
  const p = path.isAbsolute(declaredPatch) ? declaredPatch : path.join(pluginDir, declaredPatch)
  if (!fs.existsSync(p)) {
    refuse('plugin-patch-missing', 'package.json declares dsh.bundle.patch=' + declaredPatch + ' but ' + p + ' does not exist')
  }
  notes.push('plugin ships dsh.bundle.patch (' + declaredPatch + '): DSH inserts the entry by itself, so profile cordis.patch.yml needs no insert block')
} else {
  notes.push('plugin has NO dsh.bundle.patch: this script maintains a marker-delimited insert block in profile cordis.patch.yml')
}
if (pluginManifest.dsh && pluginManifest.dsh.client) {
  const ex = pluginManifest.exports || {}
  const entry = ex['./client'] || ex['./client.js'] || (pluginManifest.dsh.client.entry ? pluginManifest.dsh.client.entry : null)
  if (entry) {
    const p = path.join(pluginDir, String(entry).replace(/^\.\//, ''))
    if (!fs.existsSync(p)) notes.push('WARNING: dsh.client is declared but its entry file does not exist yet: ' + p)
  }
  if (pluginManifest.dsh.client.platform) notes.push('dsh.client.platform = ' + pluginManifest.dsh.client.platform)
}

// ------------------------------------------------------------- JSON edit ------
const beforeBundles = (manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles))
  ? manifest.dsh.profile.bundles.slice()
  : null
const beforeDep = (manifest.dependencies && Object.prototype.hasOwnProperty.call(manifest.dependencies, name))
  ? manifest.dependencies[name]
  : null

let dependencyAction = 'unchanged'
let bundleAction = 'unchanged'

if (mode === 'install') {
  if (!manifest.dependencies || typeof manifest.dependencies !== 'object') manifest.dependencies = {}
  if (manifest.dependencies[name] === spec) {
    dependencyAction = 'already-present'
  } else {
    dependencyAction = (manifest.dependencies[name] === undefined) ? 'added' : 'updated'
    manifest.dependencies[name] = spec
  }
  if (!manifest.dsh || typeof manifest.dsh !== 'object') manifest.dsh = {}
  if (!manifest.dsh.profile || typeof manifest.dsh.profile !== 'object') manifest.dsh.profile = {}
  if (!Array.isArray(manifest.dsh.profile.bundles)) manifest.dsh.profile.bundles = []
  const i = manifest.dsh.profile.bundles.indexOf(name)
  if (i >= 0) {
    bundleAction = 'already-present at index ' + i
  } else {
    manifest.dsh.profile.bundles.push(name)
    bundleAction = 'appended at index ' + (manifest.dsh.profile.bundles.length - 1) + ' (matches DSH plugin-manager: enabling appends to the end)'
  }
} else if (mode === 'uninstall') {
  if (manifest.dependencies && Object.prototype.hasOwnProperty.call(manifest.dependencies, name)) {
    delete manifest.dependencies[name]
    dependencyAction = 'removed (was ' + JSON.stringify(beforeDep) + ')'
  } else {
    dependencyAction = 'not-present'
  }
  const bundles = manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles
  if (Array.isArray(bundles)) {
    const i = bundles.indexOf(name)
    if (i >= 0) { bundles.splice(i, 1); bundleAction = 'removed from index ' + i }
    else bundleAction = 'not-present'
  } else {
    bundleAction = 'no bundles array'
  }
}

const jsonNext = JSON.stringify(manifest, null, 2) + '\n'
let jsonChanged = jsonNext !== manifestText
if (jsonChanged) {
  try { JSON.parse(jsonNext) } catch (e) { refuse('internal-serialise-error', e.message) }
  // Reject an accidental whole-file reshuffle: only the expected JSON paths may differ.
  const a = JSON.parse(manifestText)
  const changedKeys = []
  const walk = (x, y, p) => {
    const xs = JSON.stringify(x); const ys = JSON.stringify(y)
    if (xs === ys) return
    const both = x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)
    if (!both) { changedKeys.push(p); return }
    for (const k of new Set(Object.keys(x).concat(Object.keys(y)))) walk(x[k], y[k], p ? p + '.' + k : k)
  }
  walk(a, manifest, '')
  const allowed = ['dependencies.' + name, 'dsh.profile.bundles']
  const unexpected = changedKeys.filter((k) => !allowed.includes(k))
  if (unexpected.length > 0) {
    refuse('unexpected-json-diff', 'refusing to write: unexpected JSON changes in ' + unexpected.join(', '))
  }
  notes.push('json diff confined to: ' + (changedKeys.join(', ') || '(none)'))
}

// -------------------------------------------------------- cordis.patch.yml ----
const MK = {
  insertOpen: '# >>> ' + name + ' (managed by tools/profile-patch.mjs: insert) >>>',
  insertClose: '# <<< ' + name + ' (insert) <<<',
  disableOpen: '# >>> ' + name + ' (managed by tools/profile-patch.mjs: disable) >>>',
  disableClose: '# <<< ' + name + ' (disable) <<<',
}
const insertLines = [
  MK.insertOpen,
  '- insert:',
  '    - id: ' + name,
  '      name: ' + name,
  '      config:',
  '        enabled: true',
  MK.insertClose,
]
const disableLines = [MK.disableOpen, '- id: ' + name, '  disabled: true', MK.disableClose]

const hasBlock = (text, openMark) => text.split('\n').some((l) => l.trim() === openMark)

function removeBlock(text, openMark, closeMark) {
  const lines = text.split('\n')
  const i = lines.findIndex((l) => l.trim() === openMark)
  if (i < 0) return { text, removed: false }
  const j = lines.findIndex((l, k) => k > i && l.trim() === closeMark)
  if (j < 0) throw new Error('unterminated managed block: ' + openMark)
  let end = j + 1
  if (lines[end] === '') end += 1
  lines.splice(i, end - i)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return { text: lines.length === 0 ? '' : lines.join('\n') + '\n', removed: true }
}

function appendBlock(text, lines) {
  let t = text.replace(/\n+$/, '')
  t = t === '' ? '' : t + '\n\n'
  return t + lines.join('\n') + '\n'
}

const patchExisted = fs.existsSync(patchPath)
let patchText = patchExisted ? fs.readFileSync(patchPath, 'utf8') : ''
let patchChanged = false
let patchAction = 'none'

try {
  if (mode === 'install') {
    if (declaredPatch) {
      patchAction = 'skipped (plugin ships dsh.bundle.patch)'
    } else if (hasBlock(patchText, MK.insertOpen)) {
      patchAction = 'insert block already present (idempotent no-op)'
    } else {
      patchText = appendBlock(patchText, insertLines)
      patchChanged = true
      patchAction = 'appended insert block'
    }
    if (hasBlock(patchText, MK.disableOpen)) {
      patchText = removeBlock(patchText, MK.disableOpen, MK.disableClose).text
      patchChanged = true
      patchAction += ' + removed stale disable block'
    }
  } else if (mode === 'uninstall') {
    const r1 = removeBlock(patchText, MK.insertOpen, MK.insertClose)
    const r2 = removeBlock(r1.text, MK.disableOpen, MK.disableClose)
    patchText = r2.text
    patchChanged = r1.removed || r2.removed
    patchAction = patchChanged ? 'removed managed block(s)' : 'no managed block present (idempotent no-op)'
  } else if (mode === 'disable') {
    if (hasBlock(patchText, MK.disableOpen)) {
      patchAction = 'disable override already present (idempotent no-op)'
    } else {
      patchText = appendBlock(patchText, disableLines)
      patchChanged = true
      patchAction = 'appended disable override'
    }
  } else if (mode === 'enable') {
    const r = removeBlock(patchText, MK.disableOpen, MK.disableClose)
    patchText = r.text
    patchChanged = r.removed
    patchAction = r.removed ? 'removed disable override' : 'not disabled (idempotent no-op)'
  }
} catch (e) {
  refuse('yaml-block-error', e.message)
}

if (patchChanged && !patchExisted && patchText.trim() === '') patchChanged = false

// ---------------------------------------------------------------- writes ------
const written = []
if (!dryRun) {
  if (jsonChanged) { fs.writeFileSync(manifestPath, jsonNext, 'utf8'); written.push(manifestPath) }
  if (patchChanged) { fs.writeFileSync(patchPath, patchText, 'utf8'); written.push(patchPath) }
}

// ------------------------------------------------------------ read-back -------
const verify = { ran: !dryRun }
if (!dryRun) {
  try {
    const rb = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const hasDep = !!(rb.dependencies && Object.prototype.hasOwnProperty.call(rb.dependencies, name))
    const bundles = rb.dsh && rb.dsh.profile && Array.isArray(rb.dsh.profile.bundles) ? rb.dsh.profile.bundles : []
    verify.after = { hasDependency: hasDep, dependency: hasDep ? rb.dependencies[name] : null, bundleCount: bundles.length, bundleIndex: bundles.indexOf(name) }
    verify.manifestParses = true
    verify.asExpected = mode === 'install'
      ? (hasDep && bundles.includes(name))
      : (mode === 'uninstall' ? (!hasDep && !bundles.includes(name)) : true)
    if (mode === 'install' && hasDep) verify.specMatches = rb.dependencies[name] === spec
    if (!patchExisted && patchChanged) verify.yamlCreated = fs.existsSync(patchPath)
    if (patchChanged && fs.existsSync(patchPath)) {
      const t = fs.readFileSync(patchPath, 'utf8')
      verify.yamlReadBack = {
        insertBlock: hasBlock(t, MK.insertOpen),
        disableBlock: hasBlock(t, MK.disableOpen),
        markerBalance: (t.match(/^# >>> /gm) || []).length === (t.match(/^# <<< /gm) || []).length,
      }
    }
  } catch (e) {
    verify.manifestParses = false
    verify.error = e.message
    verify.asExpected = false
  }
}

const ok = verify.asExpected !== false
EMIT({
  ok,
  mode,
  dryRun,
  plugin: { name, version: pluginManifest.version || null, dir: pluginDir, spec },
  profile: profileDir,
  json: { changed: jsonChanged, path: manifestPath, dependencyAction, bundleAction, before: { dependency: beforeDep, bundles: beforeBundles }, afterBundles: manifest.dsh && manifest.dsh.profile ? manifest.dsh.profile.bundles : null },
  yaml: { path: patchPath, existed: patchExisted, changed: patchChanged, action: patchAction },
  notes,
  written,
  verify,
}, ok ? 0 : 1)
