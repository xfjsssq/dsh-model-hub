// dsh-model-hub — /model-hub/api/* 路由（宿主侧）。
//
// 挂载方式沿用 dsh-mobile-plus：ctx.webServer.register({kind:'exact', path, handler})。
// webServer.register 不看 HTTP 方法，所以每个 handler 自己判 req.method。

import { applyModelPatch } from './apply.js'
import { buildCatalog } from './catalog.js'
import { emptyPrefs, prefsPath, readPrefs, recordOverride, updatePrefs } from './prefs.js'
import { discoverProviderModels, listProviderTemplates, removeDeclaredModel, writeProviderDraft, writeProviderModels } from './provider.js'
import { CapabilityError, describeSettings, pickPatch, settingsService, llmService } from './settings-bridge.js'
import { runSelftest } from './selftest.js'
import { API_PREFIX, PREFIX, errorMessage, fail, getPath, json, readJsonBody, stringArray } from './util.js'

const FIELDS = ['contextWindow', 'maxTokens', 'vision']

/** 只接受显式 application/json 的写请求：跨站表单无法伪造该 content-type，
 *  而跨站 fetch 会先发 preflight —— 我们不答 OPTIONS，所以写接口天然挡住 CSRF。 */
function assertJsonRequest(req) {
  const header = req.headers['content-type']
  const type = Array.isArray(header) ? header[0] : header
  if (typeof type !== 'string' || !type.toLowerCase().includes('application/json')) {
    throw new CapabilityError('UNSUPPORTED_MEDIA_TYPE', '写接口需要 Content-Type: application/json')
  }
}

/** 客户端断开连接时取消末尾的 prepareCall 证据读取。
 *  它**只**影响证据读取 —— 绝不跳过写入或还原，否则断开一次就可能留下半改的 profile。 */
function requestSignal(res) {
  const controller = new AbortController();
  if (typeof res.on === 'function') res.on('close', () => controller.abort());
  return controller.signal;
}

function requireString(body, field) {
  const value = body[field]
  if (typeof value !== 'string' || value === '') {
    throw new CapabilityError('INVALID_REQUEST', field + ' 必须是非空字符串')
  }
  return value
}

function summary(provider, model, effective) {
  const out = { provider, model };
  for (const field of FIELDS) out[field] = effective === undefined ? null : (effective[field] === undefined ? null : effective[field]);
  // 暴露 inputModalities：这样 effective 与 prepared 两层证据可以直接逐字段比对（vision 只是它的派生布尔）。
  out.inputModalities = effective === undefined || !Array.isArray(effective.inputModalities) ? null : [...effective.inputModalities];
  out.efforts = effective === undefined || !Array.isArray(effective.efforts) ? [] : effective.efforts;
  out.defaultEffort = effective === undefined ? null : (effective.defaultEffort === undefined ? null : effective.defaultEffort);
  return out;
}

/** 统一的 handler 包装：任何异常都变成 JSON 失败体，绝不让 HTTP 层看到裸异常。 */
function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof CapabilityError) {
        const status = err.code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : 400;
        fail(res, status, err.code, err.message);
        return;
      }
      fail(res, 500, 'INTERNAL', errorMessage(err));
    }
  };
}

export function setupRoutes(ctx, config = {}) {
  const handleHealth = route(async (req, res) => {
    if (req.method !== 'GET') return fail(res, 405, 'METHOD_NOT_ALLOWED', '只支持 GET');
    const settings = settingsService(ctx);
    const llm = llmService(ctx);
    json(res, 200, {
      ok: true,
      name: 'dsh-model-hub',
      prefix: PREFIX,
      enabled: config.enabled !== false,
      prefsPath: prefsPath(),
      hasLlm: llm !== undefined,
      hasSettings: settings !== undefined && typeof settings.mutate === 'function',
      webServerPort: typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : null,
    });
  });

  const handleCatalog = route(async (req, res) => {
    if (req.method !== 'GET') return fail(res, 405, 'METHOD_NOT_ALLOWED', '只支持 GET');
    const prefs = await readPrefs();
    json(res, 200, await buildCatalog(ctx, prefs));
  });

  const handlePrefs = route(async (req, res) => {
    if (req.method === 'GET') {
      json(res, 200, { ok: true, prefs: await readPrefs() });
      return;
    }
    if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', '只支持 GET/POST');
    assertJsonRequest(req);
    const body = await readJsonBody(req);
    const order = body.order === undefined ? undefined : stringArray(body.order);
    if (body.order !== undefined && order === undefined) {
      return fail(res, 400, 'INVALID_ORDER', 'order 必须是字符串数组');
    }
    const pinned = body.pinned === undefined ? undefined : stringArray(body.pinned);
    if (body.pinned !== undefined && pinned === undefined) {
      return fail(res, 400, 'INVALID_PINNED', 'pinned 必须是字符串数组');
    }
    const saved = await updatePrefs((draft) => {
      if (order !== undefined) draft.order = order;
      if (pinned !== undefined) draft.pinned = pinned;
    });
    json(res, 200, { ok: true, prefs: saved });
  });

  const handleModel = route(async (req, res) => {
    if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', '只支持 POST');
    assertJsonRequest(req);
    const body = await readJsonBody(req);
    const provider = requireString(body, 'provider');
    const model = requireString(body, 'model');
    const patch = pickPatch(body.patch);

    const result = await applyModelPatch(ctx, provider, model, patch, { signal: requestSignal(res) });
    if (result.ok) {
      // 写盘已经生效，这里只记一条'已自定义'标记；标记失败不影响写入结论。
      try {
        await updatePrefs((draft) => recordOverride(draft, provider, model, patch));
      } catch {
        /* 偏好文件失败不该让能力写入看起来失败 */
      }
      json(res, 200, {
        ok: true,
        effective: summary(provider, model, result.effective),
        before: summary(provider, model, result.before),
        verify: result.verify,
        written: result.written,
        prepared: result.prepared,
        // 声明层回执：reasoningEfforts 的 unset 在运行时看不出差别，只能靠它佐证（客户端也用它免重拉 catalog）。
        declaredAfter: result.declaredAfter,
        appliedVia: { ns: result.ns, settingsPath: result.base, layer: result.layer },
      });
      return;
    }

    json(res, 200, {
      ok: false,
      code: result.code,
      message: result.message,
      effective: summary(provider, model, result.effective || result.before),
      before: summary(provider, model, result.before),
      ...(result.prepared === undefined ? {} : { prepared: result.prepared }),
      ...(result.declaredAfter === undefined ? {} : { declaredAfter: result.declaredAfter }),
      ...(result.verify === undefined ? {} : { verify: result.verify }),
      ...(result.pending === undefined ? {} : { pending: result.pending }),
      ...(result.appliedVia === undefined && result.ns === undefined ? {} : { appliedVia: { ns: result.ns, settingsPath: result.base, layer: result.layer } }),
    });
  });

  const handleSelftest = route(async (req, res) => {
    if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', '只支持 POST');
    assertJsonRequest(req);
    const body = await readJsonBody(req);
    const provider = requireString(body, 'provider');
    const model = requireString(body, 'model');
    const patch = pickPatch(body.patch);
    const result = await runSelftest(ctx, {
      provider,
      model,
      patch,
      restore: body.restore !== false,
      signal: requestSignal(res),
    });
    json(res, 200, result);
  });

  // ---- 契约 v1.3：添加提供商 / 手动获取模型 / 勾选启用 ----

  const handleProviderTemplates = route(async (req, res) => {
    if (req.method !== 'GET') return fail(res, 405, 'METHOD_NOT_ALLOWED', '只支持 GET');
    json(res, 200, listProviderTemplates(ctx));
  });

  // 保存/删除**待建** provider 草稿。llm-pi-ai 拒绝无模型路由（源码 :678），
  // 所以这里不写 profile；草稿存 prefs.json，勾选模型时由 /provider/models 一次性落盘。
  const handleProvider = route(async (req, res) => {
    if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', '只支持 POST');
    assertJsonRequest(req);
    const body = await readJsonBody(req);
    json(res, 200, await writeProviderDraft(ctx, body));
  });

  const handleProviderDiscover = route(async (req, res) => {
    if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', '只支持 POST');
    assertJsonRequest(req);
    const body = await readJsonBody(req);
    // 适配器侧的拒绝（NO_DISCOVERY / DISCOVERY_FAILED / …）是**结果**而不是参数错误，
    // 所以统一 200 + ok:false，和 /model 的 NOT_EFFECTIVE 同一约定。
    json(res, 200, await discoverProviderModels(ctx, body, { signal: requestSignal(res) }));
  });

  const handleProviderModels = route(async (req, res) => {
    if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', '只支持 POST');
    assertJsonRequest(req);
    const body = await readJsonBody(req);
    const provider = requireString(body, 'provider');
    const result = await writeProviderModels(ctx, provider, body.models, body.providerFields);
    // 回读**声明层**（写后值），不依赖目录是否已刷新：直接用写回的 ns + settingsPath 读 user 层。
    const descriptor = describeSettings(ctx).get(result.ns);
    const declaredAfter = descriptor === undefined ? null : (getPath(descriptor.user, result.settingsPath) ?? null);
    json(res, 200, {
      ok: true,
      count: result.count,
      created: result.created,
      clearedPending: result.clearedPending === true,
      declaredAfter,
      appliedVia: { ns: result.ns, settingsPath: result.settingsPath },
      ops: result.ops,
    });
  });

  // 契约 v1.4：从模型列表里删掉单个模型（删完可以用刷新按钮再勾回来）。
  const handleProviderModelRemove = route(async (req, res) => {
    if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', '只支持 POST');
    assertJsonRequest(req);
    const body = await readJsonBody(req);
    const provider = requireString(body, 'provider');
    const model = requireString(body, 'model');
    json(res, 200, await removeDeclaredModel(ctx, provider, model));
  });

  const routes = [
    { kind: 'exact', path: API_PREFIX + '/health', handler: handleHealth },
    { kind: 'exact', path: API_PREFIX + '/provider/model-remove', handler: handleProviderModelRemove },
    { kind: 'exact', path: API_PREFIX + '/provider-templates', handler: handleProviderTemplates },
    { kind: 'exact', path: API_PREFIX + '/provider', handler: handleProvider },
    { kind: 'exact', path: API_PREFIX + '/provider/discover', handler: handleProviderDiscover },
    { kind: 'exact', path: API_PREFIX + '/provider/models', handler: handleProviderModels },
    { kind: 'exact', path: API_PREFIX + '/catalog', handler: handleCatalog },
    { kind: 'exact', path: API_PREFIX + '/prefs', handler: handlePrefs },
    { kind: 'exact', path: API_PREFIX + '/model', handler: handleModel },
    { kind: 'exact', path: API_PREFIX + '/selftest', handler: handleSelftest },
  ];

  const disposers = routes.map((entry) => ctx.webServer.register(entry));
  return () => {
    for (const dispose of disposers) dispose();
  };
}

export { emptyPrefs };
