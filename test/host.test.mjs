// dsh-model-hub — 宿主侧桩宿主集成测试（零依赖）。
//
// 运行：在 dsh-model-hub/ 下 `node --test test/`
//
// 只依赖 node 内置 test runner + assert。桩 ctx 写在文件里，不依赖真实 DSH：
// 这样 CI/分发时不需要装 DSH，也能证明'写入 → 生效 → 校验 → 还原'这条链路。
// 真实宿主的端到端证据由 POST /model-hub/api/selftest 在装好插件后产出。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 偏好写进临时目录：绝不碰真实 ~/.dsh。每个用例用 freshPrefsHome() 再换一个目录，
// 所以用例之间没有顺序依赖。
process.env.DSH_MODEL_HUB_HOME = mkdtempSync(join(tmpdir(), 'dsh-model-hub-test-'))
process.env.DSH_HOME = process.env.DSH_MODEL_HUB_HOME

const { applyModelPatch } = await import('../lib/host/apply.js')
const { buildCatalog, applyOrder } = await import('../lib/host/catalog.js')
const { runSelftest, materializeCall } = await import('../lib/host/selftest.js')
const { pickPatch, buildOps, describeSettings, writeModelPatch, normalizeInputModalities, normalizeReasoningEfforts } = await import('../lib/host/settings-bridge.js')
const { setupRoutes } = await import('../lib/host/routes.js')
const prefsMod = await import('../lib/host/prefs.js')

function freshPrefsHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-hub-prefs-'))
  process.env.DSH_MODEL_HUB_HOME = dir
  return dir
}

/** 把 settings 的 path-op 应用到一棵配置树上（模拟 dsh-settings 的 applyPathOp 语义）。 */
function applyOp(root, op) {
  const path = op.path
  let node = root
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i]
    if (node[key] === undefined || node[key] === null || typeof node[key] !== 'object') {
      node[key] = /^[0-9]+$/.test(path[i + 1]) ? [] : {}
    }
    node = node[key]
  }
  const last = path[path.length - 1]
  if (op.op === 'unset') {
    if (Array.isArray(node)) node.splice(Number(last), 1)
    else delete node[last]
    return
  }
  node[last] = structuredClone(op.value)
}

/**
 * 桩宿主。cfg = profile(user 层)，live = 已解析的运行时配置。
 * applyWrites=false 时只写 cfg 不动 live —— 用来制造'写盘成功但运行时没变'。
 */
function makeHost(options) {
  const applyWrites = (options || {}).applyWrites !== false
  const cfg = { providers: {
    alpha: { displayName: 'jia', api: 'openai-completions', baseURL: 'https://q.invalid/v1', apiKeyEnv: 'ALPHA_KEY', models: [
      { id: 'm-flash-1017', name: 'm-flash-1017', contextWindow: 262144, maxTokens: 32768, input: ['text'], reasoningEfforts: false },
    ] },
    beta: { displayName: 'yi', api: 'openai-completions', baseURL: 'https://s.invalid/v1', apiKeyEnv: 'BETA_API_KEY', models: [
      { id: 'm-glm', name: 'm-glm', contextWindow: 1048576, maxTokens: 128000, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' }, imagePixelBudget: 1568, imageMaxBytes: 1048576 },
    ] },
    gamma: { displayName: '无凭证', api: 'openai-completions', baseURL: 'https://n.invalid/v1', apiKeyEnv: 'MISSING', models: [
      { id: 'ghost-1', name: 'ghost-1', contextWindow: 131072, maxTokens: 8192, input: ['text'] },
    ] },
    delta: { displayName: '目录路由', api: 'openai-completions', baseURL: 'https://c.invalid/v1' },
  } }
  const live = structuredClone(cfg)
  // 只在 live 里存在的 provider：模拟 models 列表来自继承层。
  live.providers.inherited = { displayName: '继承层', api: 'openai-completions', baseURL: 'https://i.invalid/v1', models: [
    { id: 'inh-1', name: 'inh-1', contextWindow: 131072, maxTokens: 4096, input: ['text'] },
  ] }

  const audit = [];
  const counts = { describe: 0, mutate: 0, discover: 0 };
  let revision = 3;

  const settings = {
    describe() {
      counts.describe += 1;
      return [{ ns: 'llm-pi-ai', revision, applies: 'live', value: structuredClone(live), user: structuredClone(cfg), base: {} }];
    },
    async mutate(ns, ops, expected) {
      counts.mutate += 1;
      if (expected !== undefined && expected !== revision) {
        const err = new Error('conflict')
        err.name = 'SettingsConflictError'
        err.code = 'SETTINGS_CONFLICT'
        throw err
      }
      for (const op of ops) {
        audit.push(op)
        applyOp(cfg, op)
        if (applyWrites) applyOp(live, op)
      }
      revision += 1;
      return { ok: true };
    },
  };

  const llm = {
    listConfigurableProviders() {
      return Object.keys(live.providers).map((id) => ({
        provider: id,
        displayName: live.providers[id].displayName,
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', id],
        // declared:false = 出厂目录里已有（可作模板、且清空 models 合法）
        declared: id !== 'delta',
        ...(id === 'beta'
          ? { defaultBaseURL: 'https://s.invalid/v1', baseURLEnv: ['BETA_BASE_URL'], nativeAuth: { env: ['BETA_KEY'], oauth: false } }
          : {}),
      }));
    },
    // 桩 ctx.llm.discoverModels：模仿真实签名与失败码（dsh-llm/lib/index.js:1998）。
    async discoverModels(ns, request, signal) {
      counts.discover += 1;
      if (signal !== undefined && signal.aborted) {
        const err = new Error('aborted');
        err.code = 'ABORTED';
        throw err;
      }
      if (ns !== 'llm-pi-ai') {
        const err = new Error('no model discovery is registered for ' + ns);
        err.code = 'NO_DISCOVERY';
        throw err;
      }
      if ((request.provider ?? '') === '' && (request.baseURL ?? '') === '') {
        const err = new Error('model discovery needs a provider route or a baseURL');
        err.code = 'INVALID_DISCOVERY';
        throw err;
      }
      if (request.provider === 'gamma') {
        const err = new Error('https://n.example/v1/models answered 401; check the API key');
        err.code = 'DISCOVERY_FAILED';
        throw err;
      }
      const found = [
        { id: 'disc-a', name: 'Disc A', contextWindow: 131072, maxTokens: 32768, inputModalities: ['text'] },
        { id: 'disc-b', name: 'Disc B', inputModalities: ['text', 'image'] },
        { id: 'disc-a' },
      ];
      const seen = new Set();
      const models = [];
      for (const model of found) {
        if (typeof model.id !== 'string' || model.id === '' || seen.has(model.id)) continue;
        seen.add(model.id);
        models.push(model);
      }
      return models;
    },
    async listModels(provider) {
      const p = live.providers[provider]
      if (p === undefined || p.apiKeyEnv === 'MISSING') return []
      return (p.models || []).map((m) => ({ provider, id: m.id, name: m.name, inputModalities: [...m.input] }));
    },
    async resolveModelInfo(provider, model) {
      const p = live.providers[provider]
      if (p === undefined) {
        const err = new Error('no adapter for ' + provider)
        err.code = 'NO_ADAPTER'
        throw err;
      }
      const m = (p.models || []).find((entry) => entry.id === model)
      if (m === undefined) {
        const err = new Error('unknown model ' + model)
        err.code = 'UNKNOWN_MODEL'
        throw err;
      }
      const levels = m.reasoningEfforts === undefined || m.reasoningEfforts === false
        ? []
        : Object.keys(m.reasoningEfforts).map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) }));
      return {
        provider,
        id: model,
        name: m.name,
        inputModalities: [...m.input],
        context: { contextWindow: m.contextWindow },
        defaultMaxTokens: m.maxTokens,
        ...(levels.length > 0 ? { reasoning: { efforts: levels } } : {}),
      };
    },
    // 桩 prepareCall：模仿 ctx.llm.prepareCall 的物化语义 —— maxTokens 未显式给时用模型的
    // maxTokens 物化（并标记 adapterDefaults）。刻意带一个会抛的 stream 函数，用来证明
    // materializeCall 的白名单投影不会把 stream 泄漏进响应，也证明没人调用它。
    async prepareCall(config, signal) {
      if (signal !== undefined && signal.aborted) {
        const err = new Error('aborted')
        err.code = 'ABORTED'
        throw err
      }
      const p = live.providers[config.provider]
      const m = p === undefined ? undefined : (p.models || []).find((entry) => entry.id === config.model)
      if (m === undefined) {
        const err = new Error('no prepared route for ' + config.provider)
        err.code = 'NO_ADAPTER'
        throw err
      }
      const controls = { ...config }
      delete controls.provider
      delete controls.model
      const materialized = { provider: config.provider, model: config.model, ...controls }
      const adapterDefaults = {}
      if (materialized.maxTokens === undefined) {
        materialized.maxTokens = m.maxTokens
        adapterDefaults.maxTokens = true
      }
      return {
        config: materialized,
        retryPolicy: { maxRetries: 2 },
        adapterDefaults,
        context: { contextWindow: m.contextWindow },
        inputModalities: [...m.input],
        stream() { throw new Error('stream() must never be called by selftest') },
      }
    },
  };

  const ctx = {
    get(name) {
      if (name === 'settings') return settings;
      if (name === 'llm') return llm;
      if (name === 'credentials') return { async resolve(ref) { return ref === 'MISSING' ? undefined : { value: 'sk-test' } } };
      return undefined;
    },
  };

  return { ctx, cfg, live, audit, counts, getRevision: () => revision };
}

function fakeReq(method, body, headers) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    headers: headers || {},
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  };
}

function fakeRes(options) {
  const state = { status: 0, headers: undefined, body: undefined };
  const closeImmediately = options !== undefined && options.closeImmediately === true;
  return {
    state,
    // 真 ServerResponse 是 EventEmitter；closeImmediately 用来模拟客户端在处理中就断开。
    on(event, listener) {
      if (closeImmediately && event === 'close') listener();
    },
    writeHead(status, headers) { state.status = status; state.headers = headers },
    end(text) { state.body = text },
    json() { return state.body === undefined ? undefined : JSON.parse(state.body) },
  };
}

function mount(ctx) {
  const table = [];
  const fake = {
    get: ctx.get,
    webServer: { port: 57826, register(entry) { table.push(entry); return () => { const i = table.indexOf(entry); if (i >= 0) table.splice(i, 1) } } },
  };
  const dispose = setupRoutes(fake, {});
  return {
    table,
    dispose,
    async send(method, path, body, headers) {
      const entry = table.find((row) => row.path === path);
      assert.ok(entry !== undefined, 'missing route ' + path);
      const res = fakeRes();
      const resolved = headers === undefined && body !== undefined ? { 'content-type': 'application/json' } : headers;
      await entry.handler(fakeReq(method, body, resolved), res);
      return res;
    },
  };
}

// ---------------------------------------------------------------- catalog

test('catalog: 提供商与模型元数据来自运行时', async () => {
  freshPrefsHome();
  const { ctx } = makeHost();
  const cat = await buildCatalog(ctx, prefsMod.emptyPrefs());
  assert.equal(cat.ok, true);
  assert.equal(cat.providers.length, 5);

  const a2 = cat.providers.find((p) => p.id === 'alpha');
  assert.equal(a2.name, 'jia', 'name 取 displayName');
  assert.equal(a2.api, 'openai-completions');
  assert.equal(a2.baseURL, 'https://q.invalid/v1');
  assert.equal(a2.hasKey, true);
  assert.equal(a2.settingsNs, 'llm-pi-ai');
  assert.deepEqual(a2.models.map((m) => m.id), ['m-flash-1017']);
  assert.equal(a2.models[0].contextWindow, 262144);
  assert.equal(a2.models[0].maxTokens, 32768);
  assert.equal(a2.models[0].vision, false, 'input 无 image ⇒ vision=false');
  assert.deepEqual(a2.models[0].efforts, [], '无 reasoningEfforts ⇒ 不公布档位');
  assert.equal(a2.models[0].defaultEffort, null);
  assert.equal(a2.models[0].upstreamSupported, true);

  const beta = cat.providers.find((p) => p.id === 'beta');
  assert.equal(beta.models[0].vision, true);
  assert.deepEqual(
    beta.models[0].efforts,
    ['off', 'low', 'medium', 'high'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), label: id[0].toUpperCase() + id.slice(1) })),
    'efforts 只读，同时给 name(canonical) 与 label(旧契约)',
  );
});

test('catalog: hasKey 综合 listModels 与凭证；无凭证不隐藏模型', async () => {
  freshPrefsHome();
  const { ctx } = makeHost();
  const cat = await buildCatalog(ctx, prefsMod.emptyPrefs());
  const gamma = cat.providers.find((p) => p.id === 'gamma');
  assert.equal(gamma.hasKey, false, 'listModels 为空且 credentials 无值 ⇒ hasKey=false');
  assert.equal(gamma.models.length, 1, 'hasKey=false 也要列出模型供只读展示');
  assert.equal(gamma.models[0].id, 'ghost-1');
});

test('catalog: 空提供商目录明确失败，让客户端退回只读', async () => {
  freshPrefsHome();
  const ctx = { get: () => undefined };
  const cat = await buildCatalog(ctx, prefsMod.emptyPrefs());
  assert.equal(cat.ok, false);
  assert.equal(cat.code, 'NO_PROVIDER_DIRECTORY');
  assert.deepEqual(cat.providers, []);
});

test('catalog: order = 置顶 → order → 其余（DeepSeek 族提前）', () => {
  const ids = ['a', 'b', 'deepseek', 'c', 'deepseek-account'];
  assert.deepEqual(
    applyOrder(ids, { pinned: ['c'], order: ['b'], overrides: {} }),
    ['c', 'b', 'deepseek', 'deepseek-account', 'a'],
  );
  assert.deepEqual(applyOrder(ids, prefsMod.emptyPrefs()), ['deepseek', 'deepseek-account', 'a', 'b', 'c']);
  assert.deepEqual(applyOrder(ids, { pinned: ['nope'], order: ['alsonope'], overrides: {} }), ['deepseek', 'deepseek-account', 'a', 'b', 'c'], '未知 id 被忽略');
});

// ---------------------------------------------------------------- 写入

test('写入 maxTokens：ops 路径落在 profile 声明的 models 索引上，且运行时同步变化', async () => {
  const host = makeHost();
  const r = await applyModelPatch(host.ctx, 'alpha', 'm-flash-1017', { maxTokens: 65536 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.before.maxTokens, 32768, '改前');
  assert.equal(r.effective.maxTokens, 65536, '改后（运行时读回）');
  assert.equal(r.verify.maxTokens, true);
  assert.equal(r.layer, 'models');
  assert.equal(r.written, true);
  assert.deepEqual(r.ops, [{ op: 'set', path: ['providers', 'alpha', 'models', '0', 'maxTokens'], value: 65536 }]);
  assert.equal(host.getRevision(), 4, 'mutate 后 revision 前进');
});

test('写入 vision：true 写 [text,image]，false 必须写 [text] 而不是 []', async () => {
  const host = makeHost();
  const on = await applyModelPatch(host.ctx, 'alpha', 'm-flash-1017', { vision: true });
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.deepEqual(host.audit[0].value, ['text', 'image']);
  assert.equal(on.effective.vision, true);

  const off = await applyModelPatch(host.ctx, 'alpha', 'm-flash-1017', { vision: false });
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.deepEqual(host.audit[1].value, ['text'], '空数组会被 pi-ai 当未声明，必须显式 [text]');
  assert.equal(off.effective.vision, false);
});

test('写入 contextWindow 与多字段组合', async () => {
  const host = makeHost();
  const r = await applyModelPatch(host.ctx, 'beta', 'm-glm', { contextWindow: 262144, maxTokens: 65536, vision: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.effective.contextWindow, 262144);
  assert.equal(r.effective.maxTokens, 65536);
  assert.equal(r.effective.vision, false);
  assert.equal(r.ops.length, 5, 'vision:false 还要 unset 两个 image* 字段');
  assert.deepEqual(r.ops.slice(3), [
    { op: 'unset', path: ['providers', 'beta', 'models', '0', 'imagePixelBudget'] },
    { op: 'unset', path: ['providers', 'beta', 'models', '0', 'imageMaxBytes'] },
  ]);
});

test('写盘成功但运行时没变 ⇒ NOT_EFFECTIVE（不假装成功）', async () => {
  const host = makeHost({ applyWrites: false });
  const r = await applyModelPatch(host.ctx, 'alpha', 'm-flash-1017', { maxTokens: 999 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_EFFECTIVE');
  assert.deepEqual(r.pending, ['maxTokens']);
  assert.equal(r.before.maxTokens, 32768, '失败时也要给客户端回滚用的原值');
  assert.equal(r.effective.maxTokens, 32768);
});

test('未知提供商 / 未知模型 / 继承层 models 都有明确失败码', async () => {
  const host = makeHost();
  const noProvider = await applyModelPatch(host.ctx, 'nope', 'x', { maxTokens: 1 });
  assert.equal(noProvider.code, 'UNKNOWN_PROVIDER');

  const noModel = await applyModelPatch(host.ctx, 'alpha', 'not-declared', { maxTokens: 1 });
  assert.equal(noModel.code, 'UNKNOWN_MODEL');

  const inherited = await applyModelPatch(host.ctx, 'inherited', 'inh-1', { maxTokens: 1 });
  assert.equal(inherited.code, 'INHERITED_MODELS', '按索引写继承层会生成坏结构，必须拒绝');
});

test('catalog 路由（profile 未声明 models）改走 modelOverrides', async () => {
  const host = makeHost();
  const written = await writeModelPatch(host.ctx, 'delta', 'gpt-x', { maxTokens: 4096 });
  assert.equal(written.layer, 'modelOverrides');
  assert.deepEqual(written.ops, [{ op: 'set', path: ['providers', 'delta', 'modelOverrides', 'gpt-x', 'maxTokens'], value: 4096 }]);
});

test('patch 白名单：efforts 被拒，类型错误被拒，字段路径只来自运行时发现', () => {
  assert.throws(() => pickPatch({ efforts: ['low'] }), (err) => err.code === 'UNSUPPORTED_FIELD');
  assert.throws(() => pickPatch({ ns: 'llm-pi-ai' }), (err) => err.code === 'UNSUPPORTED_FIELD');
  assert.throws(() => pickPatch(null), (err) => err.code === 'INVALID_PATCH');
  assert.throws(() => buildOps('p', ['providers', 'p'], { contextWindow: 0 }), (err) => err.code === 'INVALID_CONTEXT_WINDOW');
  assert.throws(() => buildOps('p', ['providers', 'p'], { maxTokens: 1.5 }), (err) => err.code === 'INVALID_MAX_TOKENS');
  assert.throws(() => buildOps('p', ['providers', 'p'], { vision: 'yes' }), (err) => err.code === 'INVALID_VISION');
  assert.deepEqual(pickPatch({ maxTokens: 8, ignored: undefined }), { maxTokens: 8 }, 'undefined 值的键视为不存在');
  assert.throws(() => pickPatch({ maxTokens: 8, ignored: 1 }), (err) => err.code === 'UNSUPPORTED_FIELD', '带真实值的未知键仍要拒绝');
});

test('settings 服务缺失时给出 SETTINGS_UNAVAILABLE，而不是静默失败', async () => {
  const ctx = {
    get(name) {
      if (name === 'llm') return { listConfigurableProviders() { return [{ provider: 'p', displayName: 'P', settingsNs: 'ns', settingsPath: ['providers', 'p'] }] } };
      return undefined;
    },
  };
  const r = await applyModelPatch(ctx, 'p', 'm', { maxTokens: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SETTINGS_UNAVAILABLE');
});

// ---------------------------------------------------------------- selftest

test('selftest：before/after/diff 且默认逐字节还原', async () => {
  const host = makeHost();
  const snapshot = JSON.stringify(host.cfg.providers.alpha.models[0]);
  const r = await runSelftest(host.ctx, { provider: 'alpha', model: 'm-flash-1017', patch: { contextWindow: 1000000, maxTokens: 128000 } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.changed, true);
  assert.deepEqual(r.diff.map((d) => d.field).sort(), ['contextWindow', 'maxTokens']);
  assert.equal(r.diff.every((d) => d.after !== d.before), true);
  assert.equal(r.before.contextWindow, 262144);
  assert.equal(r.after.contextWindow, 1000000);
  assert.equal(r.beforeConfigured.maxTokens, 32768);
  assert.equal(r.restoredCleanly, true, JSON.stringify(r.restoreDiff));
  assert.deepEqual(r.restoreDiff, []);
  assert.equal(JSON.stringify(host.cfg.providers.alpha.models[0]), snapshot, '还原后 profile 必须逐字节相同');
});

test('selftest：restore=false 时保留改动，便于人工查看现场', async () => {
  const host = makeHost();
  const r = await runSelftest(host.ctx, { provider: 'beta', model: 'm-glm', patch: { maxTokens: 4096 }, restore: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, undefined);
  assert.equal(r.after.maxTokens, 4096);
  assert.equal(host.cfg.providers.beta.models[0].maxTokens, 4096);
});

test('selftest：还原会 unset 原本不存在的字段，而不是留下 null', async () => {
  const host = makeHost();
  assert.equal(Object.hasOwn(host.cfg.providers.alpha.models[0], 'reasoningEfforts'), true);
  delete host.cfg.providers.alpha.models[0].contextWindow;
  delete host.live.providers.alpha.models[0].contextWindow;
  const r = await runSelftest(host.ctx, { provider: 'alpha', model: 'm-flash-1017', patch: { maxTokens: 2048 } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restoredCleanly, true, JSON.stringify(r.restoreDiff));
  assert.equal(Object.hasOwn(host.cfg.providers.alpha.models[0], 'contextWindow'), false, '原本没有的字段还原后也不该存在');
});

// ---------------------------------------------------------------- TTL

test('describeSettings：ttlMs>0 复用缓存，ttlMs=0 每次重新读取', () => {
  const host = makeHost();
  const first = describeSettings(host.ctx, { ttlMs: 300 });
  const calls = host.counts.describe;
  const second = describeSettings(host.ctx, { ttlMs: 300 });
  assert.equal(host.counts.describe, calls, 'TTL 内不应再次调用 settings.describe');
  assert.equal(second, first, 'TTL 内应返回同一张表');
  describeSettings(host.ctx, { ttlMs: 0 });
  assert.equal(host.counts.describe, calls + 1, 'ttlMs=0 必须重新读取');
});

test('写路径不读缓存：revision 是 mutate 的 CAS 前置条件', async () => {
  const host = makeHost();
  describeSettings(host.ctx, { ttlMs: 300 });
  const calls = host.counts.describe;
  const r = await applyModelPatch(host.ctx, 'alpha', 'm-flash-1017', { maxTokens: 65536 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(host.counts.describe > calls, '写路径必须重新 describe 取新鲜 revision');
});

test('写成功后读缓存被作废，下一次读拿到新目录', async () => {
  const host = makeHost();
  describeSettings(host.ctx, { ttlMs: 300 });
  await applyModelPatch(host.ctx, 'alpha', 'm-flash-1017', { maxTokens: 65536 });
  const calls = host.counts.describe;
  describeSettings(host.ctx, { ttlMs: 300 });
  assert.equal(host.counts.describe, calls + 1, '写后第一次读必须重新 describe');
});

test('revision 冲突会被重试并最终成功', async () => {
  const host = makeHost();
  let firstAttempt = true;
  const realMutate = host.ctx.get('settings').mutate;
  host.ctx.get('settings').mutate = async (ns, ops, expected) => {
    if (firstAttempt) {
      firstAttempt = false;
      const err = new Error('conflict');
      err.name = 'SettingsConflictError';
      throw err;
    }
    return realMutate(ns, ops, expected);
  };
  const r = await applyModelPatch(host.ctx, 'alpha', 'm-flash-1017', { maxTokens: 65536 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.effective.maxTokens, 65536);
});

// ---------------------------------------------------------------- routes

test('routes：注册 11 条（v1.5 又加了 client-state），dispose 后清空', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  assert.deepEqual(
    m.table.map((e) => e.path).sort(),
    [
      '/model-hub/api/catalog',
      '/model-hub/api/client-state',
      '/model-hub/api/health',
      '/model-hub/api/model',
      '/model-hub/api/prefs',
      '/model-hub/api/provider',
      '/model-hub/api/provider-templates',
      '/model-hub/api/provider/discover',
      '/model-hub/api/provider/model-remove',
      '/model-hub/api/provider/models',
      '/model-hub/api/selftest',
    ],
  );
  m.dispose();
  assert.equal(m.table.length, 0);
});

test('routes：health / catalog', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const health = await m.send('GET', '/model-hub/api/health');
  assert.equal(health.state.status, 200);
  assert.equal(health.json().ok, true);
  assert.equal(health.json().hasLlm, true);
  assert.equal(health.json().hasSettings, true);
  assert.equal(health.json().prefsPath.startsWith(process.env.DSH_MODEL_HUB_HOME), true, 'prefs 落在注入目录');
  const cat = await m.send('GET', '/model-hub/api/catalog');
  assert.equal(cat.json().ok, true);
  assert.equal(cat.json().providers.length, 5);
  m.dispose();
});

test('routes：写接口的 405 / 415 守卫', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const wrongMethod = await m.send('GET', '/model-hub/api/model');
  assert.equal(wrongMethod.state.status, 405);
  assert.equal(wrongMethod.json().ok, false);
  const noType = await m.send('POST', '/model-hub/api/model', { provider: 'alpha', model: 'm-flash-1017', patch: { maxTokens: 1 } }, {});
  assert.equal(noType.state.status, 415, '缺 content-type 挡跨站表单');
  assert.equal(noType.json().code, 'UNSUPPORTED_MEDIA_TYPE');
  const wrongMethodPrefs = await m.send('PUT', '/model-hub/api/prefs', undefined, {});
  assert.equal(wrongMethodPrefs.state.status, 405);
  m.dispose();
});

test('routes：POST /model 返回 effective 与 appliedVia', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const res = await m.send('POST', '/model-hub/api/model', { provider: 'alpha', model: 'm-flash-1017', patch: { maxTokens: 262144, vision: true } });
  const body = res.json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.effective.maxTokens, 262144);
  assert.equal(body.effective.vision, true);
  assert.equal(body.before.maxTokens, 32768);
  assert.deepEqual(body.verify, { maxTokens: true, vision: true });
  assert.equal(body.appliedVia.ns, 'llm-pi-ai');
  assert.equal(body.appliedVia.layer, 'models');
  assert.deepEqual(body.appliedVia.settingsPath, ['providers', 'alpha', 'models', '0']);
  assert.ok(Array.isArray(body.effective.efforts), 'effective 仍带只读 efforts');
  m.dispose();
});

test('routes：POST /model 失败时给出 code 与回滚用的原值', async () => {
  freshPrefsHome();
  const host = makeHost({ applyWrites: false });
  const m = mount(host.ctx);
  const body = (await m.send('POST', '/model-hub/api/model', { provider: 'alpha', model: 'm-flash-1017', patch: { maxTokens: 999 } })).json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'NOT_EFFECTIVE');
  assert.equal(body.before.maxTokens, 32768);
  m.dispose();
});

test('routes：patch 缺字段 / 非对象被拒', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const noPatch = (await m.send('POST', '/model-hub/api/model', { provider: 'alpha', model: 'm-flash-1017' })).json();
  assert.equal(noPatch.ok, false);
  assert.equal(noPatch.code, 'INVALID_PATCH');
  const badField = (await m.send('POST', '/model-hub/api/model', { provider: 'alpha', model: 'x', patch: { efforts: ['low'] } })).json();
  assert.equal(badField.code, 'UNSUPPORTED_FIELD');
  const noProvider = (await m.send('POST', '/model-hub/api/model', { model: 'x', patch: { maxTokens: 1 } })).json();
  assert.equal(noProvider.code, 'INVALID_REQUEST');
  m.dispose();
});

test('routes：prefs GET/POST 与校验', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const initial = (await m.send('GET', '/model-hub/api/prefs')).json();
  assert.deepEqual(initial.prefs, { order: [], pinned: [], overrides: {}, pendingProviders: {} });
  const saved = (await m.send('POST', '/model-hub/api/prefs', { order: ['beta', 'alpha'], pinned: ['beta'] })).json();
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.prefs.order, ['beta', 'alpha']);
  assert.deepEqual(saved.prefs.pinned, ['beta']);
  const reread = (await m.send('GET', '/model-hub/api/prefs')).json();
  assert.deepEqual(reread.prefs.order, ['beta', 'alpha'], '落盘后可再读');
  const badOrder = await m.send('POST', '/model-hub/api/prefs', { order: 'beta' });
  assert.equal(badOrder.state.status, 400);
  assert.equal(badOrder.json().code, 'INVALID_ORDER');
  m.dispose();
});

test('routes：POST /model 成功后 prefs.overrides 记录覆盖', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  await m.send('POST', '/model-hub/api/model', { provider: 'alpha', model: 'm-flash-1017', patch: { maxTokens: 262144 } });
  const prefs = (await m.send('GET', '/model-hub/api/prefs')).json().prefs;
  assert.equal(prefs.overrides['alpha/m-flash-1017'].maxTokens, 262144);
  m.dispose();
});

test('routes：POST /selftest 走完整 before/after/restore', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const body = (await m.send('POST', '/model-hub/api/selftest', { provider: 'beta', model: 'm-glm', patch: { maxTokens: 65536 } })).json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.deepEqual(body.diff, [{ field: 'maxTokens', before: 128000, after: 65536 }]);
  assert.equal(body.restoredCleanly, true);
  assert.equal(body.settingsPath.at(-1), '0');
  assert.equal(body.afterPrepared.config.maxTokens, 65536, 'task-4：响应必须带请求级物化结果');
  assert.equal(body.changedRequest, true);
  assert.deepEqual(body.requestDiff, [{ field: 'maxTokens', before: 128000, after: 65536 }]);
  m.dispose();
});

// ---------------------------------------------------------------- prefs 文件

test('prefs：原子写 + 形状收敛 + 往返一致', async () => {
  const dir = freshPrefsHome();
  const saved = await prefsMod.savePrefs({ order: ['a'], pinned: ['b'], overrides: { 'a/m': { maxTokens: 5 } }, junk: 1 });
  assert.equal(saved.junk, undefined, '未声明字段被丢弃');
  assert.deepEqual(saved.order, ['a']);
  const back = await prefsMod.readPrefs();
  assert.deepEqual(back, saved);
  assert.equal(prefsMod.prefsPath(), join(dir, 'prefs.json'), 'DSH_MODEL_HUB_HOME 直接指定数据目录');
  assert.deepEqual(prefsMod.emptyPrefs(), { order: [], pinned: [], overrides: {}, pendingProviders: {} });
});

test('prefs：坏文件不抛异常，退化成空偏好', async () => {
  const dir = freshPrefsHome();
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prefs.json'), '{ this is not json', 'utf8');
  assert.deepEqual(await prefsMod.readPrefs(), prefsMod.emptyPrefs());
});

test('prefs：并发写不互相覆盖（串行队列）', async () => {
  freshPrefsHome();
  await Promise.all([
    prefsMod.savePrefs({ order: ['x'], pinned: [], overrides: {} }),
    prefsMod.savePrefs({ order: ['y'], pinned: [], overrides: {} }),
    prefsMod.savePrefs({ order: ['z'], pinned: [], overrides: {} }),
  ]);
  const back = await prefsMod.readPrefs();
  assert.deepEqual(back.order, ['z'], '最后一次写入胜出，文件不是半个 JSON');
});

// ---------------------------------------------------------------- task-4 请求级证据

test('selftest 请求级证据：prepareCall 物化后的 maxTokens 随写入变化，且与 after 一致', async () => {
  freshPrefsHome();
  const host = makeHost();
  const r = await runSelftest(host.ctx, { provider: 'beta', model: 'm-glm', patch: { maxTokens: 65536 } });
  assert.equal(r.ok, true, JSON.stringify(r));

  // 请求级：这才是下一次请求真正会用上的值
  assert.equal(r.beforePrepared.config.maxTokens, 128000, '改前物化后的请求 maxTokens');
  assert.equal(r.afterPrepared.config.maxTokens, 65536, '改后物化后的请求 maxTokens');
  assert.deepEqual(r.requestDiff, [{ field: 'maxTokens', before: 128000, after: 65536 }]);
  assert.equal(r.changedRequest, true);

  // afterPrepared 与 after 的一致性关系：两层证据必须说同一件事
  assert.equal(r.afterPrepared.config.maxTokens, r.after.maxTokens, '请求 maxTokens 必须等于元数据 maxTokens');
  assert.equal(r.afterPrepared.context.contextWindow, r.after.contextWindow);
  assert.deepEqual(r.afterPrepared.inputModalities, r.after.inputModalities);
  assert.equal(r.beforePrepared.context.contextWindow, r.before.contextWindow);
  assert.deepEqual(r.beforePrepared.inputModalities, r.before.inputModalities);

  // 还原后请求参数也要回到原值
  assert.equal(r.restoredPrepared.config.maxTokens, 128000);
  assert.deepEqual(r.restoreRequestDiff, []);
  assert.equal(r.restoredCleanlyRequest, true);
  assert.equal(r.restoredCleanly, true);
});

test('vision 写入在请求层也立刻反映：inputModalities 从 [text,image] 变成 [text]', async () => {
  freshPrefsHome();
  const host = makeHost();
  const r = await runSelftest(host.ctx, { provider: 'beta', model: 'm-glm', patch: { vision: false } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.beforePrepared.inputModalities, ['text', 'image']);
  assert.deepEqual(r.afterPrepared.inputModalities, ['text']);
  assert.deepEqual(r.after.inputModalities, ['text'], '两层证据一致');
  assert.equal(r.requestDiff.length, 1);
  assert.equal(r.requestDiff[0].field, 'inputModalities');
  assert.equal(r.restoredCleanlyRequest, true);
});

test('prepareCall 结果只投影白名单：stream / retryPolicy 不泄漏进响应', async () => {
  freshPrefsHome();
  const host = makeHost();
  const r = await runSelftest(host.ctx, { provider: 'beta', model: 'm-glm', patch: { maxTokens: 4096 } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(Object.hasOwn(r.afterPrepared, 'stream'), false);
  assert.equal(Object.hasOwn(r.afterPrepared, 'retryPolicy'), false, 'retryPolicy 也不投影');
  assert.equal(JSON.stringify(r).includes('stream'), false, '整个响应里不能出现 stream');
});

test('prepareCall 抛错时给 prepareError，不影响写入结论', async () => {
  freshPrefsHome();
  const host = makeHost();
  host.ctx.get('llm').prepareCall = async () => {
    const err = new Error('prep boom');
    err.code = 'PREPARE_BOOM';
    throw err;
  };
  const r = await runSelftest(host.ctx, { provider: 'alpha', model: 'm-flash-1017', patch: { maxTokens: 65536 } });
  assert.equal(r.ok, true, '写入结论不受 prepareCall 影响');
  assert.equal(r.after.maxTokens, 65536, '元数据层照常生效');
  assert.equal(r.afterPrepared.prepareError.code, 'PREPARE_BOOM');
  assert.equal(typeof r.afterPrepared.prepareError.message, 'string');
  assert.deepEqual(r.requestDiff, [], '读不到请求参数就不比');
  assert.equal(r.restoredCleanly, true);
});

test('llm 没有 prepareCall 时给 PREPARE_CALL_UNAVAILABLE，而不是抛', async () => {
  freshPrefsHome();
  const host = makeHost();
  host.ctx.get('llm').prepareCall = undefined;
  const r = await runSelftest(host.ctx, { provider: 'alpha', model: 'm-flash-1017', patch: { maxTokens: 65536 } });
  assert.equal(r.ok, true);
  assert.equal(r.afterPrepared.prepareError.code, 'PREPARE_CALL_UNAVAILABLE');
});

test('★ AbortSignal 只影响 prepareCall 读取，绝不跳过写入与还原', async () => {
  freshPrefsHome();
  const host = makeHost();
  const snapshot = JSON.stringify(host.cfg.providers.alpha.models[0]);
  const controller = new AbortController();
  controller.abort();
  const r = await runSelftest(host.ctx, {
    provider: 'alpha',
    model: 'm-flash-1017',
    patch: { maxTokens: 65536 },
    signal: controller.signal,
  });
  assert.equal(r.beforePrepared.prepareError.code, 'ABORTED');
  assert.equal(r.afterPrepared.prepareError.code, 'ABORTED');
  assert.equal(r.ok, true, '取消请求参数读取不等于取消整次自测');
  assert.equal(r.after.maxTokens, 65536, '元数据层仍完成了写入');
  assert.equal(r.restoredCleanly, true, '取消绝不跳过还原');
  assert.deepEqual(r.restoreDiff, []);
  assert.equal(JSON.stringify(host.cfg.providers.alpha.models[0]), snapshot, '配置逐字节复原');
  assert.equal(r.restoredCleanlyRequest, true);
});

test('materializeCall：白名单投影、可取消、路由缺失有码', async () => {
  const host = makeHost();
  const ok = await materializeCall(host.ctx, 'beta', 'm-glm');
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(
    Object.keys(ok.value).sort(),
    ['adapterDefaults', 'config', 'context', 'inputModalities', 'model', 'provider', 'systemPromptUpdate', 'toolUpdate'],
  );
  assert.equal(ok.value.provider, 'beta', '身份取自 config（真实 prepareCall 没有顶层 provider）');
  assert.equal(ok.value.model, 'm-glm');
  assert.equal(ok.value.config.provider, 'beta');
  assert.equal(ok.value.config.model, 'm-glm');
  assert.equal(ok.value.config.maxTokens, 128000, '未显式给 maxTokens 时被物化成模型值');
  assert.deepEqual(ok.value.adapterDefaults, { maxTokens: true }, '标记该字段来自适配器默认');

  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await materializeCall(host.ctx, 'alpha', 'm-flash-1017', { signal: aborted.signal });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, 'ABORTED');

  const missing = await materializeCall(host.ctx, 'alpha', 'nope');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NO_ADAPTER');
});

test('materializeCall 支持显式 controls（例如指定 maxTokens 时不再物化默认）', async () => {
  const host = makeHost();
  const r = await materializeCall(host.ctx, 'alpha', 'm-flash-1017', { controls: { maxTokens: 999 } });
  assert.equal(r.ok, true);
  assert.equal(r.value.config.maxTokens, 999);
  assert.deepEqual(r.value.adapterDefaults, {}, '显式给了就不算适配器默认');
});

// ---------------------------------------------------------------- POST /model 的请求级证据

test('POST /model 响应带 prepared：下一次请求真正会用的参数', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const body = (await m.send('POST', '/model-hub/api/model', { provider: 'beta', model: 'm-glm', patch: { maxTokens: 65536 } })).json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.prepared.config.maxTokens, 65536, '物化后的请求 maxTokens');
  assert.equal(body.prepared.config.maxTokens, body.effective.maxTokens, '请求级与元数据级一致');
  assert.equal(body.prepared.provider, 'beta');
  assert.equal(body.prepared.model, 'm-glm');
  assert.equal(body.prepared.context.contextWindow, body.effective.contextWindow);
  assert.deepEqual(body.prepared.inputModalities, body.effective.inputModalities);
  assert.equal(Object.hasOwn(body.prepared, 'stream'), false, 'stream 不泄漏');
  assert.equal(JSON.stringify(body).includes('stream'), false);
  m.dispose();
});

test('prepareCall 失败不改变写入结论：ok 仍为 true，prepared 退化为 prepareError', async () => {
  freshPrefsHome();
  const host = makeHost();
  host.ctx.get('llm').prepareCall = async () => {
    const err = new Error('prep boom');
    err.code = 'PREPARE_BOOM';
    throw err;
  };
  const m = mount(host.ctx);
  const body = (await m.send('POST', '/model-hub/api/model', { provider: 'beta', model: 'm-glm', patch: { maxTokens: 65536 } })).json();
  assert.equal(body.ok, true, '写入结论仍然只看 verify / after');
  assert.deepEqual(body.verify, { maxTokens: true });
  assert.equal(body.effective.maxTokens, 65536, '写入确实生效');
  assert.equal(body.prepared.prepareError.code, 'PREPARE_BOOM');
  assert.equal(typeof body.prepared.prepareError.message, 'string');
  m.dispose();
});

test('★ 客户端在请求中途断开：只取消 prepared，写入与 verify 完全不受影响', async () => {
  freshPrefsHome();
  const host = makeHost();
  const table = [];
  const fake = {
    get: host.ctx.get,
    webServer: { port: 57826, register(entry) { table.push(entry); return () => {} } },
  };
  setupRoutes(fake, {});
  const entry = table.find((row) => row.path === '/model-hub/api/model');
  const res = fakeRes({ closeImmediately: true });
  await entry.handler(
    fakeReq('POST', { provider: 'beta', model: 'm-glm', patch: { maxTokens: 65536 } }, { 'content-type': 'application/json' }),
    res,
  );
  const body = res.json();
  assert.equal(body.prepared.prepareError.code, 'ABORTED', '证据读取被取消');
  assert.equal(body.ok, true, '取消证据读取不等于取消写入');
  assert.deepEqual(body.verify, { maxTokens: true });
  assert.equal(body.effective.maxTokens, 65536, '写入照常生效');
  assert.equal(host.cfg.providers.beta.models[0].maxTokens, 65536);
});

test('POST /model 早失败时 prepared 缺失（不强塞 prepareError）', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const body = (await m.send('POST', '/model-hub/api/model', { provider: 'nope', model: 'x', patch: { maxTokens: 1 } })).json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'UNKNOWN_PROVIDER');
  assert.equal(Object.hasOwn(body, 'prepared'), false, '写入都没走到，prepared 缺失即可');
  m.dispose();
});

// ---------------------------------------------------------------- verifier F1 / F2 回归

test('★ F2：reasoningEfforts 的改动必须体现在 diff / changed，不能沉默', async () => {
  freshPrefsHome();
  const host = makeHost();
  const r = await runSelftest(host.ctx, { provider: 'beta', model: 'm-glm', patch: { reasoningEfforts: null } });
  assert.equal(r.ok, true, JSON.stringify(r));

  // 运行时元数据层：efforts 由 [off,low,medium,high] 变空
  const effortsDiff = r.diff.find((entry) => entry.field === 'efforts');
  assert.notEqual(effortsDiff, undefined, 'efforts 变化必须进 diff');
  assert.deepEqual(effortsDiff.before, ['off', 'low', 'medium', 'high']);
  assert.deepEqual(effortsDiff.after, []);
  assert.equal(r.changed, true, '★ 成功的改动不能被判成什么都没发生');

  // 声明层：unset 必须以 field=reasoningEfforts、after=null 表达
  const declaredDiff = r.configuredDiff.find((entry) => entry.field === 'reasoningEfforts');
  assert.notEqual(declaredDiff, undefined, '声明层必须以 reasoningEfforts 表达 unset');
  assert.deepEqual(declaredDiff.before, { off: null, low: 'low', medium: 'medium', high: 'high' });
  assert.equal(declaredDiff.after, null, '删除声明 → after=null');
  assert.equal(r.changedConfigured, true);

  // F1 的一半：selftest 也要给声明层写后值
  assert.equal(Object.hasOwn(r, 'afterConfigured'), true);
  assert.equal(Object.hasOwn(r.afterConfigured, 'reasoningEfforts'), false, 'unset 后声明层没有该字段');
  assert.equal(Object.hasOwn(r, 'restoredConfigured'), true);

  // 还原两层都要干净
  assert.equal(r.restoredCleanly, true);
  assert.equal(r.restoredCleanlyConfigured, true, JSON.stringify(r.restoreConfiguredDiff));
  assert.deepEqual(r.restoreConfiguredDiff, []);
  assert.deepEqual(r.restoredConfigured.reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high' });
});

test('input 改动：元数据层用 inputModalities（不只是派生的 vision），声明层含两个 image* 的删除', async () => {
  freshPrefsHome();
  const host = makeHost();
  const r = await runSelftest(host.ctx, { provider: 'beta', model: 'm-glm', patch: { inputModalities: ['text'] } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.diff.map((entry) => entry.field).sort(), ['inputModalities', 'vision'], 'vision 保留兼容，inputModalities 是真实字段');
  const inputEntry = r.configuredDiff.find((entry) => entry.field === 'input');
  assert.deepEqual(inputEntry.before, ['text', 'image']);
  assert.deepEqual(inputEntry.after, ['text']);
  const budgetEntries = r.configuredDiff.filter((entry) => entry.field === 'imagePixelBudget' || entry.field === 'imageMaxBytes');
  assert.equal(budgetEntries.length, 2, '两个 image* 的删除也要在声明层 diff 里可见');
  assert.equal(budgetEntries.every((entry) => entry.after === null), true);
  assert.equal(r.changed, true);
  assert.equal(r.restoredCleanly, true);
  assert.equal(r.restoredCleanlyConfigured, true);
});

test('★ F1：POST /model 响应顶层真的有 declaredAfter（客户端免重拉 catalog）', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const body = (await m.send('POST', '/model-hub/api/model', { provider: 'beta', model: 'm-glm', patch: { reasoningEfforts: null } })).json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(Object.hasOwn(body, 'declaredAfter'), true, 'F1：响应顶层必须出现 declaredAfter');
  assert.equal(Object.hasOwn(body.declaredAfter, 'reasoningEfforts'), false, 'unset 后声明层没有该字段');
  assert.deepEqual(body.declaredAfter.input, ['text', 'image']);
  assert.equal(body.declaredAfter.maxTokens, 128000);
  m.dispose();
});

test('declaredAfter 在写入成功时反映新值；早失败时不出现', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const ok = (await m.send('POST', '/model-hub/api/model', { provider: 'beta', model: 'm-glm', patch: { inputModalities: ['text'], reasoningEfforts: { high: 'high' } } })).json();
  assert.deepEqual(ok.declaredAfter.input, ['text']);
  assert.deepEqual(ok.declaredAfter.reasoningEfforts, { high: 'high' });
  const failed = (await m.send('POST', '/model-hub/api/model', { provider: 'nope', model: 'x', patch: { maxTokens: 1 } })).json();
  assert.equal(failed.code, 'UNKNOWN_PROVIDER');
  assert.equal(Object.hasOwn(failed, 'declaredAfter'), false);
  m.dispose();
});


// ---------------------------------------------------------------- task-8 / 契约 v1.3

test('GET /provider-templates：协议枚举（源码顺序）+ 模板字段（含目录默认值）', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const body = (await m.send('GET', '/model-hub/api/provider-templates')).json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.protocols, ['openai-completions', 'openai-responses', 'anthropic-messages'], '顺序 = PROTOCOLS 键序');
  assert.equal(body.protocolDefault, 'openai-completions');
  const beta = body.templates.find((t) => t.provider === 'beta');
  assert.equal(beta.defaultBaseURL, 'https://s.invalid/v1');
  assert.deepEqual(beta.baseURLEnv, ['BETA_BASE_URL']);
  assert.deepEqual(beta.nativeAuth, { env: ['BETA_KEY'], oauth: false });
  assert.deepEqual(beta.settingsPath, ['providers', 'beta']);
  assert.equal(beta.declared, true);
  const builtin = body.templates.find((t) => t.provider === 'delta');
  assert.equal(builtin.declared, false, 'declared:false = 出厂目录里已有');
  const wrongMethod = await m.send('POST', '/model-hub/api/provider-templates');
  assert.equal(wrongMethod.state.status, 405);
  m.dispose();
});

test('★ POST /provider：保存待建草稿（绝不写 profile），catalog 里以 pending 出现', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const body = (await m.send('POST', '/model-hub/api/provider', {
    id: 'my-gw',
    displayName: '我的网关',
    api: 'openai-completions',
    baseURL: 'https://gw.example/v1',
    apiKeyEnv: 'MY_GW_KEY',
  })).json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.pending, true);
  assert.equal(body.declaredAfter, null, '还没有真实配置可回执');
  assert.equal(body.appliedVia.pending, true);
  assert.deepEqual(body.appliedVia.settingsPath, ['providers', 'my-gw'], '路径运行时发现，不硬编码');
  assert.equal(Object.hasOwn(host.cfg.providers, 'my-gw'), false, '★ 草稿阶段绝不碰 profile');

  const prefs = (await m.send('GET', '/model-hub/api/prefs')).json().prefs;
  assert.equal(prefs.pendingProviders['my-gw'].baseURL, 'https://gw.example/v1');
  assert.equal(prefs.pendingProviders['my-gw'].apiKeyEnv, 'MY_GW_KEY');

  const cat = (await m.send('GET', '/model-hub/api/catalog')).json();
  const row = cat.providers.find((p) => p.id === 'my-gw');
  assert.notEqual(row, undefined, '保存后立刻能在目录里看到');
  assert.equal(row.pending, true, '必须有显式 pending 标记');
  assert.deepEqual(row.models, []);
  assert.equal(row.name, '我的网关');
  assert.equal(row.api, 'openai-completions');
  assert.equal(row.baseURL, 'https://gw.example/v1');
  assert.equal(cat.order.includes('my-gw'), true, '排序也要含它');
  m.dispose();
});

test('POST /provider：id / 协议 / baseURL / 重名 都给明确 code 且不落盘', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const post = async (payload) => (await m.send('POST', '/model-hub/api/provider', payload)).json();
  assert.equal((await post({ id: 'Bad_ID', api: 'openai-completions', baseURL: 'https://x/v1' })).code, 'INVALID_PROVIDER_ID');
  assert.equal((await post({ id: '-bad', api: 'openai-completions', baseURL: 'https://x/v1' })).code, 'INVALID_PROVIDER_ID');
  assert.equal((await post({ id: 'ok-id', api: 'nope', baseURL: 'https://x/v1' })).code, 'INVALID_PROTOCOL');
  assert.equal((await post({ id: 'ok-id', api: 'openai-completions', baseURL: 'ftp://x' })).code, 'INVALID_BASE_URL');
  assert.equal((await post({ id: 'ok-id', api: 'openai-completions', baseURL: 'not-a-url' })).code, 'INVALID_BASE_URL');
  assert.equal((await post({ id: 'ok-id', api: 'openai-completions', baseURL: 'https://x/v1', displayName: '' })).code, 'INVALID_DISPLAY_NAME');
  assert.equal((await post({ id: 'beta', api: 'openai-completions', baseURL: 'https://x/v1' })).code, 'PROVIDER_EXISTS');
  const prefs = (await m.send('GET', '/model-hub/api/prefs')).json().prefs;
  assert.deepEqual(prefs.pendingProviders, {}, '被拒的请求不留草稿');
  m.dispose();
});

test('POST /provider {remove:true}：只删待建草稿，真实 provider 明确拒绝', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  await m.send('POST', '/model-hub/api/provider', { id: 'temp-gw', api: 'anthropic-messages', baseURL: 'https://t.example/v1' });
  const removed = (await m.send('POST', '/model-hub/api/provider', { id: 'temp-gw', remove: true })).json();
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  const prefs = (await m.send('GET', '/model-hub/api/prefs')).json().prefs;
  assert.equal(Object.hasOwn(prefs.pendingProviders, 'temp-gw'), false);

  const real = (await m.send('POST', '/model-hub/api/provider', { id: 'beta', remove: true })).json();
  assert.equal(real.code, 'PROVIDER_NOT_PENDING');
  assert.equal(Object.hasOwn(host.cfg.providers, 'beta'), true, '★ 绝不碰真实配置');
  const ghost = (await m.send('POST', '/model-hub/api/provider', { id: 'ghost-gw', remove: true })).json();
  assert.equal(ghost.code, 'PROVIDER_NOT_PENDING');
  m.dispose();
});

test('POST /provider/discover：转发 ctx.llm.discoverModels，映射字段并带出适配器错误码', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const body = (await m.send('POST', '/model-hub/api/provider/discover', {
    provider: 'my-gw',
    baseURL: 'https://gw.example/v1',
    api: 'openai-completions',
    apiKeyEnv: 'MY_GW_KEY',
  })).json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.ns, 'llm-pi-ai');
  assert.deepEqual(body.models.map((x) => x.id), ['disc-a', 'disc-b'], '去重后按端点顺序');
  assert.equal(body.models[0].contextWindow, 131072);
  assert.equal(body.models[0].maxTokens, 32768);
  assert.deepEqual(body.models[1].inputModalities, ['text', 'image']);
  assert.equal(host.counts.discover, 1);

  const none = await m.send('POST', '/model-hub/api/provider/discover', {});
  assert.equal(none.state.status, 400, '参数错误 = 400');
  assert.equal(none.json().code, 'INVALID_DISCOVERY');

  const refused = (await m.send('POST', '/model-hub/api/provider/discover', { provider: 'gamma', baseURL: 'https://n.example/v1' })).json();
  assert.equal(refused.ok, false, '适配器拒绝 = 结果，不是参数错误');
  assert.equal(refused.code, 'DISCOVERY_FAILED');
  assert.equal(refused.message.includes('401'), true);

  const badUrl = await m.send('POST', '/model-hub/api/provider/discover', { provider: 'x', baseURL: 'not-a-url' });
  assert.equal(badUrl.state.status, 400);
  assert.equal(badUrl.json().code, 'INVALID_BASE_URL');
  m.dispose();
});

test('★ POST /provider/models：待建草稿 + 勾选模型一次性原子落盘并清 pending', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  await m.send('POST', '/model-hub/api/provider', { id: 'my-gw', displayName: '我的网关', api: 'anthropic-messages', baseURL: 'https://gw.example/v1', apiKeyEnv: 'MY_GW_KEY' });
  const body = (await m.send('POST', '/model-hub/api/provider/models', {
    provider: 'my-gw',
    models: [{ id: 'm1', name: 'M1', contextWindow: 200000, maxTokens: 8192, input: ['image', 'text'] }, { id: 'm2' }],
  })).json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.count, 2);
  assert.equal(body.created, true);
  assert.equal(body.clearedPending, true);

  const created = host.cfg.providers['my-gw'];
  assert.equal(created.api, 'anthropic-messages');
  assert.equal(created.baseURL, 'https://gw.example/v1');
  assert.equal(created.apiKeyEnv, 'MY_GW_KEY');
  assert.deepEqual(created.models.map((x) => x.id), ['m1', 'm2']);
  assert.deepEqual(created.models[0].input, ['text', 'image'], 'input 归一化为 text→image');
  assert.deepEqual(body.declaredAfter.models.map((x) => x.id), ['m1', 'm2']);
  assert.deepEqual(body.appliedVia.settingsPath, ['providers', 'my-gw']);

  const prefs = (await m.send('GET', '/model-hub/api/prefs')).json().prefs;
  assert.equal(Object.hasOwn(prefs.pendingProviders, 'my-gw'), false, '落盘后清掉草稿');

  const cat = (await m.send('GET', '/model-hub/api/catalog')).json();
  const row = cat.providers.find((p) => p.id === 'my-gw');
  assert.equal(row.pending, undefined, '已经是真实 provider');
  assert.deepEqual(row.models.map((x) => x.id), ['m1', 'm2']);
  assert.equal(row.name, '我的网关');
  m.dispose();
});

test('POST /provider/models：已存在的 provider 覆盖写；清空对自定义路由被拦、对出厂路由合法', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const body = (await m.send('POST', '/model-hub/api/provider/models', {
    provider: 'beta',
    models: [{ id: 'm-glm' }, { id: 'm-glm-flash', maxTokens: 4096 }],
  })).json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.created, false);
  assert.deepEqual(host.cfg.providers.beta.models.map((x) => x.id), ['m-glm', 'm-glm-flash']);
  assert.deepEqual(body.declaredAfter.models.map((x) => x.id), ['m-glm', 'm-glm-flash']);

  const clear = await m.send('POST', '/model-hub/api/provider/models', { provider: 'beta', models: [] });
  assert.equal(clear.state.status, 400);
  assert.equal(clear.json().code, 'MODELS_REQUIRED', 'llm-pi-ai 拒绝无模型的自定义路由');

  const builtin = (await m.send('POST', '/model-hub/api/provider/models', { provider: 'delta', models: [] })).json();
  assert.equal(builtin.ok, true, '出厂目录路由清空 = 回落到目录模型');
  assert.equal(builtin.count, 0);
  assert.equal(Object.hasOwn(host.cfg.providers.delta, 'models'), false, '清空 = unset models');
  m.dispose();
});

test('POST /provider/models：models 校验与缺字段的明确 code', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const bad = async (models) => (await m.send('POST', '/model-hub/api/provider/models', { provider: 'beta', models })).json();
  assert.equal((await bad('nope')).code, 'INVALID_MODELS');
  assert.equal((await bad([{ id: '' }])).code, 'INVALID_MODELS');
  assert.equal((await bad([{ id: 'a' }, { id: 'a' }])).code, 'DUPLICATE_MODEL');
  assert.equal((await bad([{ id: 'a', input: ['audio'] }])).code, 'INVALID_MODELS');
  assert.equal((await bad([{ id: 'a', input: [] }])).code, 'INVALID_MODELS');
  assert.equal((await bad([{ id: 'a', maxTokens: 1.5 }])).code, 'INVALID_MODELS');
  assert.equal((await bad([{ id: 'a', contextWindow: 0 }])).code, 'INVALID_MODELS');
  assert.equal((await bad([{ id: 'a', name: '' }])).code, 'INVALID_MODELS');

  const orphan = (await m.send('POST', '/model-hub/api/provider/models', { provider: 'brand-new', models: [{ id: 'a' }] })).json();
  assert.equal(orphan.code, 'PROVIDER_FIELDS_REQUIRED', '未声明且无草稿 → 必须给 provider 字段');
  const emptyOrphan = (await m.send('POST', '/model-hub/api/provider/models', { provider: 'brand-new', models: [] })).json();
  assert.equal(emptyOrphan.code, 'MODELS_REQUIRED');
  m.dispose();
});

test('POST /provider/models 也接受显式 providerFields（不依赖草稿）', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const body = (await m.send('POST', '/model-hub/api/provider/models', {
    provider: 'direct-gw',
    models: [{ id: 'd1' }],
    providerFields: { displayName: '直连', api: 'openai-responses', baseURL: 'https://d.example/v1' },
  })).json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(host.cfg.providers['direct-gw'].api, 'openai-responses');
  assert.deepEqual(host.cfg.providers['direct-gw'].models.map((x) => x.id), ['d1']);
  m.dispose();
});

test('pending 草稿的删除/落盘都会反映到 catalog（不再出现）', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  await m.send('POST', '/model-hub/api/provider', { id: 'gone-gw', api: 'openai-completions', baseURL: 'https://g.example/v1' });
  let cat = (await m.send('GET', '/model-hub/api/catalog')).json();
  assert.notEqual(cat.providers.find((p) => p.id === 'gone-gw'), undefined);
  await m.send('POST', '/model-hub/api/provider', { id: 'gone-gw', remove: true });
  cat = (await m.send('GET', '/model-hub/api/catalog')).json();
  assert.equal(cat.providers.find((p) => p.id === 'gone-gw'), undefined, '删除后目录里不该再有它');
  m.dispose();
});


// ---------------------------------------------------------------- task-10 / 契约 v1.4

test('catalog 的 model.declared：声明层里有的为 true，仅运行时/目录带出的为 false', async () => {
  freshPrefsHome();
  const host = makeHost();
  const cat = await buildCatalog(host.ctx, prefsMod.emptyPrefs());
  const byId = (pid, mid) => cat.providers.find((p) => p.id === pid).models.find((m) => m.id === mid);
  assert.equal(byId('beta', 'm-glm').declared, true, 'profile 的 models[] 里声明过 ⇒ true');
  assert.equal(byId('gamma', 'ghost-1').declared, true);
  assert.equal(byId('alpha', 'm-flash-1017').declared, true);
  assert.equal(byId('inherited', 'inh-1').declared, false, '只在 live 层、profile 没声明过 ⇒ false');
  // declared 必须是严格布尔（客户端按键存在与否不敏感地渲染删除按钮）
  for (const provider of cat.providers) {
    for (const model of provider.models) assert.equal(typeof model.declared, 'boolean', provider.id + '/' + model.id);
  }
});

test('★ model-remove：删 models[] 一项后，**其余项逐字节原样保留**（不解析、不重写）', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  // 模拟用户手写的、我们不认识的键（走 /provider/models 会被 normalizeModels 剥掉，所以直接注入夹具）
  const hand1 = { id: 'm-extra', name: 'Extra', xUserNote: 'hand written', imagePixelBudget: 4242 };
  const hand2 = { id: 'm-note', xUserNote2: 'second', imagePixelMinSide: 99 };
  host.cfg.providers.beta.models.push(structuredClone(hand1), structuredClone(hand2));
  host.live.providers.beta.models.push(structuredClone(hand1), structuredClone(hand2));
  // beta = [m-glm（含 image 预算等未知键）, m-extra, m-note]

  const res = (await m.send('POST', '/model-hub/api/provider/model-remove', { provider: 'beta', model: 'm-glm' })).json();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.branch, 'models');
  assert.equal(res.removed, 'm-glm');
  assert.deepEqual(res.remaining, ['m-extra', 'm-note']);
  assert.deepEqual(host.cfg.providers.beta.models, [hand1, hand2], '★ 幸存项必须逐字节原样（手写的未知键一个都不能丢）');
  assert.equal(res.resolvableAfter, false, '自定义路由删掉后不该再能解析');

  const res2 = (await m.send('POST', '/model-hub/api/provider/model-remove', { provider: 'beta', model: 'm-extra' })).json();
  assert.equal(res2.ok, true, JSON.stringify(res2));
  assert.deepEqual(res2.remaining, ['m-note']);
  assert.deepEqual(host.cfg.providers.beta.models, [hand2], '★ 连续删除后仍原样保留');
  m.dispose();
});

test('★ model-remove：删掉自定义路由的最后一个模型 → MODELS_REQUIRED 且不写盘', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const before = JSON.stringify(host.cfg.providers.gamma);
  const res = await m.send('POST', '/model-hub/api/provider/model-remove', { provider: 'gamma', model: 'ghost-1' });
  assert.equal(res.state.status, 400);
  assert.equal(res.json().code, 'MODELS_REQUIRED', 'llm-pi-ai 拒绝无模型的自定义路由');
  assert.equal(JSON.stringify(host.cfg.providers.gamma), before, '★ 被拦下时绝不写盘');
  assert.equal(host.counts.mutate, 0, '压根没有发出 mutate');
  m.dispose();
});

test('★ model-remove：出厂目录路由允许删空（回落目录模型）', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  // delta 是 catalog-backed（declared:false）且原本没有 models；给它声明一个模型再删空
  host.cfg.providers.delta.models = [{ id: 'd1' }];
  host.live.providers.delta.models = [{ id: 'd1' }];
  const res = (await m.send('POST', '/model-hub/api/provider/model-remove', { provider: 'delta', model: 'd1' })).json();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.remaining, []);
  assert.deepEqual(host.cfg.providers.delta.models, [], '出厂路由可以清空');
  m.dispose();
});

test('model-remove：两边都没有 → MODEL_NOT_DECLARED（明确拒绝，绝不静默）', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const missing = (await m.send('POST', '/model-hub/api/provider/model-remove', { provider: 'beta', model: 'not-there' })).json();
  assert.equal(missing.code, 'MODEL_NOT_DECLARED');
  const inherited = (await m.send('POST', '/model-hub/api/provider/model-remove', { provider: 'inherited', model: 'inh-1' })).json();
  assert.equal(inherited.code, 'MODEL_NOT_DECLARED', '只在继承层出现的模型不算声明');
  const noProvider = (await m.send('POST', '/model-hub/api/provider/model-remove', { provider: 'nope', model: 'x' })).json();
  assert.equal(noProvider.code, 'UNKNOWN_PROVIDER');
  const noModel = (await m.send('POST', '/model-hub/api/provider/model-remove', { provider: 'beta' })).json();
  assert.equal(noModel.code, 'INVALID_REQUEST');
  m.dispose();
});

test('model-remove：modelOverrides 分支走 unset，并计入 remaining', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  host.cfg.providers.delta.modelOverrides = { 'ov-1': { contextWindow: 1000 }, 'ov-2': { maxTokens: 2000 } };
  host.live.providers.delta.modelOverrides = structuredClone(host.cfg.providers.delta.modelOverrides);
  const res = (await m.send('POST', '/model-hub/api/provider/model-remove', { provider: 'delta', model: 'ov-1' })).json();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.branch, 'modelOverrides');
  assert.deepEqual(res.ops, [{ op: 'unset', path: ['providers', 'delta', 'modelOverrides', 'ov-1'] }]);
  assert.equal(Object.hasOwn(host.cfg.providers.delta.modelOverrides, 'ov-1'), false);
  assert.deepEqual(res.remaining, ['ov-2'], '另一个 override 仍在声明层');
  m.dispose();
});

test('model-remove：删除立刻反映到 catalog（读缓存已作废，不会假失败）', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  // beta 原本只有 1 个模型；删它就会触发 llm-pi-ai 的硬约束，所以先补一个（这也证明删完还剩 ≥1 才允许）
  host.cfg.providers.beta.models.push({ id: 'm-second' });
  host.live.providers.beta.models.push({ id: 'm-second' });
  // 先读一次目录，把 300ms 读缓存灌满 —— 这正是最容易被缓存骗到的时序
  let cat = (await m.send('GET', '/model-hub/api/catalog')).json();
  assert.notEqual(cat.providers.find((p) => p.id === 'beta').models.find((x) => x.id === 'm-glm'), undefined);
  const res = (await m.send('POST', '/model-hub/api/provider/model-remove', { provider: 'beta', model: 'm-glm' })).json();
  assert.equal(res.ok, true, JSON.stringify(res));
  cat = (await m.send('GET', '/model-hub/api/catalog')).json();
  assert.equal(
    cat.providers.find((p) => p.id === 'beta').models.find((x) => x.id === 'm-glm'),
    undefined,
    '★ 删完必须立刻从目录里消失（否则用户看到的就是「点了删除没反应」）',
  );
  m.dispose();
});

test('model-remove 的 declaredAfter 反映写后声明层', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  host.cfg.providers.beta.models.push({ id: 'm-second' });
  host.live.providers.beta.models.push({ id: 'm-second' });
  const res = (await m.send('POST', '/model-hub/api/provider/model-remove', { provider: 'beta', model: 'm-second' })).json();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.declaredAfter.models.map((x) => x.id), ['m-glm']);
  assert.deepEqual(res.appliedVia === undefined ? null : res.appliedVia, null, '本端点不回 appliedVia（declaredAfter/ops 已足够）');
  m.dispose();
});


// ---------------------------------------------------------------- issue #1 诊断口

test('health 初始：clientState 为 null，pluginVersion 读得到', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const body = (await m.send('GET', '/model-hub/api/health')).json();
  assert.equal(body.clientState, null, '还没有任何上报');
  assert.equal(body.clientStateAgeMs, null);
  assert.equal(body.clientVersion, null);
  assert.equal(typeof body.pluginVersion, 'string');
  assert.equal(body.pluginVersion.length > 0, true, '宿主版本必须读得到（package.json）');
  // 既有字段一个都不能少（纯新增）
  for (const field of ['ok', 'name', 'prefix', 'enabled', 'prefsPath', 'hasLlm', 'hasSettings', 'webServerPort']) {
    assert.equal(Object.hasOwn(body, field), true, field);
  }
  m.dispose();
});

test('★ 上报 → health 能读到阶段、版本与距今年龄', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const posted = (await m.send('POST', '/model-hub/api/client-state', {
    stage: 'bundle-loaded',
    clientVersion: '0.1.0+abc1234',
    userAgent: 'Mozilla/5.0 (probe)',
    at: '2026-10-24T13:21:00.000Z',
  })).json();
  assert.deepEqual(posted, { ok: true, stored: true });

  const body = (await m.send('GET', '/model-hub/api/health')).json();
  assert.equal(body.clientState.stage, 'bundle-loaded');
  assert.equal(body.clientState.unknown, undefined, '白名单内的阶段不该被标 unknown');
  assert.equal(body.clientState.userAgent, 'Mozilla/5.0 (probe)');
  assert.equal(body.clientState.at, '2026-10-24T13:21:00.000Z', '客户端自报时间原样保留');
  assert.equal(body.clientVersion, '0.1.0+abc1234', '★ 浏览器里跑的是哪一版');
  assert.equal(typeof body.clientStateAgeMs, 'number');
  assert.equal(body.clientStateAgeMs >= 0 && body.clientStateAgeMs < 10000, true, '年龄按宿主接收时间算');
  m.dispose();
});

test('★ 三种失败状态可区分：bundle-loaded / apply-start(卡住) / slot-register-failed', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  // 场景一：bundle 加载了但 apply 没跑
  await m.send('POST', '/model-hub/api/client-state', { stage: 'bundle-loaded', clientVersion: '0.1.0+deadbee' });
  let health = (await m.send('GET', '/model-hub/api/health')).json();
  assert.equal(health.clientState.stage, 'bundle-loaded', '⇒ 能看出 apply 从未开始');
  // 场景二：apply 开始但等服务卡住
  await m.send('POST', '/model-hub/api/client-state', { stage: 'waiting-services', missing: ['slots', 'modelDirectories', 'slots'] });
  health = (await m.send('GET', '/model-hub/api/health')).json();
  assert.equal(health.clientState.stage, 'waiting-services');
  assert.deepEqual(health.clientState.missing, ['slots', 'modelDirectories'], '缺失服务去重后列出');
  assert.equal(health.clientVersion, '0.1.0+deadbee', '版本粘性：无版本的上报不抹掉它');
  // 场景三：槽位注册失败
  await m.send('POST', '/model-hub/api/client-state', { stage: 'slot-register-failed', error: 'duplicate slot conversation.input.model' });
  health = (await m.send('GET', '/model-hub/api/health')).json();
  assert.equal(health.clientState.stage, 'slot-register-failed');
  assert.equal(health.clientState.error.includes('duplicate slot'), true, '错误原文可读');
  assert.equal(health.clientVersion, '0.1.0+deadbee');
  m.dispose();
});

test('★ 容错：空体 / 坏 JSON / 非 JSON content-type / 未知 stage 一律 200', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);

  // 空体（无 body、无 content-type）
  const empty = await m.send('POST', '/model-hub/api/client-state');
  assert.equal(empty.state.status, 200);
  assert.deepEqual(empty.json(), { ok: true, stored: true });
  let health = (await m.send('GET', '/model-hub/api/health')).json();
  assert.equal(health.clientState.stage, 'unknown');
  assert.equal(health.clientState.unknown, true);

  // 非 JSON content-type（用户手敲 curl 的常见情况）
  const plain = await m.send('POST', '/model-hub/api/client-state', { stage: 'apply-ok' }, { 'content-type': 'text/plain' });
  assert.equal(plain.state.status, 200);
  assert.equal((await m.send('GET', '/model-hub/api/health')).json().clientState.stage, 'apply-ok');

  // 坏 JSON：直接打 handler，绕过 send 的 JSON.stringify
  const entry = m.table.find((row) => row.path === '/model-hub/api/client-state');
  const res = fakeRes();
  await entry.handler({
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from('{ this is not json'); },
  }, res);
  assert.equal(res.state.status, 200);
  assert.deepEqual(res.json(), { ok: true, stored: true });
  assert.equal((await m.send('GET', '/model-hub/api/health')).json().clientState.stage, 'unknown', '坏 JSON 退化成 unknown');

  // 未知 stage：原样保留 + unknown 标记（客户端可先上线）
  await m.send('POST', '/model-hub/api/client-state', { stage: 'brand-new-stage' });
  health = (await m.send('GET', '/model-hub/api/health')).json();
  assert.equal(health.clientState.stage, 'brand-new-stage', '原样保留');
  assert.equal(health.clientState.unknown, true, '但标记 unknown');

  // stage 不是字符串
  await m.send('POST', '/model-hub/api/client-state', { stage: 42 });
  health = (await m.send('GET', '/model-hub/api/health')).json();
  assert.equal(health.clientState.stage, 'unknown');
  assert.equal(health.clientState.unknown, true);

  // body 是数组
  await m.send('POST', '/model-hub/api/client-state', [1, 2, 3]);
  assert.equal((await m.send('GET', '/model-hub/api/health')).json().clientState.stage, 'unknown');
  m.dispose();
});

test('★ 多次上报取最新；error 超长被截断；诊断口不污染 prefs', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  await m.send('POST', '/model-hub/api/client-state', { stage: 'bundle-loaded' });
  await m.send('POST', '/model-hub/api/client-state', { stage: 'apply-start' });
  await m.send('POST', '/model-hub/api/client-state', { stage: 'apply-ok' });
  let health = (await m.send('GET', '/model-hub/api/health')).json();
  assert.equal(health.clientState.stage, 'apply-ok', '★ 取最新一次');

  const long = 'x'.repeat(5000);
  await m.send('POST', '/model-hub/api/client-state', { stage: 'apply-failed', error: long });
  health = (await m.send('GET', '/model-hub/api/health')).json();
  assert.equal(health.clientState.error.length <= 4010, true, '超长 error 必须截断，避免撑爆内存/响应');
  assert.equal(health.clientState.error.endsWith('（已截断）'), true);

  // 只存内存：prefs 完全不受影响
  const prefs = (await m.send('GET', '/model-hub/api/prefs')).json().prefs;
  assert.deepEqual(prefs, { order: [], pinned: [], overrides: {}, pendingProviders: {} }, '★ 诊断信息不写 prefs');
  m.dispose();
});

test('client-state 只收 POST；每个实例的状态互相隔离', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const wrong = await m.send('GET', '/model-hub/api/client-state');
  assert.equal(wrong.state.status, 405);
  await m.send('POST', '/model-hub/api/client-state', { stage: 'apply-ok' });
  assert.equal((await m.send('GET', '/model-hub/api/health')).json().clientState.stage, 'apply-ok');
  // 另一个实例（模拟插件重载）不该看到上一个实例的状态
  const m2 = mount(makeHost().ctx);
  const fresh = (await m2.send('GET', '/model-hub/api/health')).json();
  assert.equal(fresh.clientState, null, '状态按实例隔离，重载即复位');
  m.dispose();
  m2.dispose();
});
test('changed 只看值也成立；configuredDiff 在无声明层变化时为空', async () => {
  freshPrefsHome();
  const host = makeHost();
  const r = await runSelftest(host.ctx, { provider: 'beta', model: 'm-glm', patch: { maxTokens: 65536 } });
  assert.equal(r.changed, true);
  assert.equal(r.changedConfigured, true, 'maxTokens 也是声明层字段');
  assert.deepEqual(r.configuredDiff.map((entry) => entry.field), ['maxTokens']);
  assert.equal(r.changedRequest, true);
});


// ---------------------------------------------------------------- task-5 v1.2 能力字段

test('inputModalities 归一化：去重 / 固定 text→image 顺序 / 非空 / 白名单', () => {
  assert.deepEqual(normalizeInputModalities(['image', 'text']), ['text', 'image'], '顺序固定，与设置页一致');
  assert.deepEqual(normalizeInputModalities(['text', 'text', 'image']), ['text', 'image'], '去重');
  assert.deepEqual(normalizeInputModalities(['text']), ['text']);
  assert.deepEqual(normalizeInputModalities(['image']), ['image'], '设置页允许只留 image');
  for (const bad of [[], ['audio'], 'text', [1], null]) {
    assert.throws(() => normalizeInputModalities(bad), (err) => err.code === 'INVALID_INPUT_MODALITIES', JSON.stringify(bad));
  }
});

test('reasoningEfforts 校验：合法接受，非法一律 INVALID_REASONING_EFFORTS', () => {
  assert.deepEqual(normalizeReasoningEfforts({ off: null, low: 'low' }), { off: null, low: 'low' });
  assert.deepEqual(normalizeReasoningEfforts({ off: 'off', low: 'low' }), { off: 'off', low: 'low' }, 'off 带非空字符串合法（表示发送该值）');
  assert.deepEqual(normalizeReasoningEfforts({ high: 'xhigh' }), { high: 'xhigh' }, '不需要显式声明 off');
  assert.equal(normalizeReasoningEfforts(null), null, 'null = unset');
  const bad = [
    { off: null },
    {},
    { off: null, low: '' },
    { low: null },
    { low: 3 },
    ['low'],
    false,
    'low',
  ];
  for (const value of bad) {
    assert.throws(() => normalizeReasoningEfforts(value), (err) => err.code === 'INVALID_REASONING_EFFORTS', JSON.stringify(value));
  }
  // 已知限制：pi-ai 的 false（该模型不推理）不在契约 v1.2 里，错误信息必须指路（传 null 删除字段）。
  assert.throws(
    () => normalizeReasoningEfforts(false),
    (err) => err.code === 'INVALID_REASONING_EFFORTS' && err.message.includes('请传 null'),
    'false 的报错要说明替代做法',
  );
});

test('inputModalities 写入：写 profile 的 input，并同步到运行时与请求层', async () => {
  freshPrefsHome();
  const host = makeHost();
  const r = await applyModelPatch(host.ctx, 'beta', 'm-glm', { inputModalities: ['image', 'text'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.ops[0], { op: 'set', path: ['providers', 'beta', 'models', '0', 'input'], value: ['text', 'image'] });
  assert.equal(r.verify.inputModalities, true);
  assert.deepEqual(r.effective.inputModalities, ['text', 'image']);
  assert.deepEqual(r.declaredAfter.input, ['text', 'image'], '声明层已写入');
  assert.deepEqual(r.prepared.inputModalities, r.effective.inputModalities, 'prepareCall 与元数据一致');
});

test('取消 image 时同时删除 imagePixelBudget 与 imageMaxBytes（与设置页一致）', async () => {
  freshPrefsHome();
  const host = makeHost();
  assert.equal(host.cfg.providers.beta.models[0].imagePixelBudget, 1568);
  assert.equal(host.cfg.providers.beta.models[0].imageMaxBytes, 1048576);
  const r = await applyModelPatch(host.ctx, 'beta', 'm-glm', { inputModalities: ['text'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.ops, [
    { op: 'set', path: ['providers', 'beta', 'models', '0', 'input'], value: ['text'] },
    { op: 'unset', path: ['providers', 'beta', 'models', '0', 'imagePixelBudget'] },
    { op: 'unset', path: ['providers', 'beta', 'models', '0', 'imageMaxBytes'] },
  ]);
  assert.equal(Object.hasOwn(host.cfg.providers.beta.models[0], 'imagePixelBudget'), false);
  assert.equal(Object.hasOwn(host.cfg.providers.beta.models[0], 'imageMaxBytes'), false);
  assert.equal(r.effective.vision, false);
  assert.equal(r.verify.inputModalities, true);
});

test('保留 image 时不碰 image* 预算字段', async () => {
  freshPrefsHome();
  const host = makeHost();
  const r = await applyModelPatch(host.ctx, 'beta', 'm-glm', { inputModalities: ['image', 'text'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.ops.length, 1);
  assert.equal(Object.hasOwn(host.cfg.providers.beta.models[0], 'imagePixelBudget'), true, '保留 image 不该动预算字段');
});

test('reasoningEfforts 写入：运行时与声明层都生效', async () => {
  freshPrefsHome();
  const host = makeHost();
  const r = await applyModelPatch(host.ctx, 'beta', 'm-glm', { reasoningEfforts: { off: null, low: 'low', high: 'high' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.ops, [{
    op: 'set',
    path: ['providers', 'beta', 'models', '0', 'reasoningEfforts'],
    value: { off: null, low: 'low', high: 'high' },
  }]);
  assert.deepEqual(r.declaredAfter.reasoningEfforts, { off: null, low: 'low', high: 'high' });
  assert.equal(r.verify.reasoningEfforts, true);
  const ids = r.effective.efforts.map((entry) => entry.id);
  assert.equal(ids.includes('low'), true);
  assert.equal(ids.includes('high'), true);
  assert.equal(ids.includes('medium'), false, '未声明的档位不该出现');
});

test('reasoningEfforts: null 表示 unset —— 声明层字段消失才算生效', async () => {
  freshPrefsHome();
  const host = makeHost();
  assert.equal(Object.hasOwn(host.cfg.providers.beta.models[0], 'reasoningEfforts'), true);
  const r = await applyModelPatch(host.ctx, 'beta', 'm-glm', { reasoningEfforts: null });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.ops, [{ op: 'unset', path: ['providers', 'beta', 'models', '0', 'reasoningEfforts'] }]);
  assert.equal(Object.hasOwn(host.cfg.providers.beta.models[0], 'reasoningEfforts'), false);
  assert.equal(r.verify.reasoningEfforts, true);
  assert.deepEqual(r.effective.efforts, [], 'stub 里未声明后就没有档位');
});

test('非法能力值在写入前就被拒（不会碰 profile）', async () => {
  freshPrefsHome();
  const host = makeHost();
  const snapshot = JSON.stringify(host.cfg.providers.beta.models[0]);
  const badInput = await applyModelPatch(host.ctx, 'beta', 'm-glm', { inputModalities: [] });
  assert.equal(badInput.code, 'INVALID_INPUT_MODALITIES');
  const badEfforts = await applyModelPatch(host.ctx, 'beta', 'm-glm', { reasoningEfforts: { off: null } });
  assert.equal(badEfforts.code, 'INVALID_REASONING_EFFORTS');
  assert.equal(JSON.stringify(host.cfg.providers.beta.models[0]), snapshot, '被拒的请求不改 profile');
});

test('catalog 暴露 declared* 声明层原值；继承层与未声明时缺席', async () => {
  freshPrefsHome();
  const host = makeHost();
  const cat = await buildCatalog(host.ctx, prefsMod.emptyPrefs());
  const beta = cat.providers.find((p) => p.id === 'beta');
  assert.deepEqual(beta.models[0].declaredInputModalities, ['text', 'image']);
  assert.deepEqual(beta.models[0].declaredReasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high' });
  const a2 = cat.providers.find((p) => p.id === 'alpha');
  assert.deepEqual(a2.models[0].declaredInputModalities, ['text']);
  assert.equal(Object.hasOwn(a2.models[0], 'declaredReasoningEfforts'), false, 'fixture 里 alpha 声明的是 reasoningEfforts:false，不是 record');
  const inherited = cat.providers.find((p) => p.id === 'inherited');
  assert.equal(Object.hasOwn(inherited.models[0], 'declaredInputModalities'), false, '继承层没有声明过');
  assert.equal(Object.hasOwn(inherited.models[0], 'declaredReasoningEfforts'), false);
});

test('catalog 的 declared* 跟着写入变化（写后缓存已作废）', async () => {
  freshPrefsHome();
  const host = makeHost();
  await buildCatalog(host.ctx, prefsMod.emptyPrefs());
  await applyModelPatch(host.ctx, 'beta', 'm-glm', { inputModalities: ['text'] });
  const cat = await buildCatalog(host.ctx, prefsMod.emptyPrefs());
  const beta = cat.providers.find((p) => p.id === 'beta');
  assert.deepEqual(beta.models[0].declaredInputModalities, ['text']);
});

test('POST /model 支持 v1.2 字段，prepared 与 effective 一致', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  const body = (await m.send('POST', '/model-hub/api/model', {
    provider: 'beta',
    model: 'm-glm',
    patch: { inputModalities: ['text'], reasoningEfforts: { off: null, high: 'high' } },
  })).json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.deepEqual(body.verify, { inputModalities: true, reasoningEfforts: true });
  assert.deepEqual(body.effective.inputModalities, ['text']);
  assert.equal(body.effective.vision, false);
  assert.deepEqual(body.prepared.inputModalities, body.effective.inputModalities);
  assert.deepEqual(body.prepared.config, { provider: 'beta', model: 'm-glm', maxTokens: 128000 });
  m.dispose();
});

test('pickPatch 接受 v1.2 字段，未知字段仍然拒绝', () => {
  assert.deepEqual(pickPatch({ inputModalities: ['text'], reasoningEfforts: null }), { inputModalities: ['text'], reasoningEfforts: null });
  assert.throws(() => pickPatch({ imagePixelBudget: 1 }), (err) => err.code === 'UNSUPPORTED_FIELD');
  assert.throws(() => pickPatch({ reasoningEffort: 'high' }), (err) => err.code === 'UNSUPPORTED_FIELD', '单数形式不在契约里');
});

test('prefs.overrides 记录 v1.2 字段', async () => {
  freshPrefsHome();
  const host = makeHost();
  const m = mount(host.ctx);
  await m.send('POST', '/model-hub/api/model', { provider: 'beta', model: 'm-glm', patch: { inputModalities: ['text'], reasoningEfforts: { high: 'high' } } });
  const prefs = (await m.send('GET', '/model-hub/api/prefs')).json().prefs;
  assert.deepEqual(prefs.overrides['beta/m-glm'].inputModalities, ['text']);
  assert.deepEqual(prefs.overrides['beta/m-glm'].reasoningEfforts, { high: 'high' });
  m.dispose();
});

test('★ selftest 会还原被 unset 的 image* 与 reasoningEfforts（键集合与值都回到原样）', async () => {
  freshPrefsHome();
  const host = makeHost();
  const before = JSON.parse(JSON.stringify(host.cfg.providers.beta.models[0]));
  const r = await runSelftest(host.ctx, {
    provider: 'beta',
    model: 'm-glm',
    patch: { inputModalities: ['text'], reasoningEfforts: null },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restoredCleanly, true);
  assert.deepEqual(r.restoreRequestDiff, []);
  const after = host.cfg.providers.beta.models[0];
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), '键集合必须完全一致（含被删的两个 image* 与 reasoningEfforts）');
  // 用 deepEqual（不比较键顺序）：被删除再写回的键一定会被追加到末尾，
  // 所以这种情况只能保证『配置等价』，不能保证 YAML 字节序相同。
  assert.deepEqual(after, before, '被删的字段必须原值写回');
});



