/**
 * dsh-model-hub — 浏览器侧 client bundle（classic script，非 ESM）
 *
 * ═════════════════════════════ 设计说明（评审入口） ═════════════════════════════
 *
 * 【1】为什么这样能"遮蔽"内置模型选择器（决定性结论，已用只读源码核实）
 *   - 槽位 conversation.input.model 的声明是 { kind: "single", scope: "session" }
 *     （@deepseek-ai/dsh-client-ui-conversation/lib/client.js:19908-19911）。
 *   - 内置注册（@deepseek-ai/dsh-client-ui-model-selection/lib/client.js:1903-1923）没有写
 *     priority ⇒ 默认 0。
 *   - SlotCore.register（内联在 dsh-web-frontend/dist/assets/index-*.js，约 486900 处）对
 *     single 槽位只禁止"同 priority 重复注册"；不同 priority 允许，并且 entries 按
 *     (priority ?? 0) 升序排列。
 *   - SlotRegistry.entriesOfSlot（dsh-client-ui-renderer/lib/client.js:1545-1556）语义是
 *     "每个 cell 取排序后第一个仍然 live（未被 abdicate）的条目"。
 *   - 渲染出口（renderer/lib/client.js:1173-1176）: spec.kind === "single" 时取
 *     entriesOfSlot(key)[0]。
 *   ⇒ **priority 数值最小者获胜**。因此本插件用 priority = -100 注册即遮蔽内置实现；
 *     插件卸载 / enabled:false 时我们的条目被移除，内置自动回来 —— 不需要任何 CSS 隐藏、
 *     也没有 DOM/CSS 残留。
 *   ⇒ 附带保险：万一本条目在 render 期抛异常，renderer 的 SlotErrorBoundary 会调用
 *     reportEntryError(abdicate=true) 把我们的条目退休，内置实现自动顶上。
 *
 * 【2】副作用与补偿
 *   因为是"再注册"而不是"重声明"，register 不允许我们再声明 children，所以我们拿不到
 *   props.renderSlot，也就渲染不了 conversation.input.model.label 子槽。官方插件
 *   @deepseek-ai/dsh-client-ui-deepseek-model-label-1017 往那个子槽里塞了一个 "1017"
 *   小标签（其 lib/client.js:28-41：provider.id ∈ {deepseek-account, deepseek-official}
 *   && model.id === "deepseek-flash" && model.name === "DeepSeek-V4.1-Flash"）。
 *   这里按 Lead 裁决**内联复刻**该标签（trigger / 列表行 / 悬浮卡标题三处一致），
 *   条件完全一致，所以不会误显示。
 *
 * 【3】真选中 & 真状态（不自造状态）
 *   slot 的 inject(sessionId) 里拿 modelDirectories.directoryFor(sessionId)，把
 *   directory.store 作为 prop 交给组件：
 *     - 用 useSyncExternalStore(store.subscribe, store.getSnapshot) 读会话选择；
 *     - 点选模型 → select({ provider, model, reasoningEffort? })（与内置 /model 同一份会话目录）；
 *     - 思考档位 → 同一个 select 提交 reasoningEffort（Lead 裁决 v1.1：不走 /api/model）。
 *   快照形状（model-selection/lib/client.js:813-821 / 969-978 实证）：
 *     { current: {provider,model,reasoningEffort?}|null, retainedEffort?, routable, groups:
 *       [{id,name,models:[{id,name,reasoning?:{defaultEffort?,efforts:[{id,name}]}}]}],
 *       failures, status, pending, error }
 *
 * 【4】元数据与能力写入（宿主 /model-hub/api/*）
 *   - GET  /model-hub/api/catalog  全量元数据（contextWindow/maxTokens/vision/efforts/defaultEffort）
 *   - GET  /model-hub/api/prefs    顺序 / 置顶 / 覆盖记录
 *   - POST /model-hub/api/prefs    { order?, pinned? }（**必须** Content-Type: application/json）
 *   - POST /model-hub/api/model    { provider, model, patch:{contextWindow?,maxTokens?,vision?} }
 *   - GET  /model-hub/api/health   探测宿主插件是否在场
 *   失败语义：HTTP 200 + ok:false + code；其中 NOT_EFFECTIVE = "配置写进去了但运行时没生效"
 *   ⇒ 必须回滚 UI 并把 code 显示出来（这正是"不要只是看着有变动"的那条不变量）。
 *   乐观更新 + 失败回滚 + 明确错误提示；catalog 不可用时整块退化为**只读**（仍可切模型），
 *   绝不假装写入成功。
 *
 * 【5】抗白屏
 *   factory / apply 全程 try/catch；apply 里注册失败只打日志（内置选择器继续工作）。
 *
 * 【6】样式与动效
 *   只用 --dsw-* 语义变量（明暗主题自动跟随）；过渡 140-220ms cubic-bezier(.22,.61,.36,1)；
 *   prefers-reduced-motion 下全部降到 1ms（保留 opacity 以免闪烁）。
 *   本文件不引入任何第三方依赖（只有 react / react-dom）。
 */

/* ═══════════ 诊断（issue #1：静默失败必须可见 + 可一键上报）═══════════
 * 放在**模块作用域**：factory 与 build/apply 都在模块作用域，两边都要能用。
 * 失败类（stage 含 failed）→ document.title + 可关闭红框 + console.warn；
 * waiting-services → 可关闭淡提示（非错误）；其余进度类 → 只留 console.debug，不动 UI。
 * 每 stage 去重一次；全程 try/catch（诊断自身绝不能再抛）；上报 fire-and-forget。
 */
// 构建标签：随发布更新，经 /health 的 clientVersion 回显（用于对比“浏览器跑的是哪一版 vs 磁盘上是哪一版”）。
var MH_BUILD = '0.2.0+2026-10-24'   // 构建标签（随发布更新；用于 /health 里对比“浏览器跑的是哪一版 vs 磁盘上是哪一版”）
var MH_DIAG_SEEN = {}
var MH_DIAG_BOX = 'mh-diag'
var MH_DIAG_NOTICE = 'mh-diag-notice'

/** 上报宿主（fire-and-forget：任何失败都忽略，绝不影响主流程）。 */
var mhDiagPost = function (stage, error, extra) {
	try {
		if (typeof window === 'undefined' || typeof window.fetch !== 'function') return
		// clientVersion 是宿主规范字段名（build 为它接受的别名）；
		// bundle-loaded 必带版本 —— 宿主对版本做粘性处理，后续上报不会覆盖。
		var body = { stage: String(stage), clientVersion: MH_BUILD, build: MH_BUILD }
		if (error) body.error = String(error && error.message ? error.message : error).slice(0, 4000)
		if (extra && extra.missing) body.missing = extra.missing
		window.fetch('/model-hub/api/client-state', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}).catch(function () {})
	} catch (ignored) {}
}

var mhDiagText = function (stage, error, extra) {
	var lines = ['stage: ' + stage, 'build: ' + MH_BUILD]
	if (extra && extra.missing) lines.push('missing: ' + [].concat(extra.missing).join(', '))
	var message = error && error.message ? String(error.message) : error ? String(error) : ''
	if (message !== '') lines.push('error: ' + message)
	var stack = error && error.stack ? String(error.stack).split('\n').slice(0, 4) : []
	for (var i = 0; i < stack.length; i++) lines.push(stack[i])
	return lines.join('\n')
}

var mhDiagRemove = function (id) {
	try {
		var node = document.getElementById(id)
		if (node && node.parentNode) node.parentNode.removeChild(node)
	} catch (ignored) {}
}

var mhDiagBox = function (stage, error, extra) {
	try {
		if (typeof document === 'undefined' || !document.body) return
		mhDiagRemove(MH_DIAG_BOX)
		var box = document.createElement('div')
		box.id = MH_DIAG_BOX
		box.setAttribute('data-model-hub', 'diagnostics')
		box.style.cssText = [
			'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483000',
			'max-width:min(560px,62vw)', 'max-height:42vh', 'overflow:auto',
			'box-sizing:border-box', 'padding:10px 12px', 'border-radius:10px',
			'background:#3a1214', 'color:#ffdada', 'border:1px solid #a33b3b',
			'box-shadow:0 8px 28px rgba(0,0,0,.4)',
			'font:11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
			'white-space:pre-wrap', 'word-break:break-word', 'pointer-events:auto'
		].join(';')
		var head = document.createElement('div')
		head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px'
		var title = document.createElement('span')
		title.textContent = 'dsh-model-hub 诊断 · ' + stage
		var close = document.createElement('span')
		close.textContent = '\u00d7'
		close.setAttribute('role', 'button')
		close.setAttribute('aria-label', '关闭诊断')
		close.setAttribute('data-model-hub', 'diagnostics-close')
		close.style.cssText = 'margin-left:auto;cursor:pointer;padding:0 5px;border-radius:6px;background:rgba(255,255,255,.14)'
		close.onclick = function () { mhDiagRemove(MH_DIAG_BOX) }
		head.appendChild(title)
		head.appendChild(close)
		var body = document.createElement('div')
		body.textContent = mhDiagText(stage, error, extra)
		box.appendChild(head)
		box.appendChild(body)
		document.body.appendChild(box)
	} catch (ignored) {}
}

/** 可关闭的淡提示（非错误态，例如等待内置模型选择器提供的服务）。 */
var mhDiagNotice = function (text) {
	try {
		if (typeof document === 'undefined' || !document.body) return
		if (document.getElementById(MH_DIAG_NOTICE)) return
		var box = document.createElement('div')
		box.id = MH_DIAG_NOTICE
		box.setAttribute('data-model-hub', 'notice')
		box.style.cssText = [
			'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483000',
			'max-width:min(520px,60vw)', 'box-sizing:border-box',
			'display:flex', 'align-items:center', 'gap:8px',
			'padding:8px 10px', 'border-radius:10px',
			'background:#3a2f14', 'color:#ffe9c2', 'border:1px solid #7a6220',
			'box-shadow:0 6px 20px rgba(0,0,0,.3)', 'font:12px/18px inherit'
		].join(';')
		var label = document.createElement('span')
		label.textContent = text
		var close = document.createElement('span')
		close.textContent = '\u00d7'
		close.setAttribute('role', 'button')
		close.setAttribute('aria-label', '关闭提示')
		close.setAttribute('data-model-hub', 'notice-close')
		close.style.cssText = 'margin-left:auto;cursor:pointer;padding:0 5px;border-radius:6px;background:rgba(255,255,255,.14)'
		close.onclick = function () { mhDiagRemove(MH_DIAG_NOTICE) }
		box.appendChild(label)
		box.appendChild(close)
		document.body.appendChild(box)
	} catch (ignored) {}
}

/** 唯一诊断入口。 */
var mhDiag = function (stage, error, extra) {
	try {
		var key = String(stage) + ':' + (extra && extra.missing ? [].concat(extra.missing).join(',') : '')
		if (MH_DIAG_SEEN[key] === true) return
		MH_DIAG_SEEN[key] = true
		if (String(stage).indexOf('failed') >= 0) {
			try { document.title = '[模型中心 ' + stage + '] ' + (error && error.message ? String(error.message).slice(0, 80) : '') } catch (ignored) {}
			mhDiagBox(stage, error, extra)
			console.warn('[dsh-model-hub] ' + stage, error || '', extra || '')
		} else if (stage === 'waiting-services') {
			mhDiagNotice('模型目录服务未就绪（内置模型选择器可能被禁用）')
			console.warn('[dsh-model-hub] waiting-services', extra || '')
		} else {
			try { console.debug('[dsh-model-hub] ' + stage, extra || '') } catch (ignored) {}
		}
		mhDiagPost(stage, error, extra)
	} catch (ignored) {}
}

window.__ModuleLoader__.load({
	id: 'dsh-model-hub',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		try {
			build(exports, require)
		} catch (error) {
			// 客户端 bundle 绝不把聊天界面拖下水：初始化失败 → 不注册，内置模型选择器照常工作。
			mhDiag('build-failed', error)
			exports.inject = []
			exports.apply = function () {}
		}
		mhDiag('bundle-loaded', null, { build: MH_BUILD })
		exports.mhDiag = mhDiag

		return module.exports
	}
})

function build(exports, require) {
	var React = require('react')
	var createPortal = require('react-dom').createPortal
	var h = React.createElement

	var MH_VERSION = '0.1.0'
	var API_CATALOG = '/model-hub/api/catalog'
	var API_PREFS = '/model-hub/api/prefs'
	var API_MODEL = '/model-hub/api/model'
	// task-9 B（契约 v1.3）
	var API_PROVIDER = '/model-hub/api/provider'
	var API_DISCOVER = '/model-hub/api/provider/discover'
	var API_PROVIDER_MODELS = '/model-hub/api/provider/models'
	var API_PROVIDER_TEMPLATES = '/model-hub/api/provider-templates'
	var API_MODEL_REMOVE = '/model-hub/api/provider/model-remove'
	// 与设置页一致的三种 wire 协议（值 = schema 标识符，label = 产品名）
	var PROVIDER_APIS = [
		{ id: 'openai-completions', label: 'OpenAI Chat Completions' },
		{ id: 'openai-responses', label: 'OpenAI Responses' },
		{ id: 'anthropic-messages', label: 'Anthropic Messages' }
	]
	var API_HEALTH = '/model-hub/api/health'

	// 遮蔽内置 ModelSelect：single 槽位里 priority 数值最小者渲染（内置是默认 0）。
	var SHADOW_PRIORITY = -100
	// 弹窗级崩溃时的“让位”开关：dispose 掉本次 slot 注册 ⇒ 内置模型选择器立刻接管（提示文案也随之成立）。
	var fatalDispose = null

	// 契约里的三档上下文 / 两档输出（design-spec §6）。
	var CTX_STEPS = [131072, 262144, 1000000]
	var OUT_STEPS = [131072, 262144]
	// task-7：设置页默认推理等级四档（未声明时固定显示这四档）。
	var STANDARD_EFFORT_CHOICES = ['off', 'low', 'medium', 'high']
	// 未声明模型点击档位时先写入的默认声明。
	var DEFAULT_EFFORT_DECLARATION = { off: null, low: 'low', medium: 'medium', high: 'high' }
	// A3：异常值阈值（超过就提示“可能多打了 0”，只警告不阻止写入）。
	var ANOMALY_CONTEXT = 2000000
	var ANOMALY_OUTPUT = 400000
	var CONTEXT_KEY = 'contextWindow'
	var OUTPUT_KEY = 'maxTokens'

	var TEXT = {
		triggerFallback: '请选择模型',
		triggerLoading: '正在加载模型…',
		unavailable: '当前会话不可选择模型',
		dialogLabel: '模型中心',
		providerColumn: '提供商',
		providerHint: '可拖动排序 · 右键置顶',
		searchPlaceholder: '搜索全部模型…',
		searchScope: '搜索中 · 点提供商可回到它',
		searchClear: '清除搜索',
		noResults: '没有匹配的模型',
		noModels: '该提供商暂无可选模型',
		noKey: '未配置凭证',
		loading: '正在加载模型…',
		catalogDown: '宿主模型元数据不可用（/model-hub/api/catalog 未响应）——可正常切换模型，能力修改已禁用。',
		metaDown: '该模型缺少元数据，能力修改已禁用。',
		retry: '重试',
		close: '关闭',
		vision: '视觉',
		context: '上下文',
		output: '输出',
		effort: '思考档位',
		effortRow: '推理等级',
		sessionEffortHint: '本会话',
		currentFlag: '当前',
		allProvidersHint: '其他渠道里名字相近的模型',
		addProvider: '＋ 添加模型提供商',
		addProviderHint: '填表后保存（默认不获取模型）',
		pendingProvider: '待选模型',
		removePending: '删除该待选提供商',
		removeModel: '删除该模型',
		removeModelConfirm: '确认删除？',
		removeModelLast: '该渠道至少要保留一个模型（可以用右下角刷新重新获取）',
		removeModelNotDeclared: '该模型来自渠道目录，不能单独删除',
		removeModelLastDisabled: '这是该渠道最后一个可删模型，至少要保留一个',
		formTitle: '添加模型提供商',
		fieldId: '提供商 id',
		fieldDisplayName: '显示名',
		fieldApi: 'API 协议',
		fieldBaseURL: 'Base URL',
		fieldApiKeyEnv: 'API Key 环境变量名',
		cancel: '取消',
		save: '保存',
		saving: '保存中…',
		errProviderId: '提供商 id 不能为空',
		errBaseURL: 'Base URL 不能为空且必须是 http(s) 地址',
		discoverTitle: '获取模型',
		discoverHint: '勾选要启用的模型（覆盖写入）',
		discoverEmpty: '没有可用的候选模型',
		discoverLoading: '正在获取模型…',
		discoverNeedOne: '至少勾选一个模型',
		formProtocolFetchFailed: '取协议列表失败，已用内置列表',
		discoverSelected: '已选 ',
		selectAll: '全选',
		clearAll: '取消全选',
		confirm: '确定',
		refreshModels: '刷新模型列表（获取该提供商的可用模型）',
		providerSaved: '已保存待选提供商：',
		expandOthers: '展开其他渠道的相似模型',
		collapseOthers: '收起其他渠道的相似模型',
		modalitiesInherited: '输入类型（未声明时为继承值）',
		inputType: '输入类型',
		modalityText: '文本',
		modalityImage: '图片',
		errModalityMin: '至少保留一个输入类型',
		legacyInput: '宿主为旧版本，输入类型已按旧接口降级（重启 DSH 后可用完整语义）。',
		legacyOnlyImage: '宿主版本较旧，需重启 DSH 后才能只保留图片输入。',
		footer: '改动立即生效并保存到模型配置',
		noEfforts: '该模型未公布思考档位',
		effortNotCurrent: '点击档位将同时切换到该模型',
		effortUndeclared: '点击会为该模型写入推理等级声明',
		valueAnomaly: '数值异常大（>2M），确认是否多打了 0',
		valueAnomalyOutput: '数值异常大（>400K），确认是否多打了 0',
		effortDeclareLegacy: '宿主版本较旧，需重启 DSH 后才能写入推理等级声明',
		pinned: '置顶',
		unpinned: '取消置顶',
		selected: '当前使用',
		orderSaveFailed: '提供商顺序保存失败：',
		renderFailed: '模型中心渲染失败，已交回内置模型选择器（详情见控制台；刷新页面可重试）。',
		sessionBusy: '当前会话被其他窗口占用（可能开着另一个 DSH 实例），请关闭其它 DSH 后重试。',
		selectFailed: '模型切换失败：',
		failedNotEffective: '未生效',
		version: MH_VERSION
	}

	// 档位短标签：优先用宿主给的名字，常见档位给中文短名。
	var EFFORT_SHORT = { off: '关', none: '关', minimal: '最低', low: '低', medium: '中', mid: '中', high: '高', xhigh: '极高', max: '最高' }

	function effortLabelOf(entry) {
		if (!entry) return ''
		var id = typeof entry.id === 'string' ? entry.id.toLowerCase() : ''
		var name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.label
		return EFFORT_SHORT[id] || (typeof name === 'string' && name !== '' ? name : entry.id)
	}

	/* ══════════════════════════════════ CSS ══════════════════════════════════ */

	var MH_CSS = [
		'.mh-root{position:relative;display:flex;align-items:center;min-width:0}',
		'.mh-trigger{border-radius:var(--dsw-radius-sm);min-width:0;max-width:min(360px,45cqw);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:transparent;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:400;line-height:20px;display:flex;transition:background-color 160ms cubic-bezier(.22,.61,.36,1),color 160ms cubic-bezier(.22,.61,.36,1)}',
		'.mh-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
		'.mh-trigger:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
		'.mh-trigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}',
		'.mh-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
		'.mh-triggerIcon{flex:none;display:block}',
		'.mh-triggerLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
		'.mh-triggerEffort{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-caption);flex-shrink:1000}',
		'.mh-triggerChevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform 200ms cubic-bezier(.22,.61,.36,1)}',
		'.mh-triggerChevron[data-open="true"]{transform:rotate(180deg)}',
		'.mh-tag1017{display:inline-flex;align-items:center;gap:4px;vertical-align:baseline;white-space:nowrap}',
		'.mh-pill{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;font-size:11px;font-weight:500;line-height:18px;white-space:nowrap}',
		'.mh-pillInfo{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));background:color-mix(in srgb,var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary)) 14%,transparent)}',
		'.mh-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px}',
		'.mh-overlayPopover{display:block;padding:0}',
		'.mh-mask.mh-maskBare{background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none}',
		'.mh-panelPopover .mh-side{padding:8px 6px 8px 8px}',
		'.mh-panelPopover .mh-sideHead{white-space:nowrap}',
		'.mh-panelPopover .mh-sideHint{display:none}',
		'.mh-panelPopover .mh-prov{padding:8px 10px;font-size:13px;line-height:18px}',
		'.mh-panelPopover .mh-searchRow{padding:10px 12px 8px}',
		'.mh-panelPopover .mh-list{padding:2px 8px 8px}',
		'.mh-panelPopover .mh-model{padding:8px 10px}',
		'.mh-panelPopover .mh-strip{margin:0 12px 8px}',
		'.mh-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);-webkit-backdrop-filter:var(--dsw-mask-blur);animation:mh-fade-in 140ms cubic-bezier(.22,.61,.36,1) backwards}',
		'.mh-mask[data-open="false"]{opacity:0;transition:opacity 120ms cubic-bezier(.22,.61,.36,1)}',
		'@keyframes mh-fade-in{from{opacity:0}to{opacity:1}}',

		'.mh-panel{position:relative;z-index:1201;border:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;width:min(920px,calc(100vw - 48px));height:min(640px,calc(100vh - 96px));box-sizing:border-box;border-radius:20px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;overflow:hidden}',
		'.mh-panel[data-open="false"]{opacity:0;transform:scale(.99) translateY(4px);transition:opacity 120ms cubic-bezier(.22,.61,.36,1),transform 120ms cubic-bezier(.22,.61,.36,1)}',
		'@keyframes mh-panel-in{from{transform:scale(.985) translateY(6px)}to{transform:none}}',

		'.mh-panel,.mh-panel *{box-sizing:border-box}',
		// 入场动效挪到 body：面板自身的盒模型/rect 永远等于稳定态（卡片落位靠它），且动效仍然只动 transform。
		'.mh-body{display:flex;flex:1;min-height:0;animation:mh-panel-in 180ms cubic-bezier(.22,.61,.36,1) backwards}',
		'.mh-side{width:236px;flex:none;display:flex;flex-direction:column;min-height:0;padding:10px 8px 10px 10px;background:var(--dsw-alias-bg-layer-2);border-right:1px solid var(--dsw-alias-border-l2);transition:opacity 160ms cubic-bezier(.22,.61,.36,1)}',
		'.mh-side[data-searching="true"]{opacity:.55}',
		'.mh-side[data-searching="true"]:hover{opacity:.85}',
		'.mh-sideHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 8px 8px;font-size:11px;font-weight:500;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary)}',
		'.mh-sideHint{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.mh-sideList{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding-right:2px}',
		'.mh-sideFoot{padding:8px 8px 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary)}',
		'.mh-sideMore{margin-top:6px;width:100%;padding:8px 10px;border:none;border-radius:10px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:16px;text-align:left;cursor:pointer;transition:background-color 140ms cubic-bezier(.22,.61,.36,1),color 140ms cubic-bezier(.22,.61,.36,1)}',
		'.mh-sideMore:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
		'.mh-sideMore:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}',
		'.mh-sideList::-webkit-scrollbar,.mh-list::-webkit-scrollbar,.mh-card::-webkit-scrollbar{width:8px;height:8px}',
		'.mh-sideList::-webkit-scrollbar-thumb,.mh-list::-webkit-scrollbar-thumb,.mh-card::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:999px}',
		'.mh-sideList::-webkit-scrollbar-thumb:hover,.mh-list::-webkit-scrollbar-thumb:hover,.mh-card::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2)}',
		'.mh-sideList::-webkit-scrollbar-track,.mh-list::-webkit-scrollbar-track,.mh-card::-webkit-scrollbar-track{background:transparent}',
		'.mh-prov{position:relative;display:flex;align-items:center;gap:8px;width:100%;padding:10px 12px;border:none;border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:20px;text-align:left;cursor:pointer;user-select:none;transition:background-color 140ms cubic-bezier(.22,.61,.36,1),color 140ms cubic-bezier(.22,.61,.36,1),box-shadow 140ms cubic-bezier(.22,.61,.36,1)}',
		'.mh-prov:hover{background:var(--dsw-alias-interactive-bg-hover)}',
		'.mh-prov[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}',
		'.mh-prov:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}',
		'.mh-prov[data-empty="true"]{color:var(--dsw-alias-label-dimmed)}',
		'.mh-prov[data-dragging="true"]{opacity:.55}',
		'.mh-prov[data-drop="above"]{box-shadow:inset 0 2px 0 0 var(--dsw-alias-brand-primary)}',
		'.mh-prov[data-drop="below"]{box-shadow:inset 0 -2px 0 0 var(--dsw-alias-brand-primary)}',
		'.mh-provBar{position:absolute;left:2px;top:9px;bottom:9px;width:3px;border-radius:999px;background:var(--dsw-alias-brand-primary);opacity:0;transform:scaleY(.4);transition:opacity 140ms cubic-bezier(.22,.61,.36,1),transform 140ms cubic-bezier(.22,.61,.36,1)}',
		'.mh-prov[data-active="true"] .mh-provBar{opacity:1;transform:none}',
		'.mh-provName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.mh-provCount{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
		'.mh-provPin{flex:none;display:none;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background-color 140ms cubic-bezier(.22,.61,.36,1),color 140ms cubic-bezier(.22,.61,.36,1)}',
		'.mh-prov:hover .mh-provPin{display:inline-flex}',
		'.mh-prov[data-pinned="true"] .mh-provPin{display:inline-flex;color:var(--dsw-alias-brand-primary)}',
		'.mh-provPin:hover{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
		'.mh-main{position:relative;flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2))}',
		'.mh-searchRow{display:flex;align-items:center;gap:10px;padding:14px 16px 10px}',
		'.mh-search{position:relative;flex:1;min-width:0;display:flex;align-items:center;gap:8px;height:36px;padding:0 8px 0 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover));border:1px solid var(--dsw-alias-border-l1);transition:border-color 160ms cubic-bezier(.22,.61,.36,1),box-shadow 160ms cubic-bezier(.22,.61,.36,1)}',
		'.mh-search:focus-within{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}',
		'.mh-searchIcon{flex:none;color:var(--dsw-alias-label-tertiary);display:block}',
		'.mh-searchInput{flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:20px;padding:0}',
		'.mh-searchInput::placeholder{color:var(--dsw-alias-label-tertiary)}',
		'.mh-searchClear{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background-color 140ms cubic-bezier(.22,.61,.36,1),color 140ms cubic-bezier(.22,.61,.36,1)}',
		'.mh-searchClear:hover{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
		'.mh-searchCount{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
		'.mh-listWrap{flex:1;min-height:0;position:relative;display:flex;flex-direction:column}',
		'.mh-list{flex:1;min-height:0;overflow-y:auto;padding:2px 10px 12px}',
		'.mh-moreModels{margin:6px 4px 2px;width:calc(100% - 8px);padding:7px 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;text-align:left;cursor:pointer;transition:background-color 140ms cubic-bezier(.22,.61,.36,1),color 140ms cubic-bezier(.22,.61,.36,1)}',
		'.mh-moreModels:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
		'.mh-moreModels:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}',
		'.mh-groupFlag{flex:none;padding:0 4px;border-radius:999px;font-size:10px;line-height:14px;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}',
		'.mh-groupHead{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 0 0;padding:8px 14px 4px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));font-size:11px;font-weight:500;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary)}',
		'.mh-groupName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.mh-groupCount{flex:none;color:var(--dsw-alias-label-tertiary)}',
		'.mh-model{position:relative;display:flex;align-items:center;gap:10px;width:100%;padding:10px 14px;border:none;border-radius:10px;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:20px;text-align:left;cursor:pointer;transition:background-color 140ms cubic-bezier(.22,.61,.36,1)}',
		'.mh-model:hover,.mh-model[data-hl="true"]{background:var(--dsw-alias-interactive-bg-hover)}',
		'.mh-model[data-selected="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2)))}',
		'.mh-model[data-selected="true"]:hover,.mh-model[data-selected="true"][data-hl="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2)))}',
		'.mh-model:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}',
		'.mh-model[data-disabled="true"]{cursor:default;color:var(--dsw-alias-label-dimmed)}',
		'.mh-modelCheck{flex:none;width:16px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary)}',
		'.mh-modelLabel{flex:1;min-width:0;display:flex;align-items:center;gap:4px;overflow:hidden}',
		'.mh-modelName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:4px}',
		'.mh-model[data-selected="true"] .mh-modelName{font-weight:500}',
		'.mh-match{color:var(--dsw-alias-brand-primary);font-weight:600;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border-radius:3px}',
		'.mh-badges{flex:none;display:flex;align-items:center;gap:6px}',
		// v1.4 模型删除：默认隐藏，行 hover 或处于“确认删除？”时才出现
		'.mh-modelRemove{flex:none;display:none;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:6px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
		'.mh-model:hover .mh-modelRemove,.mh-model[data-remove-confirm="true"] .mh-modelRemove{display:inline-flex}',
		'.mh-modelRemove:hover{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-state-error-primary)}',
		'.mh-modelRemove[data-disabled="true"]{cursor:default;color:var(--dsw-alias-label-dimmed);background:transparent}',
		'.mh-modelRemove[data-confirming="true"]{display:inline-flex;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}',
		'.mh-badge{display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 7px;border-radius:999px;font-size:11px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover));border:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
		'.mh-badgeWarn{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary))}',
		'.mh-spin{width:14px;height:14px;flex:none;border-radius:50%;border:1.6px solid color-mix(in srgb,var(--dsw-alias-label-tertiary) 35%,transparent);border-top-color:var(--dsw-alias-brand-primary);animation:mh-spin 700ms linear infinite}',
		'.mh-spinSm{width:12px;height:12px;border-width:1.4px}',
		'@keyframes mh-spin{to{transform:rotate(360deg)}}',
		'.mh-strip{margin:0 16px 10px;display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:10px;font-size:12px;line-height:18px}',
		'.mh-stripWarn{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary))}',
		'.mh-stripError{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}',
		'.mh-stripText{flex:1;min-width:0}',
		'.mh-link{padding:0;border:none;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer;text-decoration:underline}',
		'.mh-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;height:100%;padding:24px;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center}',
		'.mh-skelRow{display:flex;align-items:center;gap:10px;padding:10px 14px}',
		'.mh-skelBar{height:12px;border-radius:999px;background:var(--dsw-alias-bg-skeleton,var(--dsw-alias-interactive-bg-hover));animation:mh-pulse 1.4s ease-in-out infinite}',
		'@keyframes mh-pulse{0%,100%{opacity:.55}50%{opacity:1}}',
		'.mh-card{box-sizing:border-box;position:fixed;z-index:1202;width:200px;max-height:calc(100vh - 24px);overflow-y:auto;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv2,var(--dsw-shadow-lv3));animation:mh-card-in 160ms cubic-bezier(.22,.61,.36,1) backwards}',
		'.mh-card[data-side="left"]{animation-name:mh-card-in-left}',
		'.mh-card[data-side="above"]{animation-name:mh-card-in-above}',
		// 上方落位时从**更上方**滑入：动画进行中卡片也只会离面板更远，绝不会在任意一帧压住面板上边缘。
		'@keyframes mh-card-in-above{from{transform:translateY(-6px)}to{transform:none}}',
		'@keyframes mh-card-in{from{transform:translateX(-6px)}to{transform:none}}',
		'@keyframes mh-card-in-left{from{transform:translateX(6px)}to{transform:none}}',
		'.mh-cardHead{margin-bottom:6px}',
		'.mh-cardTitle{font-size:12px;font-weight:600;line-height:16px;display:flex;align-items:center;gap:4px;min-width:0}',
		'.mh-cardName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.mh-card .mh-pill{height:15px;padding:0 5px;font-size:10px;line-height:15px}',
		'.mh-fieldRow{display:flex;align-items:center;gap:6px;min-height:22px}',
		'.mh-fieldCtl{flex:1;min-width:0}',
		'.mh-fieldCtlEnd{display:flex;align-items:center;justify-content:flex-end}',
		'.mh-field{margin-bottom:6px}',
		'.mh-field:last-child{margin-bottom:0}',
		'.mh-fieldNote{margin-top:2px}',
		'.mh-fieldLabel{flex:none;width:46px;font-size:11px;line-height:14px;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}',
		'.mh-fieldLabelIcon{display:inline-flex;align-items:center;gap:4px}',
		'.mh-fieldNote{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
		'.mh-field .mh-fieldNote{font-size:10px;line-height:14px}',
		'.mh-seg{display:flex;flex-wrap:wrap;gap:1px;padding:2px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover));border:1px solid var(--dsw-alias-border-l1)}',
		'.mh-segBtn{flex:1 1 auto;min-width:42px;height:18px;padding:0 3px;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;font-weight:500;line-height:18px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;transition:background-color 160ms cubic-bezier(.22,.61,.36,1),color 160ms cubic-bezier(.22,.61,.36,1)}',
		'.mh-segBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
		'.mh-segBtn[data-on="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,transparent)}',
		'.mh-segBtn:disabled{cursor:default;opacity:.55}',
		'.mh-segBtn[data-warn="true"]{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-error-primary));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-error-primary)) 45%,transparent)}',
		'.mh-fieldWarn{font-size:11px;line-height:15px;color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-error-primary))}',
		'.mh-segBtn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}',
		'.mh-cardFoot{margin-top:6px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}',
		'.mh-cardNote{margin-top:6px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}',
		'.mh-cardError{display:flex;align-items:flex-start;gap:6px;margin-top:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary)}',
		'.mh-dot{width:6px;height:6px;flex:none;margin-top:5px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}',
		'.mh-check{display:inline-flex;align-items:center;gap:4px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:14px;cursor:pointer;transition:color 140ms cubic-bezier(.22,.61,.36,1)}',
		'.mh-check:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
		'.mh-check:disabled{cursor:default;opacity:.55}',
		'.mh-check:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));border-radius:4px}',
		'.mh-checkBox{width:12px;height:12px;flex:none;border-radius:3px;border:1px solid var(--dsw-alias-border-l2);display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary)}',
		'.mh-check[aria-checked="true"] .mh-checkBox{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}',
		'.mh-modalities{display:flex;align-items:center;gap:10px}',

		// task-9 B：全屏页（添加提供商 / 获取模型）
		'.mh-page{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);animation:mh-panel-in 140ms cubic-bezier(.22,.61,.36,1) backwards}',
		'.mh-pageHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
		'.mh-pageTitle{font-size:14px;font-weight:600;line-height:20px}',
		'.mh-pageClose{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
		'.mh-pageClose:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
		'.mh-pageBody{flex:1;min-height:0;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}',
// 获取模型页：搜索框在**纵向** flex 容器里不能继承 .mh-search 的 flex:1（那会纵向撑满、把列表挤掉）
'.mh-pageBody>.mh-search{flex:0 0 auto;height:32px;border-radius:10px}',
// 获取模型页：整页不滚动，由候选列表自己滚（避免双滚动条与列表被压缩）
'.mh-page[data-model-hub="discover"] .mh-pageBody{overflow:hidden;padding-bottom:12px}',
		'.mh-pageFoot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l2)}',
		'.mh-formRow{display:flex;align-items:center;gap:10px}',
		'.mh-formLabel{flex:none;width:120px;font-size:12px;color:var(--dsw-alias-label-secondary);text-align:right}',
		'.mh-input{flex:1;min-width:0;height:28px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
		'.mh-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}',
		'.mh-formHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding-left:130px}',
		'.mh-btn{height:28px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
		'.mh-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
		'.mh-btn:disabled{cursor:default;opacity:.55}',
		'.mh-btnPrimary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted,var(--dsw-alias-label-primary-foreground,#fff))}',
		'.mh-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);opacity:.9;color:var(--dsw-alias-label-primary-inverted,#fff)}',
		'.mh-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
		'.mh-toolbarCount{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
		'.mh-discoverList{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:1px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:4px}',
		'.mh-discoverRow{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;font-size:12px;line-height:18px;cursor:pointer}',
		'.mh-discoverRow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
		'.mh-discoverId{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.mh-discoverName{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}',
		// 刷新按钮（模型列表右下角）
		'.mh-refresh{position:absolute;right:12px;bottom:12px;z-index:2;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary);cursor:pointer;box-shadow:var(--dsw-shadow-lv2)}',
		'.mh-refresh:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
		'.mh-refresh:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}',
		'.mh-provPending{flex:none;padding:0 4px;border-radius:999px;font-size:9px;line-height:14px;color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary)) 15%,transparent)}',
		'.mh-provDel{flex:none;display:none;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
		'.mh-prov:hover .mh-provDel,.mh-prov[data-pending="true"] .mh-provDel{display:inline-flex}',
		'.mh-provDel:hover{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-state-error-primary)}',
		'.mh-pageError{padding:6px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}',
		'.mh-fallback{position:fixed;right:24px;bottom:120px;z-index:1203;max-width:280px;box-sizing:border-box;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
		'.mh-visuallyHidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
		'@media (prefers-reduced-motion: reduce){.mh-trigger,.mh-mask,.mh-panel,.mh-card,.mh-prov,.mh-provBar,.mh-model,.mh-segBtn,.mh-triggerChevron,.mh-search,.mh-searchClear,.mh-provPin{transition-duration:1ms !important}.mh-spin,.mh-skelBar,.mh-mask,.mh-panel,.mh-card{animation-duration:1ms !important;animation-iteration-count:1 !important}}'
	].join('\n')

	var MH_STYLE_ID = 'dsh-model-hub/ui.css'

	function ensureStyle() {
		if (typeof document === 'undefined' || !document.head) return
		if (document.querySelector('style[data-plugin-css=' + JSON.stringify(MH_STYLE_ID) + ']') !== null) return
		var tag = document.createElement('style')
		tag.dataset.plugin = 'dsh-model-hub'
		tag.dataset.pluginCss = MH_STYLE_ID
		tag.textContent = MH_CSS
		document.head.appendChild(tag)
	}

	/* ═══════════════════════════════ 小工具 ═══════════════════════════════ */

	function isRecord(value) {
		return value !== null && typeof value === 'object' && !Array.isArray(value)
	}

	function numOrNull(value) {
		return typeof value === 'number' && isFinite(value) && value > 0 ? value : null
	}

	/** 推理等级**声明**（对象 {档位: API 参数值|null}）→ 有序数组；非对象（未声明/继承）→ null。 */
function normalizeEffortPairs(raw) {
	if (!isRecord(raw)) return null
	var keys = Object.keys(raw)
	var out = []
	for (var i = 0; i < keys.length; i++) {
		var value = raw[keys[i]]
		out.push({ level: keys[i], value: typeof value === 'string' && value !== '' ? value : null })
	}
	return out
}

/** 输入类型：只认 text/image，去重；非数组（未声明）→ null。 */
function normalizeInputModalities(raw) {
	if (!Array.isArray(raw)) return null
	var out = []
	for (var i = 0; i < raw.length; i++) {
		var id = raw[i]
		if (id !== 'text' && id !== 'image') continue
		if (out.indexOf(id) < 0) out.push(id)
	}
	return out
}

function strArray(value) {
		if (!Array.isArray(value)) return []
		var out = []
		for (var i = 0; i < value.length; i++) {
			var item = value[i]
			if (typeof item === 'string' && item !== '' && out.indexOf(item) < 0) out.push(item)
		}
		return out
	}

	function errorMessage(error) {
		if (error === null || error === undefined) return '未知错误'
		if (typeof error === 'string') return error
		if (typeof error.message === 'string' && error.message !== '') return error.message
		return String(error)
	}

	/** 同源 JSON 请求；写请求显式带 content-type（宿主用它挡 CSRF，缺了会 415）。 */
	function fetchJson(path, options) {
		var init = { credentials: 'same-origin', headers: { accept: 'application/json' } }
		var method = options && options.method ? options.method : 'GET'
		init.method = method
		if (options && options.body !== undefined) {
			init.headers['content-type'] = 'application/json'
			init.body = JSON.stringify(options.body)
		}
		var controller = typeof AbortController === 'function' ? new AbortController() : null
		var timer = null
		if (controller !== null) {
			init.signal = controller.signal
			timer = window.setTimeout(function () { try { controller.abort() } catch (ignored) {} }, 10000)
		}
		var clear = function () { if (timer !== null) { window.clearTimeout(timer); timer = null } }
		return window.fetch(path, init).then(function (response) {
			clear()
			if (!response.ok) {
				// 宿主的写接口在拒绝时会用 400 + {ok:false,code,message}（例如旧宿主不认识 inputModalities），
				// 这里要把结构化错误带出来，调用方才能据此降级重试。
				return response.json().then(function (body) {
					var error = new Error(isRecord(body) && typeof body.message === 'string' ? body.message : 'HTTP ' + response.status + ' ' + path)
					error.code = isRecord(body) && typeof body.code === 'string' ? body.code : 'HTTP_' + response.status
					error.status = response.status
					throw error
				}, function () {
					var fallback = new Error('HTTP ' + response.status + ' ' + path)
					fallback.code = 'HTTP_' + response.status
					fallback.status = response.status
					throw fallback
				})
			}
			return response.json()
		}, function (error) {
			clear()
			throw new Error('无法连接宿主接口 ' + path + '（' + errorMessage(error) + '）')
		})
	}

	/** 前缀 / 紧凑度加权的模糊子序列匹配；返回 null 表示不匹配。 */
	function fuzzyMatch(query, text) {
		if (!query) return { score: 0, indexes: [] }
		var q = String(query).toLowerCase().replace(/\s+/g, '')
		var t = String(text === undefined || text === null ? '' : text).toLowerCase()
		if (q === '') return { score: 0, indexes: [] }
		var indexes = []
		var qi = 0
		var score = 0
		var last = -2
		var gaps = 0
		for (var i = 0; i < t.length && qi < q.length; i++) {
			if (t.charAt(i) !== q.charAt(qi)) continue
			if (last >= 0) gaps += i - last - 1
			if (i === last + 1) score += 6
			else if (i === 0 || /[^a-z0-9]/.test(t.charAt(i - 1))) score += 4
			else score += 2
			last = i
			indexes.push(i)
			qi += 1
		}
		if (qi < q.length) return null
		score += Math.max(0, 24 - gaps)
		if (indexes[0] === 0) score += 12
		return { score: score, indexes: indexes }
	}

	function contextLabel(value) {
		if (typeof value !== 'number' || !isFinite(value) || value <= 0) return null
		if (value === 131072) return '128K'
		if (value === 262144) return '256K'
		if (value === 1000000) return '1000K'
		// A3：≥1,000,000 用 1000 进制（10000000 → 10000K，而不是 9766K）。
		return (value >= 1000000 ? Math.round(value / 1000) : Math.round(value / 1024)) + 'K'
	}

	function modelKeyOf(providerId, modelId) {
		return String(providerId) + '/' + String(modelId)
	}

	/** 1017 发布标签的等价条件（与官方 label 插件逐字一致）。 */
	function isFlash1017(providerId, modelId, modelName) {
		return (providerId === 'deepseek-account' || providerId === 'deepseek-official')
			&& modelId === 'deepseek-flash'
			&& modelName === 'DeepSeek-V4.1-Flash'
	}

	/* ═══════════════════════════════ 图标 ═══════════════════════════════ */

	function svg(props, children) {
		return h('svg', {
			width: props.size || 14,
			height: props.size || 14,
			viewBox: '0 0 16 16',
			fill: 'none',
			'aria-hidden': 'true',
			className: props.className,
			style: { display: 'block', flex: 'none' }
		}, children)
	}

	function IconModel(props) {
		return svg({ size: props.size || 16, className: props.className }, [
			h('rect', { key: 'a', x: 2.2, y: 2.2, width: 11.6, height: 11.6, rx: 3.2, stroke: 'currentColor', strokeWidth: 1.3 }),
			h('path', { key: 'b', d: 'M5.6 8h4.8M8 5.6v4.8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' })
		])
	}

	function IconSearch(props) {
		return svg({ size: props.size || 14, className: props.className }, [
			h('circle', { key: 'a', cx: 7.2, cy: 7.2, r: 4.4, stroke: 'currentColor', strokeWidth: 1.3 }),
			h('path', { key: 'b', d: 'M10.6 10.6L13.4 13.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' })
		])
	}

	function IconClose(props) {
		return svg({ size: props.size || 12, className: props.className }, [
			h('path', { key: 'a', d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' })
		])
	}

	/** 刷新（圆形箭头）。 */
	function IconRefresh(props) {
		return svg({ size: props.size || 14, className: props.className }, [
			h('path', { key: 'a', d: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', fill: 'none' }),
			h('path', { key: 'b', d: 'M13.6 2.6v3.2h-3.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' })
		])
	}

	function IconChevronDown(props) {
		return svg({ size: props.size || 14, className: props.className }, [
			h('path', { key: 'a', d: 'M4.2 6.2L8 10l3.8-3.8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' })
		])
	}

	function IconCheck(props) {
		return svg({ size: props.size || 14, className: props.className }, [
			h('path', { key: 'a', d: 'M3.4 8.4l3 3 6.2-6.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' })
		])
	}

	function IconEye(props) {
		return svg({ size: props.size || 12, className: props.className }, [
			h('path', { key: 'a', d: 'M1.6 8s2.4-4 6.4-4 6.4 4 6.4 4-2.4 4-6.4 4-6.4-4-6.4-4z', stroke: 'currentColor', strokeWidth: 1.2 }),
			h('circle', { key: 'b', cx: 8, cy: 8, r: 1.7, stroke: 'currentColor', strokeWidth: 1.2 })
		])
	}

	function IconPin(props) {
		return svg({ size: props.size || 12, className: props.className }, [
			h('path', { key: 'a', d: 'M6.2 2.4h3.6l-.6 3.2 2 1.6v1H4.8v-1l2-1.6-.6-3.2z', stroke: 'currentColor', strokeWidth: 1.1, strokeLinejoin: 'round' }),
			h('path', { key: 'b', d: 'M8 8.2v5.2', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' })
		])
	}

	function IconWarn(props) {
		return svg({ size: props.size || 14, className: props.className }, [
			h('circle', { key: 'a', cx: 8, cy: 8, r: 6.2, stroke: 'currentColor', strokeWidth: 1.2 }),
			h('path', { key: 'b', d: 'M8 4.8v4M8 11.1v.1', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' })
		])
	}

	/** 1017 小标签（复刻官方 label 插件的 Tag tone:"info"）。 */
	function Tag1017() {
		return h('span', { className: 'mh-pill mh-pillInfo' }, '1017')
	}

	/** 模型名 + 可选的 1017 标签；三处（trigger / 行 / 悬浮卡）共用。 */
	function ModelName(props) {
		var children = []
		if (props.highlight && props.indexes && props.indexes.length > 0) {
			var text = String(props.name)
			var set = {}
			for (var i = 0; i < props.indexes.length; i++) set[props.indexes[i]] = true
			var buffer = ''
			var key = 0
			var flush = function () {
				if (buffer === '') return
				children.push(buffer)
				buffer = ''
			}
			for (var p = 0; p < text.length; p++) {
				if (set[p] === true) {
					flush()
					children.push(h('span', { key: 'm' + (key++), className: 'mh-match' }, text.charAt(p)))
				} else buffer += text.charAt(p)
			}
			flush()
		} else {
			children.push(props.name)
		}
		if (props.flash1017) children.push(h(Tag1017, { key: 'tag' }))
		return h('span', { className: 'mh-modelName' }, children)
	}

	/* ═══════════════════════════════ 数据整形 ═══════════════════════════════ */

	function normalizeCatalog(data) {
		var providers = []
		var index = {}
		var list = isRecord(data) && Array.isArray(data.providers) ? data.providers : []
		for (var i = 0; i < list.length; i++) {
			var raw = list[i]
			if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '') continue
			var models = []
			var rawModels = Array.isArray(raw.models) ? raw.models : []
			for (var j = 0; j < rawModels.length; j++) {
				var item = rawModels[j]
				if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') continue
				var efforts = []
				var rawEfforts = Array.isArray(item.efforts) ? item.efforts : []
				for (var k = 0; k < rawEfforts.length; k++) {
					var effort = rawEfforts[k]
					if (!isRecord(effort) || typeof effort.id !== 'string') continue
					var name = typeof effort.name === 'string' && effort.name !== '' ? effort.name
						: typeof effort.label === 'string' && effort.label !== '' ? effort.label : effort.id
					efforts.push({ id: effort.id, name: name })
				}
				// v1.2：模型**声明**的输入类型与推理等级（设置页同款语义）。
				var declaredModalities = normalizeInputModalities(item.declaredInputModalities)
				var declaredEfforts = normalizeEffortPairs(item.declaredReasoningEfforts)
				var model = {
					id: item.id,
					name: typeof item.name === 'string' && item.name !== '' ? item.name : item.id,
					contextWindow: numOrNull(item.contextWindow),
					maxTokens: numOrNull(item.maxTokens),
					vision: declaredModalities !== null ? declaredModalities.indexOf('image') >= 0 : item.vision === true,
					inputModalities: declaredModalities,
					// v1.4：只有确实写在 profile 声明里的模型行才可单独删除。
					declared: item.declared === true,
					declaredEfforts: declaredEfforts,
					efforts: efforts,
					defaultEffort: typeof item.defaultEffort === 'string' ? item.defaultEffort : null,
					resolved: item.resolved !== false,
					resolveError: isRecord(item.resolveError) ? item.resolveError : null,
					upstreamSupported: item.upstreamSupported === true
				}
				models.push(model)
				index[modelKeyOf(raw.id, item.id)] = model
			}
			providers.push({
				id: raw.id,
				name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : raw.id,
				api: typeof raw.api === 'string' ? raw.api : null,
				baseURL: typeof raw.baseURL === 'string' ? raw.baseURL : null,
				apiKeyEnv: typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv : null,
				hasKey: raw.hasKey !== false,
				declared: raw.declared === true,
				pending: raw.pending === true,
				error: typeof raw.error === 'string' ? raw.error : null,
				models: models
			})
		}
		return {
			providers: providers,
			index: index,
			order: strArray(isRecord(data) ? data.order : null),
			pinned: strArray(isRecord(data) ? data.pinned : null)
		}
	}

	function normalizePrefs(raw) {
		var source = isRecord(raw) ? raw : {}
		var overrides = {}
		if (isRecord(source.overrides)) {
			var keys = Object.keys(source.overrides)
			for (var i = 0; i < keys.length; i++) {
				if (isRecord(source.overrides[keys[i]])) overrides[keys[i]] = source.overrides[keys[i]]
			}
		}
		return { order: strArray(source.order), pinned: strArray(source.pinned), overrides: overrides }
	}

	/** 与宿主 catalog.applyOrder 同语义的客户端排序（便于拖拽时乐观更新）。 */
	function orderProviderIds(ids, prefs) {
		var pinned = prefs && Array.isArray(prefs.pinned) ? prefs.pinned : []
		var order = prefs && Array.isArray(prefs.order) ? prefs.order : []
		var out = ids.slice()
		var preferred = function (id) {
			return id === 'deepseek-account' ? 0 : id === 'deepseek' || id.indexOf('deepseek-') === 0 ? 1 : 2
		}
		out.sort(function (a, b) {
			var pa = pinned.indexOf(a)
			var pb = pinned.indexOf(b)
			if (pa >= 0 || pb >= 0) {
				if (pa < 0) return 1
				if (pb < 0) return -1
				return pa - pb
			}
			var oa = order.indexOf(a)
			var ob = order.indexOf(b)
			if (oa >= 0 || ob >= 0) {
				if (oa < 0) return 1
				if (ob < 0) return -1
				return oa - ob
			}
			return preferred(a) - preferred(b)
		})
		return out
	}

	/** v1.4：该模型是否写在 profile 声明里（可单独删除）。 */
	function catalogDeclaredOf(catalog, providerId, modelId) {
		var base = catalog && catalog.index ? catalog.index[modelKeyOf(providerId, modelId)] : null
		return base !== null && base !== undefined && base.declared === true
	}

	/** 合并 catalog 元数据与本地乐观覆盖。 */
	function metaOf(catalog, overrides, providerId, modelId) {
		var key = modelKeyOf(providerId, modelId)
		var base = catalog && catalog.index ? catalog.index[key] : null
		var override = overrides ? overrides[key] : null
		if (!base && !override) return null
		var pick = function (field) {
			if (override && override[field] !== undefined && override[field] !== null) return override[field]
			return base ? base[field] : null
		}
		var modalities = override && Array.isArray(override.inputModalities)
			? override.inputModalities
			: base && Array.isArray(base.inputModalities) ? base.inputModalities : null
		// 有声明就按声明派生 vision（与设置页一致），否则退回宿主给的 vision 布尔。
		var vision = modalities !== null ? modalities.indexOf('image') >= 0 : pick('vision') === true
		return {
			contextWindow: pick('contextWindow'),
			maxTokens: pick('maxTokens'),
			vision: vision,
			// 声明类字段：override 优先，其次 catalog 的 declared*/vision 派生值。
			inputModalities: override && Array.isArray(override.inputModalities)
				? override.inputModalities.slice()
				: base && Array.isArray(base.inputModalities) ? base.inputModalities.slice() : null,

			// 「是否已声明推理等级」= profile 声明层有没有这块（继承不算）。
			declared: base ? base.declared === true : false,
			declaredEfforts: override && Array.isArray(override.declaredEfforts)
				? override.declaredEfforts
				: base && Array.isArray(base.declaredEfforts) ? base.declaredEfforts : null,
			efforts: base && Array.isArray(base.efforts) ? base.efforts : [],
			defaultEffort: base ? base.defaultEffort : null,
			resolved: base ? base.resolved : true,
			resolveError: base ? base.resolveError : null,
			overridden: override !== null && override !== undefined
		}
	}

	/** 组装左栏/右栏所需的提供商视图（目录为主、catalog 增补元数据）。 */
	function buildProviders(state, catalog, prefs, overrides) {
		var groups = state && Array.isArray(state.groups) ? state.groups : []
		var groupById = {}
		var ids = []
		var i
		for (i = 0; i < groups.length; i++) {
			var group = groups[i]
			if (!isRecord(group) || typeof group.id !== 'string') continue
			groupById[group.id] = group
			if (ids.indexOf(group.id) < 0) ids.push(group.id)
		}
		var catById = {}
		var catProviders = catalog && Array.isArray(catalog.providers) ? catalog.providers : []
		for (i = 0; i < catProviders.length; i++) {
			catById[catProviders[i].id] = catProviders[i]
			if (ids.indexOf(catProviders[i].id) < 0) ids.push(catProviders[i].id)
		}
		var ordered = orderProviderIds(ids, prefs)
		var out = []
		for (i = 0; i < ordered.length; i++) {
			var id = ordered[i]
			var g = groupById[id]
			var cp = catById[id]
			var models = []
			var selectable = false
			if (g && Array.isArray(g.models) && g.models.length > 0) {
				selectable = true
				for (var j = 0; j < g.models.length; j++) {
					var m = g.models[j]
					if (!isRecord(m) || typeof m.id !== 'string') continue
					models.push({
						id: m.id,
						name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id,
						reasoning: isRecord(m.reasoning) ? m.reasoning : null,
						meta: metaOf(catalog, overrides, id, m.id),
						declared: catalogDeclaredOf(catalog, id, m.id),
						selectable: true
					})
				}
			} else if (cp && Array.isArray(cp.models)) {
				for (var k = 0; k < cp.models.length; k++) {
					var cm = cp.models[k]
					models.push({
						id: cm.id,
						name: cm.name || cm.id,
						reasoning: null,
						meta: metaOf(catalog, overrides, id, cm.id),
						declared: catalogDeclaredOf(catalog, id, cm.id),
						selectable: false
					})
				}
			}
			out.push({
				id: id,
				name: cp && cp.name ? cp.name : g && typeof g.name === 'string' && g.name !== '' ? g.name : id,
				hasKey: cp ? cp.hasKey !== false : true,
				// Bug 2 修复：discover 必须带 baseURL/api/apiKeyEnv ⇒ 视图要保留 catalog 里这几个字段
				api: cp && typeof cp.api === 'string' ? cp.api : null,
				baseURL: cp && typeof cp.baseURL === 'string' ? cp.baseURL : null,
				apiKeyEnv: cp && typeof cp.apiKeyEnv === 'string' ? cp.apiKeyEnv : null,
				declared: cp ? cp.declared === true : g !== undefined,
				pending: cp ? cp.pending === true : false,
				error: cp && cp.error ? cp.error : null,
				models: models,
				selectable: selectable
			})
		}
		// B1/B2（task-9）：左栏只列「有模型 或 已声明 或 待选模型(pending)」的提供商 ——
		// 这样刚添加的草稿也能出现在左栏里（用户才点得进去刷新）；
		// 内置但未声明的 40+ 个不再以折叠区形式出现（那一条按用户要求整条去掉）。
		var visible = []
		var hidden = []
		for (i = 0; i < out.length; i++) {
			var entryView = out[i]
			if (entryView.models.length > 0 || entryView.declared === true || entryView.pending === true || groupById[entryView.id] !== undefined) visible.push(entryView)
			else hidden.push(entryView)
		}
		// all = 全局有序（orderProviderIds 语义），全局搜索的分组顺序用它。
		return { list: visible, hidden: hidden, all: out }
	}

	function findModel(state, providerId, modelId) {
		var groups = state && Array.isArray(state.groups) ? state.groups : []
		for (var i = 0; i < groups.length; i++) {
			if (groups[i].id !== providerId) continue
			var models = Array.isArray(groups[i].models) ? groups[i].models : []
			for (var j = 0; j < models.length; j++) if (models[j].id === modelId) return models[j]
		}
		return null
	}

	/** trigger 上显示的模型名 + 档位名（真状态来自会话目录）。 */
	function triggerTextOf(state) {
		var current = state && state.current ? state.current : null
		if (!current) return { name: null, effort: null }
		var row = findModel(state, current.provider, current.model)
		var name = row && typeof row.name === 'string' && row.name !== '' ? row.name : current.model
		var effort = null
		var reasoning = row && isRecord(row.reasoning) ? row.reasoning : null
		if (reasoning && Array.isArray(reasoning.efforts) && reasoning.efforts.length > 0) {
			var effective = current.reasoningEffort
			if (effective === undefined || effective === null) effective = reasoning.defaultEffort
			if (effective === undefined || effective === null) effort = state.retainedEffort || 'Default'
			else {
				var hit = null
				for (var i = 0; i < reasoning.efforts.length; i++) if (reasoning.efforts[i].id === effective) hit = reasoning.efforts[i]
				effort = hit ? effortLabelOf(hit) : effective
			}
		} else if (state.retainedEffort) effort = state.retainedEffort
		return { name: name, effort: effort }
	}

	/* ══════════════════════════ 基础 UI 组件 ══════════════════════════ */

	/**
	 * 内部错误边界：子树渲染异常只降级这一块（触发器永远活着），
	 * 不让 renderer 的 SlotErrorBoundary 把整条 slot 条目 abdicate —— 那会让插件“看起来完全没生效”。
	 */
	class HubBoundary extends React.Component {
		constructor(props) {
			super(props)
			this.state = { failed: false }
		}
		static getDerivedStateFromError() { return { failed: true } }
		componentDidCatch(error) {
			console.warn('[dsh-model-hub] 子树渲染失败，已就地降级：', error)
			if (typeof this.props.onFatal !== 'function' || this.fatalReported === true) return
			this.fatalReported = true
			var onFatal = this.props.onFatal
			// React 的 fallback 与整个 seat 会随“让位”一起卸载 —— 另留一条**不被卸载**的普通 DOM 提示，
			// 这样用户既拿到回退后的内置选择器，也能看到发生了什么（8s 后自动消失）。
			try {
				var notice = document.createElement('div')
				notice.className = 'mh-fallback'
				notice.setAttribute('role', 'alert')
				notice.setAttribute('data-model-hub', 'fatal-notice')
				notice.textContent = typeof this.props.noticeText === 'string' ? this.props.noticeText : ''
				document.body.appendChild(notice)
				window.setTimeout(function () { if (notice.parentNode !== null) notice.parentNode.removeChild(notice) }, 8000)
			} catch (ignored) {}
			// 延后一拍再让位：不在 commit 阶段直接改动 slot 注册表（避免重入）。
			window.setTimeout(function () {
				try { onFatal() } catch (ignored) { console.warn('[dsh-model-hub] 让位失败，保持降级提示：', ignored) }
			}, 0)
		}
		render() {
			if (this.state.failed) return this.props.fallback === undefined ? null : this.props.fallback
			return this.props.children
		}
	}

	/** 复选（设置页同款语义）：role=checkbox，最后一个勾选由调用方 disabled。 */
	function Check(props) {
		return h('button', {
			type: 'button',
			className: 'mh-check',
			role: 'checkbox',
			'aria-checked': props.checked === true ? 'true' : 'false',
			disabled: props.disabled === true,
			title: props.title || props.label,
			onClick: function () { if (props.disabled !== true) props.onChange(props.checked !== true) }
		}, [
			h('span', { key: 'b', className: 'mh-checkBox' }, props.checked === true ? h(IconCheck, { size: 9 }) : null),
			h('span', { key: 'l' }, props.label)
		])
	}

	function Segmented(props) {
		return h('div', { className: 'mh-seg', role: 'group', 'aria-label': props.label },
			props.options.map(function (option) {
				var on = option.value === props.value
				return h('button', {
					key: String(option.value),
					type: 'button',
					className: 'mh-segBtn',
					'data-on': on ? 'true' : 'false',
					'data-model-hub': props.hub,
					'data-warn': option.warn === true ? 'true' : 'false',
					'aria-pressed': on ? 'true' : 'false',
					disabled: props.disabled === true || option.disabled === true,
					title: option.title || option.label,
					onClick: function () { if (!on || props.reclick === true) props.onChange(option.value) }
				}, option.label)
			}))
	}

	function Spinner(props) {
		return h('span', { className: props.small ? 'mh-spin mh-spinSm' : 'mh-spin', 'aria-hidden': 'true' })
	}

	function Strip(props) {
		return h('div', { className: 'mh-strip ' + (props.tone === 'error' ? 'mh-stripError' : 'mh-stripWarn'), role: 'status' }, [
			h(IconWarn, { key: 'i', size: 14 }),
			h('span', { key: 't', className: 'mh-stripText' }, props.text),
			props.onRetry ? h('button', { key: 'r', type: 'button', className: 'mh-link', onClick: props.onRetry }, TEXT.retry) : null
		])
	}

	function SkeletonRows() {
		var rows = []
		for (var i = 0; i < 6; i++) {
			rows.push(h('div', { key: i, className: 'mh-skelRow' }, [
				h('span', { key: 'c', className: 'mh-skelBar', style: { width: '16px', height: '16px', borderRadius: '999px' } }),
				h('span', { key: 'n', className: 'mh-skelBar', style: { flex: '1', maxWidth: (220 + (i % 3) * 90) + 'px' } }),
				h('span', { key: 'b', className: 'mh-skelBar', style: { width: '52px' } })
			]))
		}
		return h('div', { className: 'mh-list' }, rows)
	}

	/* ══════════════════════════ 悬浮能力卡 ══════════════════════════ */

	function HoverCard(props) {
		var model = props.model
		var provider = props.provider
		var meta = model.meta
		var writable = props.writable
		var busyField = props.busyField
		var isCurrent = props.isCurrent
		var cardRef = props.cardRef
		var clampedEffort = props.currentEffort
		var liveSelectable = model.selectable === true

		// A3：异常阈值（只警告不阻止）。
		var contextOptions = buildStepOptions(CTX_STEPS, meta ? meta.contextWindow : null, ANOMALY_CONTEXT)
		var outputOptions = buildStepOptions(OUT_STEPS, meta ? meta.maxTokens : null, ANOMALY_OUTPUT)
		var contextAnomaly = !!(meta && typeof meta.contextWindow === 'number' && meta.contextWindow > ANOMALY_CONTEXT && CTX_STEPS.indexOf(meta.contextWindow) < 0)
		var outputAnomaly = !!(meta && typeof meta.maxTokens === 'number' && meta.maxTokens > ANOMALY_OUTPUT && OUT_STEPS.indexOf(meta.maxTokens) < 0)
		var efforts = meta && Array.isArray(meta.efforts) ? meta.efforts : []
		// task-7：声明层有没有 reasoningEfforts（继承不算「已声明」）。
		var declaredEfforts = meta && Array.isArray(meta.declaredEfforts) ? meta.declaredEfforts : null
		// 已声明 → 用声明里的档位（自定义档位也照实显示，避免 select 一个不存在的档）；
		// 未声明 → 固定显示设置页默认四档（关/低/中/高）。
		var effortChoices = declaredEfforts !== null && declaredEfforts.length > 0
			? declaredEfforts.map(function (pair) {
				var hit = null
				for (var i = 0; i < efforts.length; i++) if (efforts[i].id === pair.level) hit = efforts[i]
				return { value: pair.level, label: effortLabelOf(hit || { id: pair.level, name: pair.level }), title: pair.value === null ? TEXT.effortsOffValue : pair.value }
			})
			: STANDARD_EFFORT_CHOICES.map(function (level) { return { value: level, label: effortLabelOf({ id: level }), title: level } })

		var effortValue = null
		if (efforts.length > 0) {
			effortValue = isCurrent && clampedEffort !== undefined && clampedEffort !== null ? clampedEffort : meta.defaultEffort
			if (effortValue === undefined) effortValue = null
		}

		// §11.1（lead 更正 1）：只保留设置页同款的**输入类型**（inputModalities）；
		// 「推理等级」编辑器按用户裁定删除 —— 它与本会话的「思考档位」不是一回事，不动思考档位。
		var modalities = meta && Array.isArray(meta.inputModalities)
			? meta.inputModalities.slice()
			: meta && meta.vision === true ? ['text', 'image'] : ['text']
		var localErrorState = React.useState(null)
		var localError = localErrorState[0]
		var setLocalError = localErrorState[1]

		var toggleModality = function (id) {
			var next = modalities.indexOf(id) >= 0
				? modalities.filter(function (item) { return item !== id })
				: modalities.concat([id])
			if (next.length === 0) { setLocalError(TEXT.errModalityMin); return }
			// 规范化顺序（text 在前），并过滤未知项。
			next = ['text', 'image'].filter(function (item) { return next.indexOf(item) >= 0 })
			setLocalError(null)
			props.onWrite('input', { inputModalities: next })
		}

		// 紧凑卡片（用户反馈“像一整个界面”）：200px 宽、四行左标签右控件、无副标题、无常驻说明。
		var labelOf = function (field, text) {
			return busyField === field ? h('span', { className: 'mh-fieldLabel' }, h(Spinner, { small: true })) : h('span', { className: 'mh-fieldLabel' }, text)
		}

		return h('div', {
			ref: cardRef,
			className: 'mh-card',
			'data-side': props.side || 'right',
			style: props.anchored === 'bottom'
				? { left: props.left + 'px', top: 'auto', bottom: props.bottom + 'px' }
				: { left: props.left + 'px', top: props.top + 'px' },
			role: 'dialog',
			'aria-label': TEXT.dialogLabel + ' · ' + model.name,
			'data-model-hub': 'card',
			title: provider.name + ' · ' + model.id + ' · ' + (writable ? TEXT.footer : TEXT.metaDown),
			onMouseEnter: props.onMouseEnter,
			onMouseLeave: props.onMouseLeave
		}, [
			h('div', { key: 'head', className: 'mh-cardHead' }, [
				h('div', { key: 't', className: 'mh-cardTitle', title: model.name }, [
					h('span', { key: 'n', className: 'mh-cardName' }, model.name),
					isFlash1017(provider.id, model.id, model.name) ? h(Tag1017, { key: 'tag' }) : null
				])
			]),

			meta === null
				? h('div', { key: 'nometa', className: 'mh-fieldNote' }, TEXT.metaDown)
				: null,

			h('div', { key: 'ctx', className: 'mh-field' }, [
				h('div', { key: 'r', className: 'mh-fieldRow' }, [
					labelOf('context', TEXT.context),
					h('div', { key: 'c', className: 'mh-fieldCtl' },
						h(Segmented, {
							key: 'seg',
							label: TEXT.context,
							value: meta ? meta.contextWindow : null,
							options: contextOptions,
							disabled: !writable || busyField === 'context',
							onChange: function (value) { props.onWrite('context', { contextWindow: value }) }
						}))
				]),
				contextAnomaly ? h('span', { key: 'w', className: 'mh-fieldWarn' }, TEXT.valueAnomaly) : null
			]),

			h('div', { key: 'out', className: 'mh-field' }, [
				h('div', { key: 'r', className: 'mh-fieldRow' }, [
					labelOf('output', TEXT.output),
					h('div', { key: 'c', className: 'mh-fieldCtl' },
						h(Segmented, {
							key: 'seg',
							label: TEXT.output,
							value: meta ? meta.maxTokens : null,
							options: outputOptions,
							disabled: !writable || busyField === 'output',
							onChange: function (value) { props.onWrite('output', { maxTokens: value }) }
						}))
				]),
				outputAnomaly ? h('span', { key: 'w', className: 'mh-fieldWarn' }, TEXT.valueAnomalyOutput) : null
			]),

			// 输入类型（设置页同款）：至少保留一个，最后一个勾选 disabled。
			h('div', { key: 'modalities', className: 'mh-field' },
				h('div', { key: 'r', className: 'mh-fieldRow', title: meta && Array.isArray(meta.inputModalities) ? TEXT.inputType : TEXT.modalitiesInherited }, [
					labelOf('input', TEXT.inputType),
					h('div', { key: 'c', className: 'mh-fieldCtl mh-modalities' }, [
						h(Check, {
							key: 'text',
							label: TEXT.modalityText,
							checked: modalities.indexOf('text') >= 0,
							disabled: !writable || (modalities.length === 1 && modalities.indexOf('text') >= 0),
							onChange: function () { toggleModality('text') }
						}),
						h(Check, {
							key: 'image',
							label: TEXT.modalityImage,
							checked: modalities.indexOf('image') >= 0,
							disabled: !writable || (modalities.length === 1 && modalities.indexOf('image') >= 0),
							onChange: function () { toggleModality('image') }
						})
					])
				])),

			// task-7：**始终显示**的「推理等级」行（设置页同款四档；不做增删）。
			// 已声明 → 点击 = 本会话选该档；未声明 → 先写默认声明再 select；旧宿主写不了则不 select、只提示。
			h('div', { key: 'effort', className: 'mh-field' }, [
				h('div', { key: 'r', className: 'mh-fieldRow' }, [
					labelOf('effort', TEXT.effortRow),
					h('div', { key: 'c', className: 'mh-fieldCtl' },
						h(Segmented, {
							key: 'seg',
							hub: 'effort-level',
							label: TEXT.effort,
							value: effortValue,
							options: effortChoices,
							// 档位对所有可选中模型开放。不是当前模型时，点一下 = 原子地
							// select({provider, model, reasoningEffort})（同时切模型并应用档位）；
							// reclick：连“已经是该档位”的那一段也能点（否则用户点它毫无反应）。
							disabled: liveSelectable !== true || busyField === 'effort',
							reclick: isCurrent !== true,
							onChange: function (value) {
								if (declaredEfforts !== null) props.onEffort(value)
								else props.onEffortDeclare(value)
							}
						}))
				]),
				!isCurrent ? h('span', { key: 'n', className: 'mh-fieldNote' }, TEXT.effortNotCurrent) : null,
				!isCurrent ? null : declaredEfforts === null
					? h('span', { key: 'u', className: 'mh-fieldNote' }, TEXT.effortUndeclared)
					: null
			]),
			localError ? h('div', { key: 'localerr', className: 'mh-cardError', role: 'alert' }, [
				h('span', { key: 'd', className: 'mh-dot' }),
				h('span', { key: 'm' }, localError)
			]) : null,
			props.note ? h('div', { key: 'note', className: 'mh-cardNote' }, props.note) : null,
			props.preparedNote ? h('div', { key: 'prep', className: 'mh-cardFoot' }, h('span', null, props.preparedNote)) : null,
			props.error ? h('div', { key: 'err', className: 'mh-cardError', role: 'alert' }, [
				h('span', { key: 'd', className: 'mh-dot' }),
				h('span', { key: 'm' }, props.error)
			]) : null
		])
	}

	/** 三档/两档分段选项；当前值不在档位内时补一个 current 段（design-spec §6）。 */
	function buildStepOptions(steps, current, anomalyLimit) {
		var anomalous = typeof current === 'number' && typeof anomalyLimit === 'number' && current > anomalyLimit && steps.indexOf(current) < 0
		var options = steps.map(function (value) {
			return { value: value, label: contextLabel(value), title: String(value) + ' tokens' }
		})
		if (typeof current === 'number' && current > 0 && steps.indexOf(current) < 0) {
			options.push({
				value: current,
				label: contextLabel(current),
				title: String(current) + ' tokens',
				warn: anomalous
			})
		}
		return options
	}

	/* ══════════════════════════ 弹窗主体 ══════════════════════════ */

	function ModelHubDialog(props) {
		// 调试开关（给 verifier 造“必然渲染失败”用）：控制台执行
		//   window.__DSH_MODEL_HUB_DEBUG_CRASH__ = true
		// 后点开模型位，即可验证降级提示确实可见；生产路径不读任何查询参数。
		if (typeof window !== 'undefined' && window.__DSH_MODEL_HUB_DEBUG_CRASH__ === true) {
			throw new Error('dsh-model-hub: debug crash via window.__DSH_MODEL_HUB_DEBUG_CRASH__')
		}
		var state = props.state
		var providerViews = props.providers
		var providers = Array.isArray(providerViews) ? providerViews : providerViews.list
		var hiddenProviders = Array.isArray(providerViews) ? [] : providerViews.hidden
		var allProviders = Array.isArray(providerViews) ? providerViews : providerViews.all
		var catalogReady = props.catalogReady

		var panelRef = React.useRef(null)
		// §11.3（lead 更正）：指针位置 ref —— 只在行 mouseenter 那一刻取一次，用于“出现时定位”。
		var pointer = React.useRef({ x: 0, y: 0 })
		// ── 布局：B 方案（贴 composer 的小浮层）；窄/矮视口回退居中弹窗 ──
		var viewport = useViewport()
		var popover = viewport.w >= 520 && viewport.h >= 560
		var leftColumnWidth = popover ? (viewport.w < 760 ? 150 : 168) : 236
		var tickState = React.useState(0)
		var bumpTick = tickState[1]
		// 卡片高度：先渲染→挂载后实测→用实测值纠正落位（useLayoutEffect 在 paint 前跑，用户看不到中间态）。
		var cardSizeState = React.useState(0)
		var cardHeight = cardSizeState[0]
		var setCardHeight = cardSizeState[1]
		// B 方案：面板几何由模型位（优先整个输入栏卡片）推出；居中模式为 null。
		// 必须在任何 hook 的依赖数组之前算出来 —— 否则 var 提升会让依赖读到 undefined。
		var panelGeometry = popover ? popoverRectOf(composerAnchorOf(props.triggerRef), viewport, 10) : null
		// 浮层锚点跟 composer 走：窗口缩放 / 输入栏变高（多行）都要重算。
		// 锚点优先用**整个输入栏卡片**（用户要的是“浮在聊天栏上面”），拿不到才退回模型位。
		React.useEffect(function () {
			if (!popover) return undefined
			var observed = composerAnchorOf(props.triggerRef)
			if (observed === null) return undefined
			var bump = function () { bumpTick(function (n) { return n + 1 }) }
			window.addEventListener('resize', bump)
			var observer = null
			if (observed && typeof ResizeObserver === 'function') {
				observer = new ResizeObserver(bump)
				observer.observe(observed)
			}
			return function () {
				window.removeEventListener('resize', bump)
				if (observer) observer.disconnect()
			}
		}, [popover, bumpTick])
		var searchRef = React.useRef(null)
		var listRef = React.useRef(null)
		var cardRef = React.useRef(null)
		var rowRefs = React.useRef({})
		var openTimer = React.useRef(null)
		var closeTimer = React.useRef(null)
		var mountedRef = React.useRef(true)

		var queryState = React.useState('')
		var query = queryState[0]
		var setQuery = queryState[1]
		var pickedState = React.useState(null)
		var pickedId = pickedState[0]
		var setPickedId = pickedState[1]
		var hlState = React.useState(0)
		var hlIndex = hlState[0]
		var setHlIndex = hlState[1]
		var cardState = React.useState(null)
		var card = cardState[0]
		var setCard = cardState[1]
		var cardPosState = React.useState(null)
		var cardPos = cardPosState[0]
		var setCardPos = cardPosState[1]
		var busySelectState = React.useState(false)
		var busySelect = busySelectState[0]
		var setBusySelect = busySelectState[1]
		var busyFieldState = React.useState(null)
		var busyField = busyFieldState[0]
		var setBusyField = busyFieldState[1]
		var cardErrorState = React.useState(null)
		var cardError = cardErrorState[0]
		var setCardError = cardErrorState[1]
		var legacyState = React.useState(false)
		var legacyInput = legacyState[0]
		var setLegacyInput = legacyState[1]
		var cardNoteState = React.useState(null)
		var cardNote = cardNoteState[0]
		var setCardNote = cardNoteState[1]
		var legacyWarned = React.useRef(false)
		var preparedState = React.useState(null)
		var preparedNote = preparedState[0]
		var setPreparedNote = preparedState[1]
		var actionErrorState = React.useState(null)
		var actionError = actionErrorState[0]
		var setActionError = actionErrorState[1]
		var dragState = React.useState(null)
		var draggingId = dragState[0]
		var setDraggingId = dragState[1]
		// v1.4 模型删除：待确认的行 key（第一次点=进入确认，第二次点=真删）+ 自动取消定时器
		var removeKeyState = React.useState(null)
		var removeModelKey = removeKeyState[0]
		var setRemoveModelKey = removeKeyState[1]
		var removeTimerRef = React.useRef(null)
		// task-9 B：面板模式（列表 / 添加提供商表单 / 获取模型勾选）
		var panelModeState = React.useState('list')
		var panelMode = panelModeState[0]
		var setPanelMode = panelModeState[1]
		// 添加提供商表单
		var providerDraftState = React.useState({ id: '', displayName: '', api: PROVIDER_APIS[0].id, baseURL: '', apiKeyEnv: '' })
		var providerDraft = providerDraftState[0]
		var setProviderDraft = providerDraftState[1]
		var providerErrorState = React.useState(null)
		var providerError = providerErrorState[0]
		var setProviderError = providerErrorState[1]
		var providerBusyState = React.useState(false)
		var providerBusy = providerBusyState[0]
		var setProviderBusy = providerBusyState[1]
		// 获取模型界面：{ provider, loading, error, models:[{id,name,selected}], query }
		var discoverState = React.useState(null)
		var discover = discoverState[0]
		var setDiscover = discoverState[1]
		// 协议下拉：默认用内置列表；打开表单时向宿主取 /provider-templates 覆盖（宿主说以它的顺序为准）
		var protocolsState = React.useState(PROVIDER_APIS)
		var providerProtocols = protocolsState[0]
		var setProviderProtocols = protocolsState[1]
		var templatesState = React.useState([])
		var providerTemplates = templatesState[0]
		var setProviderTemplates = templatesState[1]
		var actionErrorState = React.useState(null)
		var actionError = actionErrorState[0]
		var setActionError = actionErrorState[1]
		// 打开添加表单：拉模板（协议顺序 + 目录路由默认 BaseURL 都来自宿主）
		var openProviderForm = function () {
			setProviderError(null)
			setPanelMode('add')
			fetchJson(API_PROVIDER_TEMPLATES, {}).then(function (data) {
				if (!isRecord(data) || data.ok !== true) return
				var list = Array.isArray(data.templates) ? data.templates : []
				setProviderTemplates(list)
				var ids = Array.isArray(data.protocols) && data.protocols.length > 0 ? data.protocols : null
				if (ids !== null) {
					setProviderProtocols(ids.map(function (id) {
						var hit = null
						for (var i = 0; i < PROVIDER_APIS.length; i++) if (PROVIDER_APIS[i].id === id) hit = PROVIDER_APIS[i]
						return { id: id, label: hit ? hit.label : id }
					}))
				}
			}, function () { /* 取不到就用内置列表，表单照常可用 */ }).catch(function () { /* ok:false 也兜住，表单回落内置协议列表 */ })
		}
		var dropState = React.useState(null)
		var dropTarget = dropState[0]
		var setDropTarget = dropState[1]

		React.useEffect(function () {
			mountedRef.current = true
			return function () {
				mountedRef.current = false
				if (openTimer.current !== null) window.clearTimeout(openTimer.current)
				if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
			}
		}, [])

		React.useEffect(function () {
			if (!cardError) return undefined
			var timer = window.setTimeout(function () { if (mountedRef.current) setCardError(null) }, 4000)
			return function () { window.clearTimeout(timer) }
		}, [cardError])

		// 打开时焦点落到搜索框（design-spec §7）。
		React.useEffect(function () {
			if (searchRef.current && typeof searchRef.current.focus === 'function') searchRef.current.focus()
		}, [])

		// 可见/折叠两张表由 buildProviders 按“目录里有没有它”切好（Lead 规则）：
		// 主列表 = 用户真配过的提供商；折叠区 = 仅有 catalog 且 0 模型的内置 provider。
		var withModels = providers
		var withoutModels = hiddenProviders
		var i = 0
		var currentProviderId = state && state.current ? state.current.provider : null
		var active = null
		for (i = 0; i < providers.length; i++) if (providers[i].id === pickedId) active = providers[i]
		if (active === null) for (i = 0; i < withoutModels.length; i++) if (withoutModels[i].id === pickedId) active = withoutModels[i]
		if (active === null) for (i = 0; i < providers.length; i++) if (providers[i].id === currentProviderId) active = providers[i]
		if (active === null) active = providers.length > 0 ? providers[0] : withoutModels.length > 0 ? withoutModels[0] : null

		// case 3：directory.failures 记录的是'该提供商整体加载失败'；把它带进渲染，绝不显示空白。
		var failureOf = function (providerId) {
			var failures = state && Array.isArray(state.failures) ? state.failures : []
			for (var index = 0; index < failures.length; index++) {
				var failure = failures[index]
				if (isRecord(failure) && failure.id === providerId) return failure
			}
			return null
		}
		var activeFailure = active === null ? null : failureOf(active.id)

		var queryText = query.trim()

		// 全局搜索（design-spec §10 修订 v1.1）：查询非空时跨**全部** provider（含折叠区）搜索，
		// 右栏按 provider 分组平铺；组顺序沿用 orderProviderIds（= allProviders 的顺序），
		// 组内沿用 rankByName（score 降序）。查询为空时行为与以前完全一致。
		// §11.4：全局搜索，但**当前提供商**（左栏选中项）的命中排最前并带「当前」标记；
		// 其余组顺序沿用 orderProviderIds（= allProviders 的顺序）。
		var currentProviderId = active === null ? null : active.id

		// §11.4 + lead 更正 2：搜索时右栏**默认只显示当前提供商的命中**；
		// 其他渠道的相似命中收在列表最底部的「展开其他渠道的相似模型（N）」里。
		// 基准串：有查询 = 查询；无查询 = **当前会话模型的名字**（同名模型可能分布在多个渠道）。
		var currentModelName = null
		if (state && state.current) {
			var currentRow = findModel(state, state.current.provider, state.current.model)
			currentModelName = currentRow && typeof currentRow.name === 'string' && currentRow.name !== '' ? currentRow.name : state.current.model
		}
		var searchBase = queryText !== '' ? queryText : currentModelName === null ? '' : currentModelName

		var hitGroups = React.useMemo(function () {
			if (searchBase === '') return []
			var groups = []
			for (var index = 0; index < allProviders.length; index++) {
				var provider = allProviders[index]
				var hits = []
				for (var mi = 0; mi < provider.models.length; mi++) {
					var model = provider.models[mi]
					var byName = fuzzyMatch(searchBase, model.name)
					var byId = fuzzyMatch(searchBase, model.id)
					var best = byName && byId ? (byName.score >= byId.score ? byName : byId) : byName || byId
					if (best === null) continue
					hits.push({ model: model, score: best.score, indexes: best.indexes })
				}
				if (hits.length === 0) continue
				hits.sort(function (left, right) { return right.score - left.score })
				groups.push({ provider: provider, rows: hits, current: provider.id === currentProviderId })
			}
			return groups
		}, [allProviders, searchBase, currentProviderId])

		// A1 根因：这些分组原先在 render 期间现算 ⇒ 每次 render 都是新数组身份，
		// 导致 listModel / rowsState 也每次变新 ⇒ 下面的 scrollIntoView effect 每次 render 都跑，
		// hover 引发的重渲染会把滚动位置拉回高亮行（实测 scrollTop 1184 → 2）。必须 memo 化。
		var grouped = React.useMemo(function () {
			var current = null
			var others = []
			var otherCount = 0
			var currentCount = 0
			for (var i = 0; i < hitGroups.length; i++) {
				if (hitGroups[i].provider.id === currentProviderId) {
					current = hitGroups[i]
					currentCount = current.rows.length
				} else {
					others.push(hitGroups[i])
					otherCount += hitGroups[i].rows.length
				}
			}
			return { current: current, others: others, otherCount: otherCount, currentCount: currentCount }
		}, [hitGroups, currentProviderId])
		var currentGroup = grouped.current
		var otherGroups = grouped.others
		var otherHitCount = grouped.otherCount
		var currentHitsCount = grouped.currentCount
		// 默认收起；基准串变化时回到收起态。
		var showOthersState = React.useState(false)
		var showOthers = showOthersState[0]
		var setShowOthers = showOthersState[1]
		React.useEffect(function () { setShowOthers(false) }, [searchBase])

		// 列表模型：节点（组头 / 行 / 展开行）+ 扁平行轴（键盘高亮、Enter、aria-activedescendant）。
		var listModel = React.useMemo(function () {
			var nodes = []
			var rows = []
			var pushRow = function (provider, model, indexes) {
				rows.push({ provider: provider, model: model, indexes: indexes })
				nodes.push({ kind: 'row', index: rows.length - 1 })
			}
			var pushHead = function (provider, current, count) {
				nodes.push({ kind: 'head', key: provider.id, provider: provider, current: current, count: count })
			}
			if (queryText === '') {
				if (active !== null) for (var i = 0; i < active.models.length; i++) pushRow(active, active.models[i], null)
			} else if (currentGroup !== null) {
				pushHead(currentGroup.provider, true, currentGroup.rows.length)
				for (var j = 0; j < currentGroup.rows.length; j++) pushRow(currentGroup.provider, currentGroup.rows[j].model, currentGroup.rows[j].indexes)
			}
			if (otherHitCount > 0) {
				nodes.push({ kind: 'toggle', count: otherHitCount, expanded: showOthers })
				if (showOthers || (queryText !== '' && currentGroup === null)) {
					for (var g = 0; g < otherGroups.length; g++) {
						var group = otherGroups[g]
						pushHead(group.provider, false, group.rows.length)
						for (var k = 0; k < group.rows.length; k++) pushRow(group.provider, group.rows[k].model, group.rows[k].indexes)
					}
				}
			}
			return { nodes: nodes, rows: rows }
		}, [queryText, active, currentGroup, otherGroups, otherHitCount, showOthers])

		var rowsState = listModel.rows




		var totalModelCount = React.useMemo(function () {
			var total = 0
			for (var index = 0; index < allProviders.length; index++) total += allProviders[index].models.length
			return total
		}, [allProviders])

		React.useEffect(function () { setHlIndex(0) }, [active === null ? null : active.id, query])
		// 换渠道/换搜索词后，上一行的“确认删除？”作废
		React.useEffect(function () {
			if (removeTimerRef.current !== null) { window.clearTimeout(removeTimerRef.current); removeTimerRef.current = null }
			setRemoveModelKey(null)
		}, [active === null ? null : active.id, query])

		var hl = rowsState.length === 0 ? 0 : Math.min(hlIndex, rowsState.length - 1)

		// A1 第二道保险：只在**高亮目标真的变化**时滚动（键盘导航）。
		// hover 引发的重渲染即便带来新的 rowsState 身份，也不会再动滚动位置。
		var lastScrolledRef = React.useRef(null)
		React.useEffect(function () {
			if (active === null || rowsState.length === 0) return
			var row = rowsState[hl]
			if (!row) return
			var key = modelKeyOf(row.provider.id, row.model.id)
			if (lastScrolledRef.current === key) return
			lastScrolledRef.current = key
			var element = rowRefs.current[key]
			if (element && typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest' })
		}, [hl, rowsState, active])

		/* ---- 悬浮卡定时与定位 ---- */

		var clearCardTimers = function () {
			if (openTimer.current !== null) { window.clearTimeout(openTimer.current); openTimer.current = null }
			if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null }
		}

		// 用户实测反馈：跟随指针会让鼠标永远够不到卡片 ⇒ **只在 mouseenter 那一刻定位一次，然后钉住**。
		// 这里只记录坐标，不做任何重定位；同一行内移动指针不再改变卡片位置。
		var rememberPointer = function (event) {
			if (event && typeof event.clientX === 'number') pointer.current = { x: event.clientX, y: event.clientY }
		}

		var scheduleOpenCard = function (provider, model) {
			clearCardTimers()
			openTimer.current = window.setTimeout(function () {
				openTimer.current = null
				if (!mountedRef.current) return
				setCardError(null)
				setCard({ key: modelKeyOf(provider.id, model.id), provider: provider, model: model })
			}, 120)
		}

		var scheduleCloseCard = function () {
			clearCardTimers()
			closeTimer.current = window.setTimeout(function () {
				closeTimer.current = null
				if (!mountedRef.current) return
				setCard(null)
			}, 140)
		}

		// 换提供商 / 改搜索词后，旧的悬浮卡上下文已失效。
		React.useEffect(function () {
			clearCardTimers()
			setCard(null)
			setPreparedNote(null)
		}, [active === null ? null : active.id, query])

		// 面板的**布局盒**：popover 模式直接用我们赋给它的几何（getBoundingClientRect 会被入场 transform 污染，
		// 这正是 verifier 测到「卡片 bottom 333 压住面板 7px」的根因）；居中模式退回实测 rect + 布局尺寸。
		var panelBoxOf = function () {
			var node = panelRef.current
			if (node === null) return null
			var width = node.offsetWidth
			var height = node.offsetHeight
			if (panelGeometry !== null) {
				return { left: panelGeometry.left, top: panelGeometry.top, width: width, height: height, right: panelGeometry.left + width, bottom: panelGeometry.top + height }
			}
			var box = node.getBoundingClientRect()
			return { left: box.left, top: box.top, width: width, height: height, right: box.left + width, bottom: box.top + height }
		}

		// 量卡片真实高度（布局尺寸，不受位移动画影响），再纠正落位。
		React.useLayoutEffect(function () {
			if (card === null) {
				if (cardHeight !== 0) setCardHeight(0)
				return undefined
			}
			var node = cardRef.current
			if (node === null) return undefined
			var measured = node.offsetHeight
			if (measured > 0 && measured !== cardHeight) setCardHeight(measured)
			return undefined
		}, [card === null ? null : card.key, cardPos, cardError, preparedNote])

		// §11.3：卡片**跟随鼠标**（指针右侧 16px、垂直与指针对齐）；越界翻左/夹视口。
		// 位置只依赖指针（纯布局量），不依赖行 rect / 面板 rect / 任何动画。
		var cardPosFromPointer = function (width, height) {
			var vw = window.innerWidth
			var vh = window.innerHeight
			var offset = 16
			// A2：**永远在指针右侧**；越界只做视口夹取（不再翻到左侧）。
			var side = 'right'
			var left = pointer.current.x + offset
			if (left + width > vw - 12) left = vw - 12 - width
			if (left < 12) left = 12
			var top = pointer.current.y - 8
			if (top + height > vh - 12) top = vh - 12 - height
			if (top < 12) top = 12
			return { left: Math.round(left), top: Math.round(top), anchored: 'top', side: side }
		}

		React.useLayoutEffect(function () {
			if (card === null) {
				setCardPos(null)
				return undefined
			}
			var node = cardRef.current
			var width = node ? node.offsetWidth : 200
			var height = cardHeight > 0 ? cardHeight : node ? node.offsetHeight : 160
			setCardPos(cardPosFromPointer(width, height))
			return undefined
		}, [card === null ? null : card.key, viewport.w, viewport.h, props.visible, cardHeight])


		// 位置只在「换行 / 视口尺寸变化 / 卡片实测高度变化」时重算（见上面的 layout effect 依赖）；
		// 指针在行内移动不重定位 —— 这是用户实测反馈后的有意行为。
		// （原先这里还有一个 resize/scroll 强制重渲染的 effect，它已无法移动卡片，故删除。）

		/* ---- 选中与写入 ---- */

		var chooseModel = function (providerId, model) {
			if (!model.selectable || busySelect) return
			var selection = { provider: providerId, model: model.id }
			var same = state && state.current && state.current.provider === providerId && state.current.model === model.id
			var fallbackEffort = model.reasoning && model.reasoning.defaultEffort ? model.reasoning.defaultEffort : undefined
			var effort = same ? (state.current.reasoningEffort !== undefined && state.current.reasoningEffort !== null ? state.current.reasoningEffort : fallbackEffort) : fallbackEffort
			if (effort !== undefined) selection.reasoningEffort = effort
			setBusySelect(true)
			setActionError(null)
			var promise
			try {
				promise = props.select(selection)
			} catch (error) {
				promise = Promise.reject(error)
			}
			Promise.resolve(promise).then(function (result) {
				if (!mountedRef.current) return
				setBusySelect(false)
				if (result && result.ok === false) {
					var code = result.error && result.error.code ? result.error.code : ''
					setActionError(code === 'session/writer-held' ? TEXT.sessionBusy : TEXT.selectFailed + code + ': ' + errorMessage(result.error))
					return
				}
				props.onClose()
			}, function (error) {
				if (!mountedRef.current) return
				setBusySelect(false)
				setActionError(TEXT.selectFailed + errorMessage(error))
			})
		}

		var changeEffort = function (model, effortId) {
			if (busyField !== null) return
			setBusyField('effort')
			setCardError(null)
			var promise
			try {
				promise = props.select({ provider: card.provider.id, model: model.id, reasoningEffort: effortId })
			} catch (error) {
				promise = Promise.reject(error)
			}
			Promise.resolve(promise).then(function (result) {
				if (!mountedRef.current) return
				setBusyField(null)
				if (result && result.ok === false) {
					var code = result.error && result.error.code ? result.error.code : ''
					setCardError(code === 'session/writer-held' ? TEXT.sessionBusy : TEXT.selectFailed + code + ': ' + errorMessage(result.error))
				}
			}, function (error) {
				if (!mountedRef.current) return
				setBusyField(null)
				setCardError(TEXT.selectFailed + errorMessage(error))
			}).catch(function (error) {
				if (!mountedRef.current) return
				setBusyField(null)
				setCardError(TEXT.selectFailed + errorMessage(error))
			})
		}

		// task-7：模型**未声明**推理等级时，点档位 = 先写设置页默认声明，**成功后再** select；
		// 旧宿主写不了（UNSUPPORTED_FIELD）⇒ 只提示需重启，**不 select**（否则请求会因未声明档位而失败）。
		var declareEffortThenSelect = function (model, level) {
			if (busyField !== null) return
			setBusyField('effort')
			setCardError(null)
			setCardNote(null)
			props.onWrite(card.provider.id, card.model.id, { reasoningEfforts: DEFAULT_EFFORT_DECLARATION }).then(function () {
				if (!mountedRef.current) return
				return props.select({ provider: card.provider.id, model: model.id, reasoningEffort: level })
			}).then(function (result) {
				if (!mountedRef.current) return
				setBusyField(null)
				if (result && result.ok === false) {
					var code = result.error && result.error.code ? result.error.code : ''
					setCardError(code === 'session/writer-held' ? TEXT.sessionBusy : TEXT.selectFailed + code + ': ' + errorMessage(result.error))
				}
			}, function (error) {
				if (!mountedRef.current) return
				setBusyField(null)
				if (isUnsupportedField(error)) { setCardNote(TEXT.effortDeclareLegacy); return }
				setCardError((error && error.code ? error.code + '：' : '') + errorMessage(error))
			}).catch(function (error) {
				if (!mountedRef.current) return
				setBusyField(null)
				setCardError((error && error.code ? error.code + '：' : '') + errorMessage(error))
			})
		}

		// 旧宿主兼容：旧版本的 pickPatch 白名单里没有 inputModalities，会回 UNSUPPORTED_FIELD。
		// 这时自动用 legacy 的 vision 重试一次；但「只保留图片」legacy 表达不了，明确提示需重启 DSH。
		var isUnsupportedField = function (error) {
			if (error === null || error === undefined) return false
			if (error.code === 'UNSUPPORTED_FIELD') return true
			var message = typeof error.message === 'string' ? error.message : ''
			return /unsupported|不支持字段/i.test(message) && /inputModalities/i.test(message)
		}
		var writeInputModalities = function (next) {
			var hasImage = next.indexOf('image') >= 0
			var onlyImage = next.length === 1 && next[0] === 'image'
			setBusyField('input')
			setCardError(null)
			props.onWrite(card.provider.id, card.model.id, { inputModalities: next }).then(function () {
				if (!mountedRef.current) return
				setBusyField(null)
				if (legacyInput) setLegacyInput(false)
			}, function (error) {
				if (!mountedRef.current) return
				if (!isUnsupportedField(error)) {
					setBusyField(null)
					setCardError((error && error.code ? error.code + '：' : '') + errorMessage(error))
					return
				}
				if (!legacyWarned.current) {
					legacyWarned.current = true
					console.warn('[dsh-model-hub] 当前宿主不认识 inputModalities，输入类型已自动降级为 legacy 的 vision 接口；重启 DSH 后恢复完整语义。')
				}
				if (onlyImage) {
					// legacy 的 vision 只能表达“含/不含图片”，无法表达“只要图片” ⇒ 不静默降级。
					setBusyField(null)
					setLegacyInput(true)
					setCardNote(TEXT.legacyOnlyImage)
					return
				}
				props.onWrite(card.provider.id, card.model.id, { vision: hasImage }).then(function () {
					if (!mountedRef.current) return
					setBusyField(null)
					setLegacyInput(true)
					setCardNote(null)
				}, function (retryError) {
					if (!mountedRef.current) return
					setBusyField(null)
					setCardError((retryError && retryError.code ? retryError.code + '：' : '') + errorMessage(retryError))
				})
			})
		}

		// task-9 B：添加提供商（先存插件自己的 pending 草稿，不直接进 DSH 配置）
		var saveProvider = function () {
			if (providerBusy) return
			var id = providerDraft.id.trim()
			var baseURL = providerDraft.baseURL.trim()
			if (id === '') { setProviderError(TEXT.errProviderId); return }
			if (baseURL === '' || !/^https?:\/\//i.test(baseURL)) { setProviderError(TEXT.errBaseURL); return }
			setProviderBusy(true)
			setProviderError(null)
			fetchJson(API_PROVIDER, {
				method: 'POST',
				body: { id: id, displayName: providerDraft.displayName.trim(), api: providerDraft.api, baseURL: baseURL, apiKeyEnv: providerDraft.apiKeyEnv.trim() }
			}).then(function (data) {
				if (!isRecord(data) || data.ok !== true) throw new Error(isRecord(data) && typeof data.message === 'string' ? data.message : '宿主拒绝了该提供商')
				setProviderBusy(false)
				setPanelMode('list')
				setProviderDraft({ id: '', displayName: '', api: PROVIDER_APIS[0].id, baseURL: '', apiKeyEnv: '' })
				if (props.onRefreshCatalog) props.onRefreshCatalog()
			}, function (error) {
				setProviderBusy(false)
				setProviderError((error && error.code ? error.code + '：' : '') + errorMessage(error))
			}).catch(function (error) {
				if (!mountedRef.current) return
				setProviderBusy(false)
				setProviderError((error && error.code ? error.code + '：' : '') + errorMessage(error))
			})
		}

		// 删除 pending 草稿（只对 pending 生效，真实 provider 会被宿主拒绝）
		var removePendingProvider = function (providerId) {
			fetchJson(API_PROVIDER, { method: 'POST', body: { id: providerId, remove: true } }).then(function () {
				if (props.onRefreshCatalog) props.onRefreshCatalog()
			}, function (error) {
				setActionError((error && error.code ? error.code + '：' : '') + errorMessage(error))
			}).catch(function (error) {
				if (!mountedRef.current) return
				setActionError((error && error.code ? error.code + '：' : '') + errorMessage(error))
			})
		}

		// 获取模型：候选默认**全部勾选**（用户点名要“取消全选”，说明默认是全选）
		var startDiscover = function (providerId) {
			var provider = null
			for (var i = 0; i < providers.length; i++) if (providers[i].id === providerId) provider = providers[i]
			// Bug 2（真机复现）：必须带 baseURL —— 没有出厂目录的渠道只能从 endpoint 发现模型。
			var body = { provider: providerId }
			if (provider && typeof provider.baseURL === 'string' && provider.baseURL !== '') body.baseURL = provider.baseURL
			if (provider && provider.api) body.api = provider.api
			if (provider && provider.apiKeyEnv) body.apiKeyEnv = provider.apiKeyEnv
			setPanelMode('discover')
			setDiscover({ provider: providerId, loading: true, error: null, models: [], query: '' })
			fetchJson(API_DISCOVER, { method: 'POST', body: body }).then(function (data) {
				if (!isRecord(data) || data.ok !== true) throw new Error(isRecord(data) && typeof data.message === 'string' ? data.message : '获取模型失败')
				var list = Array.isArray(data.models) ? data.models : []
				var models = []
				for (var j = 0; j < list.length; j++) {
					var item = list[j]
					var id = typeof item === 'string' ? item : isRecord(item) && typeof item.id === 'string' ? item.id : null
					if (id === null) continue
					var name = isRecord(item) && typeof item.name === 'string' && item.name !== '' ? item.name : id
					// 契约 v1.3：候选可带 contextWindow/maxTokens/inputModalities，写回时按对象传。
					models.push({
						id: id,
						name: name,
						contextWindow: isRecord(item) ? item.contextWindow : undefined,
						maxTokens: isRecord(item) ? item.maxTokens : undefined,
						inputModalities: isRecord(item) && Array.isArray(item.inputModalities) ? item.inputModalities : undefined,
						selected: true
					})
				}
				setDiscover({ provider: providerId, loading: false, error: null, models: models, query: '' })
			}, function (error) {
				setDiscover({ provider: providerId, loading: false, error: (error && error.code ? error.code + '：' : '') + errorMessage(error), models: [], query: '' })
			}).catch(function (error) {
				// 宿主业务失败是 HTTP 200 + {ok:false}，上面的 onOk 会 throw ⇒ 必须在这里兜住，
				// 否则 loading 永远停在 true（真机「一直加载」的根因）。
				if (!mountedRef.current) return
				setDiscover({ provider: providerId, loading: false, error: (error && error.code ? error.code + '：' : '') + errorMessage(error), models: [], query: '' })
			})
		}

		var patchDiscover = function (patch) {
			setDiscover(function (prev) { return prev === null ? prev : Object.assign({}, prev, patch) })
		}
		var setDiscoverSelected = function (ids) {
			setDiscover(function (prev) {
				if (prev === null) return prev
				return Object.assign({}, prev, { models: prev.models.map(function (model) { return { id: model.id, name: model.name, selected: ids === null ? false : ids.indexOf(model.id) >= 0 } }) })
			})
		}
		var confirmDiscover = function () {
			if (discover === null) return
			var picked = discover.models.filter(function (model) { return model.selected })
			if (picked.length === 0) { patchDiscover({ error: TEXT.discoverNeedOne }); return }
			patchDiscover({ error: null })
			// 契约 v1.3：models 是对象数组（含 name/contextWindow/maxTokens/input）。
			var payload = picked.map(function (model) {
				var row = { id: model.id }
				if (typeof model.name === 'string' && model.name !== '') row.name = model.name
				if (typeof model.contextWindow === 'number' && model.contextWindow > 0) row.contextWindow = model.contextWindow
				if (typeof model.maxTokens === 'number' && model.maxTokens > 0) row.maxTokens = model.maxTokens
				if (Array.isArray(model.inputModalities)) row.input = model.inputModalities
				return row
			})
			fetchJson(API_PROVIDER_MODELS, { method: 'POST', body: { provider: discover.provider, models: payload } }).then(function (data) {
				if (!isRecord(data) || data.ok !== true) throw new Error(isRecord(data) && typeof data.message === 'string' ? data.message : '写入模型失败')
				setPanelMode('list')
				setDiscover(null)
				if (props.onRefreshCatalog) props.onRefreshCatalog()
			}, function (error) {
				patchDiscover({ error: (error && error.code ? error.code + '：' : '') + errorMessage(error) })
			}).catch(function (error) {
				if (!mountedRef.current) return
				patchDiscover({ error: (error && error.code ? error.code + '：' : '') + errorMessage(error) })
			})
		}

		// v1.4：删除单个声明模型（非乐观：成功才刷新 catalog，失败原样保留 + 提示）
		// 该渠道当前有几个“可删（declared）”模型
		var declaredCountOf = function (provider) {
			var list = provider && Array.isArray(provider.models) ? provider.models : []
			var count = 0
			for (var i = 0; i < list.length; i++) if (list[i].declared === true) count += 1
			return count
		}
		var removeModelErrorText = function (error) {
			var code = error && error.code ? error.code : ''
			if (code === 'MODELS_REQUIRED') return TEXT.removeModelLast
			if (code === 'MODEL_NOT_DECLARED') return TEXT.removeModelNotDeclared
			return (code ? code + '：' : '') + errorMessage(error)
		}
		var cancelRemoveConfirm = function () {
			if (removeTimerRef.current !== null) { window.clearTimeout(removeTimerRef.current); removeTimerRef.current = null }
			if (removeModelKey !== null) setRemoveModelKey(null)
		}
		var removeModel = function (provider, model) {
			if (busyField !== null) return
			var key = modelKeyOf(provider.id, model.id)
			if (removeModelKey !== key) {
				// 第一次点：进入确认态（4s 无操作自动取消）
				setRemoveModelKey(key)
				if (removeTimerRef.current !== null) window.clearTimeout(removeTimerRef.current)
				removeTimerRef.current = window.setTimeout(function () {
					removeTimerRef.current = null
					if (mountedRef.current) setRemoveModelKey(null)
				}, 4000)
				return
			}
			// 第二次点：真删
			cancelRemoveConfirm()
			setActionError(null)
			setBusyField('remove')
			fetchJson(API_MODEL_REMOVE, { method: 'POST', body: { provider: provider.id, model: model.id } }).then(function (data) {
				if (!mountedRef.current) return
				if (!isRecord(data) || data.ok !== true) {
					var failure = new Error(isRecord(data) && typeof data.message === 'string' ? data.message : '删除失败')
					failure.code = isRecord(data) && typeof data.code === 'string' ? data.code : 'REMOVE_FAILED'
					throw failure
				}
				setBusyField(null)
				// 不做乐观删除：以宿主 catalog 为准（失败也天然不会误删）
				if (props.onRefreshCatalog) props.onRefreshCatalog()
			}, function (error) {
				if (!mountedRef.current) return
				setBusyField(null)
				setActionError(removeModelErrorText(error))
			}).catch(function (error) {
				if (!mountedRef.current) return
				setBusyField(null)
				setActionError(removeModelErrorText(error))
			})
		}

		var writeField = function (field, patch) {
			if (busyField !== null) return
			if (field === 'input' && patch && Array.isArray(patch.inputModalities)) {
				writeInputModalities(patch.inputModalities)
				return
			}
			setBusyField(field)
			setCardError(null)
			props.onWrite(card.provider.id, card.model.id, patch).then(function (result) {
				if (!mountedRef.current) return
				setBusyField(null)
				// 宿主新增的 prepared 是请求级物化参数，能给用户最短的“真生效”证据。
				// 注意：prepared 缺失不代表写入失败（写入结论只看 ok/verify），所以只提示、不报错。
				var prepared = result && result.prepared && result.prepared.config ? result.prepared.config : null
				if (prepared !== null && typeof prepared.maxTokens === 'number') {
					setPreparedNote('下一次请求将使用 maxTokens ' + prepared.maxTokens)
				} else setPreparedNote(null)
				if (result && result.code === 'NOT_EFFECTIVE') setCardError('NOT_EFFECTIVE：配置已写入但运行时未生效，已回滚显示。' + (result.message ? ' ' + result.message : ''))
			}, function (error) {
				if (!mountedRef.current) return
				setBusyField(null)
				var code = error && error.code ? error.code : ''
				setCardError((code ? code + '：' : '') + errorMessage(error))
			})
		}

		/* ---- 键盘 ---- */

		var focusablesIn = function (root) {
			if (!root) return []
			var nodes = root.querySelectorAll('button:not([disabled]),input:not([disabled]),[tabindex="0"]')
			var out = []
			for (var index = 0; index < nodes.length; index++) {
				var node = nodes[index]
				if (node.getAttribute('aria-hidden') === 'true') continue
				if (node.offsetParent === null && node !== document.activeElement) continue
				out.push(node)
			}
			return out
		}

		var trapTab = function (event) {
			var list = focusablesIn(panelRef.current).concat(focusablesIn(cardRef.current))
			if (list.length === 0) return
			var current = document.activeElement
			var at = list.indexOf(current)
			event.preventDefault()
			var next
			if (event.shiftKey) next = at <= 0 ? list[list.length - 1] : list[at - 1]
			else next = at < 0 || at === list.length - 1 ? list[0] : list[at + 1]
			if (next && typeof next.focus === 'function') next.focus()
		}

		var moveProvider = function (delta) {
			if (providers.length === 0 || active === null) return
			var at = -1
			for (var index = 0; index < providers.length; index++) if (providers[index].id === active.id) at = index
			if (at < 0) return
			var next = at + delta
			if (next < 0) next = providers.length - 1
			if (next >= providers.length) next = 0
			setPickedId(providers[next].id)
			setQuery('')
		}

		/* ---- task-9 B：两个全屏页（添加提供商 / 获取模型勾选） ---- */

		var formRow = function (key, label, control) {
			return h('div', { key: key, className: 'mh-formRow' }, [
				h('span', { key: 'l', className: 'mh-formLabel' }, label),
				control
			])
		}

		/** 输入 id 命中宿主模板时补默认值（只补空字段，不覆盖用户输入）。 */
		var applyTemplateDefaults = function (draft) {
			for (var i = 0; i < providerTemplates.length; i++) {
				var tpl = providerTemplates[i]
				if (tpl.provider !== draft.id) continue
				var next = Object.assign({}, draft)
				var touched = false
				if (next.displayName === '' && typeof tpl.displayName === 'string' && tpl.displayName !== '') { next.displayName = tpl.displayName; touched = true }
				if (next.baseURL === '' && typeof tpl.defaultBaseURL === 'string' && tpl.defaultBaseURL !== '') { next.baseURL = tpl.defaultBaseURL; touched = true }
				if (touched) setProviderDraft(next)
				return
			}
		}

		var setDraftField = function (field) {
			return function (event) {
				var next = Object.assign({}, providerDraft)
				next[field] = event.target.value
				setProviderDraft(next)
				setProviderError(null)
				if (field === 'id') applyTemplateDefaults(next)
			}
		}

		var renderProviderForm = function () {
			return h('div', { className: 'mh-page', 'data-model-hub': 'provider-form' }, [
				h('div', { key: 'head', className: 'mh-pageHead' }, [
					h('span', { key: 't', className: 'mh-pageTitle' }, TEXT.formTitle),
					h('button', {
						key: 'x',
						type: 'button',
						className: 'mh-pageClose',
						'aria-label': TEXT.cancel,
						title: TEXT.cancel,
						disabled: providerBusy,
						onClick: function () { if (!providerBusy) setPanelMode('list') }
					}, h(IconClose, { size: 12 }))
				]),
				h('div', { key: 'body', className: 'mh-pageBody' }, [
					formRow('id', TEXT.fieldId, h('input', {
						key: 'i',
						className: 'mh-input',
						type: 'text',
						value: providerDraft.id,
						disabled: providerBusy,
						placeholder: 'my-provider',
						'data-model-hub': 'provider-id',
						onChange: setDraftField('id')
					})),
					formRow('displayName', TEXT.fieldDisplayName, h('input', {
						key: 'd',
						className: 'mh-input',
						type: 'text',
						value: providerDraft.displayName,
						disabled: providerBusy,
						onChange: setDraftField('displayName')
					})),
					formRow('api', TEXT.fieldApi, h('select', {
						key: 'a',
						className: 'mh-input',
						value: providerDraft.api,
						disabled: providerBusy,
						'data-model-hub': 'provider-api',
						onChange: setDraftField('api')
					}, providerProtocols.map(function (protocol) {
						return h('option', { key: protocol.id, value: protocol.id }, protocol.label)
					}))),
					formRow('baseURL', TEXT.fieldBaseURL, h('input', {
						key: 'b',
						className: 'mh-input',
						type: 'text',
						value: providerDraft.baseURL,
						disabled: providerBusy,
						placeholder: 'https://api.example.com/v1',
						'data-model-hub': 'provider-baseurl',
						onChange: setDraftField('baseURL')
					})),
					formRow('apiKeyEnv', TEXT.fieldApiKeyEnv, h('input', {
						key: 'k',
						className: 'mh-input',
						type: 'text',
						value: providerDraft.apiKeyEnv,
						disabled: providerBusy,
						placeholder: 'MY_PROVIDER_API_KEY',
						onChange: setDraftField('apiKeyEnv')
					})),
					h('div', { key: 'hint', className: 'mh-formHint' }, TEXT.addProviderHint),
					providerError ? h('div', { key: 'err', className: 'mh-pageError', role: 'alert' }, providerError) : null
				]),
				h('div', { key: 'foot', className: 'mh-pageFoot' }, [
					h('button', { key: 'c', type: 'button', className: 'mh-btn', disabled: providerBusy, onClick: function () { if (!providerBusy) setPanelMode('list') } }, TEXT.cancel),
					h('button', { key: 's', type: 'button', className: 'mh-btn mh-btnPrimary', disabled: providerBusy, onClick: saveProvider }, providerBusy ? TEXT.saving : TEXT.save)
				])
			])
		}

		var renderDiscoverPage = function () {
			if (discover === null) return null
			var needle = discover.query.trim().toLowerCase()
			var shown = discover.models.filter(function (model) {
				if (needle === '') return true
				return model.id.toLowerCase().indexOf(needle) >= 0 || model.name.toLowerCase().indexOf(needle) >= 0
			})
			var selectedCount = discover.models.filter(function (model) { return model.selected }).length
			var allIds = discover.models.map(function (model) { return model.id })
			return h('div', { className: 'mh-page', 'data-model-hub': 'discover' }, [
				h('div', { key: 'head', className: 'mh-pageHead' }, [
					h('span', { key: 't', className: 'mh-pageTitle' }, TEXT.discoverTitle + ' · ' + discover.provider),
					h('button', {
						key: 'x',
						type: 'button',
						className: 'mh-pageClose',
						'aria-label': TEXT.cancel,
						title: TEXT.cancel,
						onClick: function () { setPanelMode('list'); setDiscover(null) }
					}, h(IconClose, { size: 12 }))
				]),
				h('div', { key: 'body', className: 'mh-pageBody' }, [
					h('div', { key: 'q', className: 'mh-search' }, [
						h(IconSearch, { key: 'i', size: 14, className: 'mh-searchIcon' }),
						h('input', {
							key: 'in',
							className: 'mh-searchInput',
							type: 'text',
							value: discover.query,
							placeholder: TEXT.searchPlaceholder,
							'data-model-hub': 'discover-search',
							onChange: function (event) { patchDiscover({ query: event.target.value }) }
						})
					]),
					h('div', { key: 'tb', className: 'mh-toolbar' }, [
						h('button', { key: 'all', type: 'button', className: 'mh-btn', 'data-model-hub': 'select-all', onClick: function () { setDiscoverSelected(allIds) } }, TEXT.selectAll),
						h('button', { key: 'none', type: 'button', className: 'mh-btn', 'data-model-hub': 'clear-all', onClick: function () { setDiscoverSelected(null) } }, TEXT.clearAll),
						h('span', { key: 'c', className: 'mh-toolbarCount', 'data-model-hub': 'discover-count' }, TEXT.discoverSelected + selectedCount + ' / ' + discover.models.length)
					]),
					h('div', { key: 'hint', className: 'mh-formHint', style: { paddingLeft: '0' } }, TEXT.discoverHint),
					discover.error ? h('div', { key: 'err', className: 'mh-pageError', role: 'alert' }, discover.error) : null,
					discover.loading
						? h('div', { key: 'load', className: 'mh-empty' }, [h(Spinner, { key: 's' }), h('span', { key: 't' }, TEXT.discoverLoading)])
						: shown.length === 0
							? h('div', { key: 'none', className: 'mh-empty' }, TEXT.discoverEmpty)
							: h('div', { key: 'list', className: 'mh-discoverList', 'data-model-hub': 'discover-list' }, shown.map(function (model) {
								return h('label', { key: model.id, className: 'mh-discoverRow', 'data-model-hub': 'discover-row' }, [
									h(Check, {
										key: 'c',
										label: '',
										title: model.id,
										checked: model.selected,
										onChange: function () {
											setDiscover(function (prev) {
												if (prev === null) return prev
												return Object.assign({}, prev, {
													models: prev.models.map(function (item) { return item.id === model.id ? { id: item.id, name: item.name, contextWindow: item.contextWindow, maxTokens: item.maxTokens, inputModalities: item.inputModalities, selected: !item.selected } : item })
												})
											})
										}
									}),
									h('span', { key: 'id', className: 'mh-discoverId' }, model.id),
									model.name !== model.id ? h('span', { key: 'n', className: 'mh-discoverName' }, model.name) : null
								])
							}))
				]),
				h('div', { key: 'foot', className: 'mh-pageFoot' }, [
					h('button', { key: 'c', type: 'button', className: 'mh-btn', 'data-model-hub': 'discover-cancel', onClick: function () { setPanelMode('list'); setDiscover(null) } }, TEXT.cancel),
					h('button', { key: 's', type: 'button', className: 'mh-btn mh-btnPrimary', 'data-model-hub': 'discover-confirm', onClick: confirmDiscover }, TEXT.confirm)
				])
			])
		}

		var onKeyDown = function (event) {
			var inCard = cardRef.current !== null && cardRef.current.contains(event.target)
			if (event.key === 'Escape') {
				event.preventDefault()
				event.stopPropagation()
				// task-9 B6：全屏页（添加提供商 / 获取模型）优先被 Esc 关掉。
				if (panelMode !== 'list') {
					if (providerBusy) return
					setPanelMode('list')
					setDiscover(null)
					return
				}
				if (card !== null) {
					clearCardTimers()
					setCard(null)
					return
				}
				props.onClose()
				return
			}
			if (event.key === 'Tab') {
				trapTab(event)
				return
			}
			if (inCard) return
			if (card !== null && cardRef.current !== null && cardRef.current.contains(event.target)) return
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				if (rowsState.length === 0) return
				event.preventDefault()
				var next = hl + (event.key === 'ArrowDown' ? 1 : -1)
				if (next < 0) next = 0
				if (next > rowsState.length - 1) next = rowsState.length - 1
				setHlIndex(next)
				return
			}
			if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
				if (query !== '') return
				event.preventDefault()
				moveProvider(event.key === 'ArrowRight' ? 1 : -1)
				return
			}
			if (event.key === 'Enter') {
				if (busySelect || busyField !== null) return
				var row = rowsState[hl]
				if (!row) return
				event.preventDefault()
				chooseModel(row.provider.id, row.model)
			}
		}

		/* ---- 提供商拖拽排序 / 置顶 ---- */

		var onDragStart = function (event, provider) {
			setDraggingId(provider.id)
			try {
				event.dataTransfer.effectAllowed = 'move'
				event.dataTransfer.setData('text/plain', provider.id)
			} catch (ignored) {}
		}

		var onDragOver = function (event, provider) {
			if (draggingId === null || draggingId === provider.id) return
			event.preventDefault()
			try { event.dataTransfer.dropEffect = 'move' } catch (ignored) {}
			var rect = event.currentTarget.getBoundingClientRect()
			var above = event.clientY < rect.top + rect.height / 2
			if (dropTarget === null || dropTarget.id !== provider.id || dropTarget.above !== above) {
				setDropTarget({ id: provider.id, above: above })
			}
		}

		var onDrop = function (event, provider) {
			event.preventDefault()
			var source = draggingId
			var target = dropTarget
			setDraggingId(null)
			setDropTarget(null)
			if (source === null || source === provider.id) return
			var ids = providers.map(function (entry) { return entry.id })
			var from = ids.indexOf(source)
			if (from < 0) return
			ids.splice(from, 1)
			var at = ids.indexOf(provider.id)
			if (at < 0) return
			var insertAt = at + (target !== null && target.above === false ? 1 : 0)
			ids.splice(insertAt, 0, source)
			props.onReorder(ids)
		}

		var onDragEnd = function () {
			setDraggingId(null)
			setDropTarget(null)
		}

		/* ---- 渲染 ---- */

		var currentKey = state && state.current ? modelKeyOf(state.current.provider, state.current.model) : null
		var loading = state === null || state.status === 'idle' || state.status === 'loading'
		var mainBody

		// 一行模型（常规列表与全局搜索结果共用；provider 来自 row，不是左栏选中态）。
		var renderModelRow = function (row, index) {
			var key = modelKeyOf(row.provider.id, row.model.id)
			return h(ModelRowView, {
				key: key,
				row: row,
				flatIndex: index,
				highlighted: index === hl,
				selected: currentKey === key,
				busySelect: busySelect,
				searching: queryText !== '',
				registerRef: function (element) { rowRefs.current[key] = element },
				onEnter: function (event) { rememberPointer(event); if (row.model.selectable === true) scheduleOpenCard(row.provider, row.model) },
				onLeave: scheduleCloseCard,
				onChoose: function () { chooseModel(row.provider.id, row.model) },
				// v1.4：只有显式声明在 profile 里的行（declared === true）才给删除入口；
				// pending 渠道没有模型行，天然不会有入口。
				canRemove: row.model.declared === true,
				// 宿主 v1.4：自建路由至少要留一个模型 ⇒ 最后一个可删模型把入口置灰（别等点了才报错）
				removeDisabled: row.model.declared === true && declaredCountOf(row.provider) <= 1,
				removeConfirming: removeModelKey === key,
				onRemoveClick: function () { removeModel(row.provider, row.model) }
			})
		}

		if (loading) {
			// case 2：会话目录还没就绪 → 骨架屏优先，避免把 catalog 里的只读行显示成“看着能选”。
			mainBody = h(SkeletonRows, {})
		} else if (rowsState.length > 0) {
			var listChildren = listModel.nodes.map(function (node) {
				if (node.kind === 'row') return renderModelRow(rowsState[node.index], node.index)
				if (node.kind === 'head') {
					return h('div', {
						key: 'group:' + node.key,
						className: 'mh-groupHead',
						'data-model-hub': 'group-head',
						'data-current': node.current === true ? 'true' : 'false'
					}, [
						h('span', { key: 'n', className: 'mh-groupName' }, node.provider.name),
						node.current === true ? h('span', { key: 'm', className: 'mh-groupFlag' }, TEXT.currentFlag) : null,
						h('span', { key: 'c', className: 'mh-groupCount' }, String(node.count))
					])
				}
				// 列表最底部的「展开其他渠道的相似模型（N）」
				return h('button', {
					key: 'toggle-others',
					type: 'button',
					className: 'mh-moreModels',
					'data-model-hub': 'expand-others',
					'aria-expanded': node.expanded ? 'true' : 'false',
					title: TEXT.allProvidersHint,
					onClick: function () { setShowOthers(!showOthers) }
				}, (node.expanded ? TEXT.collapseOthers : TEXT.expandOthers) + '(' + node.count + ')')
			})
			mainBody = h('div', { className: 'mh-list', ref: listRef, role: 'listbox', id: 'mh-model-list', 'aria-label': TEXT.dialogLabel },
				listChildren)
		} else if (activeFailure !== null && queryText === '') {
			// case 3：该提供商目录加载失败 → 显示失败分组细节，而不是空白（design-spec §5）。
			mainBody = h('div', { className: 'mh-empty' }, [
				h(IconWarn, { key: 'i', size: 22 }),
				h('span', { key: 't' }, activeFailure.name + ' 加载失败'),
				h('span', { key: 'm', className: 'mh-fieldNote' }, String(activeFailure.message || ''))
			])
		} else {
			var noKey = active !== null && active.hasKey === false
			mainBody = h('div', { className: 'mh-empty' }, [
				h(noKey ? IconWarn : IconModel, { key: 'i', size: 22 }),
				h('span', { key: 't' }, query.trim() !== '' ? TEXT.noResults : noKey ? TEXT.noKey : TEXT.noModels),
				noKey ? h('span', { key: 'h', className: 'mh-fieldNote' }, '该提供商没有可用凭证，先在设置里配置后再回来。') : null
			])
		}

		var renderProviderRow = function (provider) {
			var isActive = active !== null && active.id === provider.id
			var pinned = props.pinnedIds.indexOf(provider.id) >= 0
			var drop = dropTarget !== null && dropTarget.id === provider.id ? (dropTarget.above ? 'above' : 'below') : null
			return h('button', {
				key: provider.id,
				type: 'button',
				className: 'mh-prov',
				draggable: true,
				'data-model-hub': 'provider',
				'data-active': isActive ? 'true' : 'false',
				'data-pinned': pinned ? 'true' : 'false',
				'data-empty': provider.models.length === 0 ? 'true' : 'false',
				'data-pending': provider.pending === true ? 'true' : 'false',
				'data-dragging': draggingId === provider.id ? 'true' : 'false',
				'data-drop': drop === null ? undefined : drop,
				'aria-pressed': isActive ? 'true' : 'false',
				title: provider.name + ' · ' + provider.models.length + (provider.hasKey ? '' : ' · ' + TEXT.noKey),
				onClick: function () { setPickedId(provider.id); setQuery('') },
				onContextMenu: function (event) { event.preventDefault(); props.onTogglePin(provider.id) },
				onDragStart: function (event) { onDragStart(event, provider) },
				onDragOver: function (event) { onDragOver(event, provider) },
				onDrop: function (event) { onDrop(event, provider) },
				onDragEnd: onDragEnd,
				onMouseEnter: function () { if (card !== null) setCard(null) }
			}, [
				h('span', { key: 'bar', className: 'mh-provBar' }),
				h('span', { key: 'n', className: 'mh-provName' }, provider.name),
				provider.pending === true ? h('span', { key: 'pend', className: 'mh-provPending', title: TEXT.pendingProvider }, TEXT.pendingProvider) : null,
				h('span', { key: 'c', className: 'mh-provCount' },
					provider.models.length === 0 && failureOf(provider.id) !== null
						? h(IconWarn, { size: 12 })
						: String(provider.models.length)),
				provider.pending === true ? h('button', {
					key: 'del',
					type: 'button',
					className: 'mh-provDel',
					'data-model-hub': 'provider-remove',
					'aria-label': TEXT.removePending,
					title: TEXT.removePending,
					onClick: function (event) { event.stopPropagation(); removePendingProvider(provider.id) }
				}, h(IconClose, { size: 10 })) : null,
				h('span', {
					key: 'p',
					className: 'mh-provPin',
					role: 'button',
					tabIndex: -1,
					'aria-label': pinned ? TEXT.unpinned : TEXT.pinned,
					title: pinned ? TEXT.unpinned : TEXT.pinned,
					onClick: function (event) { event.stopPropagation(); props.onTogglePin(provider.id) }
				}, h(IconPin, { size: 12 }))
			])
		}
		var sideList = withModels.map(renderProviderRow)

		var cardNode = null
		if (card !== null && cardPos !== null) {
			// 从**当前**的 providers 视图里重新解析（乐观更新后必须立刻反映到卡片上，
			// 不能沿用打开卡片那一刻捕获的旧对象）。
			var allProviders = providers.concat(withoutModels)
			var cardModel = null
			var cardProvider = null
			for (var index = 0; index < allProviders.length; index++) {
				if (allProviders[index].id !== card.provider.id) continue
				cardProvider = allProviders[index]
				for (var modelIndex = 0; modelIndex < allProviders[index].models.length; modelIndex++) {
					if (allProviders[index].models[modelIndex].id === card.model.id) cardModel = allProviders[index].models[modelIndex]
				}
			}
			var liveModel = cardModel || card.model
			var liveProvider = cardProvider || card.provider
			var isCurrentModel = currentKey === card.key
			cardNode = h(HubBoundary, { fallback: null }, h(HoverCard, { key: card.key,
				cardRef: cardRef,
				left: cardPos.left,
				top: cardPos.top,
				bottom: cardPos.bottom,
				anchored: cardPos.anchored,
				side: cardPos.side,
				provider: liveProvider,
				model: liveModel,
				writable: catalogReady === true && liveModel.selectable === true,
				isCurrent: isCurrentModel,
				currentEffort: isCurrentModel && state && state.current ? state.current.reasoningEffort : undefined,
				busyField: busyField,
				preparedNote: preparedNote,
				note: cardNote,
				error: cardError,
				onWrite: writeField,
				onEffort: function (effortId) { changeEffort(liveModel, effortId) },
				onEffortDeclare: function (level) { declareEffortThenSelect(liveModel, level) },
				onMouseEnter: function () { clearCardTimers() },
				onMouseLeave: function () { scheduleCloseCard() }
			}))
		}

		var strips = []
		if (activeFailure !== null && rowsState.length > 0 && queryText === '') {
			strips.push(h(Strip, { key: 'grp', tone: 'error', text: activeFailure.name + ' 加载失败：' + String(activeFailure.message || '') + '（下面这些行当前不可选）' }))
		}
		if (props.directoryError) {
			strips.push(h(Strip, { key: 'direrr', tone: 'error', text: '会话模型目录不可用：' + String(props.directoryError) + '（内置选择器仍可用，本插件的模型位暂不可操作）' }))
		}
		if (props.catalogError) {
			strips.push(h(Strip, { key: 'cat', tone: 'warn', text: TEXT.catalogDown, onRetry: props.onRefreshCatalog }))
		}
		if (props.prefsError) {
			strips.push(h(Strip, { key: 'pref', tone: 'warn', text: TEXT.orderSaveFailed + props.prefsError }))
		}
		if (state && state.error && !loading) {
			strips.push(h(Strip, { key: 'dir', tone: 'error', text: String(state.error) }))
		}
		if (actionError) {
			strips.push(h(Strip, { key: 'act', tone: 'error', text: actionError }))
		}

		// task-9 B：全屏页（铺满左右两栏）
		var pageNode = null
		if (panelMode === 'add') pageNode = renderProviderForm()
		else if (panelMode === 'discover') pageNode = renderDiscoverPage()

		return h('div', {
			className: popover ? 'mh-overlay mh-overlayPopover' : 'mh-overlay',
			'data-model-hub': 'overlay',
			role: 'presentation',
			onMouseDown: function (event) { if (event.target === event.currentTarget) props.onClose() }
		}, [
			h('div', {
				key: 'mask',
				className: popover ? 'mh-mask mh-maskBare' : 'mh-mask',
				'data-open': props.visible ? 'true' : 'false',
				'aria-hidden': 'true',
				onClick: props.onClose
			}),
			h('div', {
				key: 'panel',
				ref: panelRef,
				className: popover ? 'mh-panel mh-panelPopover' : 'mh-panel',
				style: panelGeometry === null ? undefined : {
					left: panelGeometry.left + 'px',
					top: panelGeometry.top + 'px',
					width: panelGeometry.width + 'px',
					height: panelGeometry.height + 'px',
					borderRadius: '16px'
				},
				'data-open': props.visible ? 'true' : 'false',
				'data-model-hub': 'panel',
				role: 'dialog',
				'aria-modal': 'true',
				'aria-label': TEXT.dialogLabel,
				onKeyDown: onKeyDown,
				onMouseDown: function (event) { event.stopPropagation() }
			}, [
				h('div', { key: 'body', className: 'mh-body' }, [
					h('div', { key: 'side', className: 'mh-side', 'data-searching': queryText !== '' ? 'true' : 'false', style: popover ? { width: leftColumnWidth + 'px' } : undefined }, [
						h('div', { key: 'h', className: 'mh-sideHead' }, [
							h('span', { key: 't' }, TEXT.providerColumn),
							h('span', { key: 'hint', className: 'mh-sideHint' }, queryText !== '' ? TEXT.searchScope : TEXT.providerHint)
						]),
						providers.length === 0
							? (loading ? h('div', { key: 'skel' }, [0, 1, 2, 3, 4, 5].map(function (n) {
								return h('div', { key: n, className: 'mh-skelRow' }, [
									h('span', { key: 'n', className: 'mh-skelBar', style: { flex: '1' } })
								])
							})) : h('div', { key: 'empty', className: 'mh-empty' }, TEXT.noModels))
							: h('div', { key: 'list', className: 'mh-sideList', role: 'tablist', 'aria-label': TEXT.providerColumn },
								sideList.concat([h('button', {
									key: '__add',
									type: 'button',
									className: 'mh-sideMore',
									'data-model-hub': 'add-provider',
									title: TEXT.addProviderHint,
									onClick: openProviderForm
								}, TEXT.addProvider)])),
						props.prefsError ? h('div', { key: 'pf', className: 'mh-sideFoot' }, TEXT.orderSaveFailed + props.prefsError) : null
					]),
					h('div', { key: 'main', className: 'mh-main' }, [
						h('div', { key: 'search', className: 'mh-searchRow' }, [
							h('div', { key: 'box', className: 'mh-search' }, [
								h(IconSearch, { key: 'i', size: 14, className: 'mh-searchIcon' }),
								h('input', {
									key: 'in',
									ref: searchRef,
									className: 'mh-searchInput',
									type: 'text',
									value: query,
									placeholder: TEXT.searchPlaceholder,
									'aria-label': TEXT.searchPlaceholder,
									role: 'combobox',
									'aria-expanded': 'true',
									'aria-controls': 'mh-model-list',
									'aria-activedescendant': rowsState.length > 0 ? 'mh-option-' + hl : undefined,
									autoComplete: 'off',
									spellCheck: false,
									onChange: function (event) { setQuery(event.target.value) }
								}),
								query !== '' ? h('button', {
									key: 'clear',
									type: 'button',
									className: 'mh-searchClear',
									'aria-label': TEXT.searchClear,
									title: TEXT.searchClear,
									onClick: function () {
										setQuery('')
										if (searchRef.current) searchRef.current.focus()
									}
								}, h(IconClose, { size: 12 })) : null
							]),
							h('span', { key: 'count', className: 'mh-searchCount' }, queryText !== ''
								? '命中 ' + String(currentHitsCount + otherHitCount) + ' / 共 ' + String(totalModelCount) + ' 个模型'
								: active === null ? '' : '共 ' + String(active.models.length) + ' 个模型')
						]),
						strips.length > 0 ? h('div', { key: 'strips' }, strips) : null,
						h('div', { key: 'wrap', className: 'mh-listWrap' }, mainBody)
					]),
					// B4：模型列表右下角的刷新按钮（获取该提供商的可用模型）
					panelMode === 'list' && active !== null
						? h('button', {
							key: 'refresh',
							type: 'button',
							className: 'mh-refresh',
							'data-model-hub': 'refresh',
							title: TEXT.refreshModels,
							'aria-label': TEXT.refreshModels,
							onClick: function () { startDiscover(active.id) }
						}, h(IconRefresh, { size: 14 }))
						: null
				]),
				// 全屏页（添加提供商 / 获取模型）：position:absolute;inset:0，包含块是 .mh-panel
				pageNode
			]),
			cardNode
		])
	}

	/** 行尾徽标（最多 3 个）：视觉 / 上下文 / 思考档位。 */
	/** 一行模型（常规列表与全局搜索结果共用）。owner props 里带 row/selected/highlighted/回调。 */
	function ModelRowView(props) {
		var row = props.row
		var model = row.model
		var disabled = model.selectable !== true
		var badges = buildBadges(model)
		return h('button', {
			type: 'button',
			className: 'mh-model',
			'data-model-hub': 'row',
			'data-hl': props.highlighted ? 'true' : 'false',
			'data-selected': props.selected ? 'true' : 'false',
			'data-disabled': disabled ? 'true' : 'false',
			'data-remove-confirm': props.removeConfirming ? 'true' : 'false',
			role: 'option',
			'aria-selected': props.selected ? 'true' : 'false',
			'aria-disabled': disabled ? 'true' : 'false',
			id: 'mh-option-' + props.flatIndex,
			tabIndex: -1,
			title: disabled ? model.name + ' · ' + TEXT.noKey : model.name,
			ref: props.registerRef,
			onMouseEnter: props.onEnter,
			onMouseLeave: props.onLeave,
			onFocus: props.onEnter,
			onBlur: props.onLeave,
			onClick: props.onChoose
		}, [
			h('span', { key: 'c', className: 'mh-modelCheck' }, props.selected ? h(IconCheck, { size: 14 }) : null),
			h('span', { key: 'l', className: 'mh-modelLabel' },
				h(ModelName, {
					name: model.name,
					indexes: row.indexes,
					highlight: props.searching,
					flash1017: isFlash1017(row.provider.id, model.id, model.name)
				})),
			props.busySelect && props.selected ? h(Spinner, { key: 'sp' }) : null,
			badges.length > 0 ? h('span', { key: 'b', className: 'mh-badges' }, badges) : null,
			// v1.4：只有确实声明在 profile 里的模型可单独删除；hover 才出现（避免列表变吵）。
			// 二次确认：第一次点变成「确认删除？」，再点才真删。
			props.canRemove === true
				? h('span', {
					key: 'rm',
					className: 'mh-modelRemove',
					role: 'button',
					tabIndex: -1,
					'data-model-hub': 'model-remove',
					'data-confirming': props.removeConfirming ? 'true' : 'false',
					'data-disabled': props.removeDisabled === true ? 'true' : 'false',
					'aria-disabled': props.removeDisabled === true ? 'true' : 'false',
					'aria-label': props.removeDisabled === true ? TEXT.removeModelLastDisabled : props.removeConfirming ? TEXT.removeModelConfirm : TEXT.removeModel,
					title: props.removeDisabled === true ? TEXT.removeModelLastDisabled : props.removeConfirming ? TEXT.removeModelConfirm : TEXT.removeModel,
					onClick: function (event) {
						event.stopPropagation()
						if (props.removeDisabled === true) return
						props.onRemoveClick()
					}
				}, props.removeConfirming ? TEXT.removeModelConfirm : h(IconClose, { size: 10 }))
				: null
		])
	}

	function buildBadges(model) {
		var meta = model.meta
		if (meta === null) return []
		var out = []
		if (meta.vision) out.push(h('span', { key: 'v', className: 'mh-badge' }, [h(IconEye, { key: 'i', size: 11 }), h('span', { key: 't' }, TEXT.vision)]))
		var label = contextLabel(meta.contextWindow)
		if (label !== null) out.push(h('span', { key: 'c', className: 'mh-badge' }, label))
		if (Array.isArray(meta.efforts) && meta.efforts.length > 0) {
			var hit = null
			for (var i = 0; i < meta.efforts.length; i++) if (meta.efforts[i].id === meta.defaultEffort) hit = meta.efforts[i]
			var text = hit ? '思考·' + effortLabelOf(hit) : '思考'
			out.push(h('span', { key: 'e', className: 'mh-badge' }, text))
		}
		if (meta.resolved === false) out.push(h('span', { key: 'w', className: 'mh-badge mh-badgeWarn' }, '未就绪'))
		return out.slice(0, 3)
	}

	/* ══════════════════════════ 槽位入口组件 ══════════════════════════ */

	/** 视口尺寸（响应 resize）；用于浮层/居中两种布局的切换与夹取。 */
function useViewport() {
	var state = React.useState(function () { return { w: window.innerWidth, h: window.innerHeight } })
	var viewport = state[0]
	var setViewport = state[1]
	React.useEffect(function () {
		var onResize = function () { setViewport({ w: window.innerWidth, h: window.innerHeight }) }
		window.addEventListener('resize', onResize)
		return function () { window.removeEventListener('resize', onResize) }
	}, [])
	return viewport
}

/** 浮层锚点：优先整个输入栏卡片（[data-composer-card]），拿不到退回模型位触发器等元素。 */
function composerAnchorOf(triggerRef) {
	var trigger = triggerRef && triggerRef.current ? triggerRef.current : null
	if (trigger === null) return null
	if (typeof trigger.closest === 'function') {
		var composer = trigger.closest('[data-composer-card]')
		if (composer !== null) return composer
	}
	return trigger
}

/** B 方案几何：面板贴模型位上方 —— 底边 = trigger 顶 − gap，右边缘与 trigger 右边缘对齐。
 *  尺寸 min(720,92vw) × min(430,58vh)（min-height 320）；top 不足 12px 时压低高度，绝不顶出屏幕。 */
function popoverRectOf(triggerEl, viewport, gap) {
	var width = Math.round(Math.min(600, viewport.w * 0.9))
	var height = Math.round(Math.min(430, viewport.h * 0.58))
	if (height < 320) height = 320
	var anchor = triggerEl ? triggerEl.getBoundingClientRect() : null
	var bottom = anchor !== null && anchor.top > 0 ? anchor.top - gap : viewport.h - 12
	var right = anchor !== null && anchor.right > 0 ? anchor.right : viewport.w - 24
	if (bottom - height < 12) height = Math.max(240, bottom - 12)
	var top = Math.max(12, bottom - height)
	var left = Math.round(right - width)
	if (left + width > viewport.w - 12) left = viewport.w - 12 - width
	if (left < 12) left = 12
	return { left: left, top: top, width: width, height: height }
}

function useDirectorySnapshot(store) {
		var subscribe = React.useCallback(function (listener) {
			if (store && typeof store.subscribe === 'function') return store.subscribe(listener)
			return function () {}
		}, [store])
		var getSnapshot = React.useCallback(function () {
			if (store && typeof store.getSnapshot === 'function') return store.getSnapshot()
			return EMPTY_STATE
		}, [store])
		return React.useSyncExternalStore(subscribe, getSnapshot)
	}

	var EMPTY_STATE = { current: null, retainedEffort: undefined, routable: null, groups: [], failures: [], status: 'idle', pending: null, error: null }

	function ModelHubSeat(props) {
		var store = props.directory
		var state = useDirectorySnapshot(store)
		var openState = React.useState(false)
		var open = openState[0]
		var setOpen = openState[1]
		var visibleState = React.useState(false)
		var visible = visibleState[0]
		var setVisible = visibleState[1]
		var mountedState = React.useState(false)
		var mounted = mountedState[0]
		var setMounted = mountedState[1]
		var triggerRef = React.useRef(null)
		var closeTimer = React.useRef(null)

		var catalogState = React.useState(null)
		var catalog = catalogState[0]
		var setCatalog = catalogState[1]
		var prefsState = React.useState({ order: [], pinned: [], overrides: {} })
		var prefs = prefsState[0]
		var setPrefs = prefsState[1]
		var catalogErrorState = React.useState(null)
		var catalogError = catalogErrorState[0]
		var setCatalogError = catalogErrorState[1]
		var prefsErrorState = React.useState(null)
		var prefsError = prefsErrorState[0]
		var setPrefsError = prefsErrorState[1]

		var overridesRef = React.useRef({})
		var overridesState = React.useState({})
		var overrides = overridesState[0]
		var setOverrides = overridesState[1]
		var prefsRef = React.useRef(prefs)

		React.useEffect(function () { prefsRef.current = prefs }, [prefs])

		var mutateOverrides = React.useCallback(function (mutate) {
			var next = Object.assign({}, overridesRef.current)
			mutate(next)
			overridesRef.current = next
			setOverrides(next)
		}, [])

		var refreshCatalog = React.useCallback(function () {
			return fetchJson(API_CATALOG).then(function (data) {
				if (!isRecord(data) || data.ok !== true) throw new Error('catalog 响应异常')
				var normalized = normalizeCatalog(data)
				setCatalog(normalized)
				setCatalogError(null)
				setPrefs(function (prev) {
					return {
						order: normalized.order.length > 0 ? normalized.order : prev.order,
						pinned: normalized.pinned.length > 0 ? normalized.pinned : prev.pinned,
						overrides: prev.overrides
					}
				})
			}, function (error) {
				setCatalog(null)
				setCatalogError(errorMessage(error))
				throw error
			})
		}, [])

		var refreshPrefs = React.useCallback(function () {
			return fetchJson(API_PREFS).then(function (data) {
				if (isRecord(data) && data.ok === true) setPrefs(normalizePrefs(data.prefs))
			}, function () { /* 偏好拿不到不致命：本地默认顺序 */ })
		}, [])

		var show = React.useCallback(function () {
			if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null }
			// 入场动画交给 CSS @keyframes（元素挂载即播放），不依赖 rAF：后台标签页里 rAF 会被节流，
			// 依赖它会让面板停在 opacity:0 永不出现。
			setMounted(true)
			setOpen(true)
			setVisible(true)
		}, [])

		var hide = React.useCallback(function () {
			setOpen(false)
			setVisible(false)
			if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
			closeTimer.current = window.setTimeout(function () {
				closeTimer.current = null
				setMounted(false)
			}, 150)
		}, [])

		React.useEffect(function () {
			return function () { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current) }
		}, [])

		// 首次挂载就把会话目录拉起来，trigger 才能显示当前模型名。
		React.useEffect(function () {
			try { props.load() } catch (ignored) {}
		}, [])

		// 每次打开都重新拉一次 catalog（design-spec §8）并刷新目录。
		React.useEffect(function () {
			if (!open) return
			try { props.load() } catch (ignored) {}
			refreshCatalog().catch(function () {})
			refreshPrefs()
		}, [open, refreshCatalog, refreshPrefs])

		var onReorder = function (ids) {
			setPrefs(function (prev) { return { order: ids, pinned: prev.pinned, overrides: prev.overrides } })
			setPrefsError(null)
			fetchJson(API_PREFS, { method: 'POST', body: { order: ids } }).then(function (data) {
				if (isRecord(data) && data.ok === true && isRecord(data.prefs)) setPrefs(normalizePrefs(data.prefs))
			}, function (error) { setPrefsError(errorMessage(error)) })
		}

		var onTogglePin = function (id) {
			var pinned = prefsRef.current.pinned.indexOf(id) >= 0
				? prefsRef.current.pinned.filter(function (entry) { return entry !== id })
				: prefsRef.current.pinned.concat([id])
			setPrefs(function (prev) { return { order: prev.order, pinned: pinned, overrides: prev.overrides } })
			setPrefsError(null)
			fetchJson(API_PREFS, { method: 'POST', body: { pinned: pinned } }).then(function (data) {
				if (isRecord(data) && data.ok === true && isRecord(data.prefs)) setPrefs(normalizePrefs(data.prefs))
			}, function (error) { setPrefsError(errorMessage(error)) })
		}

		var writeCapability = function (providerId, modelId, patch) {
			var key = modelKeyOf(providerId, modelId)
			var previous = overridesRef.current[key] === undefined ? null : Object.assign({}, overridesRef.current[key])
			mutateOverrides(function (draft) {
				draft[key] = Object.assign({}, draft[key] || {}, patch)
			})
			return fetchJson(API_MODEL, { method: 'POST', body: { provider: providerId, model: modelId, patch: patch } }).then(function (data) {
				if (!isRecord(data)) throw new Error('写入响应异常')
				if (data.ok !== true) {
					// 失败：以宿主回传的真实值校准（没有就回滚到改动前）。
					var truth = isRecord(data.effective) ? data.effective : null
					mutateOverrides(function (draft) {
						if (truth !== null) draft[key] = {
							contextWindow: truth.contextWindow,
							maxTokens: truth.maxTokens,
							vision: truth.vision
						}
						else if (previous === null) delete draft[key]
						else draft[key] = previous
					})
					var error = new Error(typeof data.message === 'string' && data.message !== '' ? data.message : '宿主拒绝了这次修改')
					error.code = typeof data.code === 'string' ? data.code : 'WRITE_FAILED'
					throw error
				}
				if (isRecord(data.effective)) {
					mutateOverrides(function (draft) {
						draft[key] = {
							contextWindow: data.effective.contextWindow,
							maxTokens: data.effective.maxTokens,
							vision: data.effective.vision
						}
					})
				}
				void refreshCatalog().catch(function () {})
				return data
			}, function (error) {
				mutateOverrides(function (draft) {
					if (previous === null) delete draft[key]
					else draft[key] = previous
				})
				throw error
			})
		}

		var providers = React.useMemo(function () {
			return buildProviders(state, catalog, prefs, overrides)
		}, [state, catalog, prefs, overrides])

		var text = triggerTextOf(state)
		var currentProvider = state && state.current ? state.current.provider : null
		var flash1017 = state && state.current
			? isFlash1017(currentProvider, state.current.model, text.name)
			: false
		var pending = state && state.pending ? state.pending : null
		var busyTrigger = pending !== null || (state && state.status === 'selecting')
		// 目录取不到时触发器**保持可点**：点开就能看到明确错误（比一个死控件好诊断）。
		var directoryError = props.directoryError === null || props.directoryError === undefined ? null : String(props.directoryError)
		var disabled = props.locked === true || (props.available === false && directoryError === null)
		var label = directoryError !== null ? '模型目录不可用' : state === null || (state.status === 'loading' && !state.current) ? TEXT.triggerLoading : text.name || TEXT.triggerFallback
		var ariaLabel = disabled
			? TEXT.unavailable
			: directoryError !== null ? '模型目录不可用：' + directoryError
			: text.name === null
				? TEXT.triggerFallback
				: (text.effort === null ? '模型中心，当前 ' + text.name : '模型中心，当前 ' + text.name + '，档位 ' + text.effort)

		var trigger = h('div', { className: 'mh-root', 'data-model-hub': 'root' },
			h('button', {
				ref: triggerRef,
				type: 'button',
				className: 'mh-trigger',
				'data-model-hub': 'trigger',
				disabled: disabled,
				'aria-haspopup': 'dialog',
				'aria-expanded': open ? 'true' : 'false',
				'aria-label': ariaLabel,
				title: ariaLabel,
				onClick: function () { if (open) hide(); else show() }
			}, [
				h(IconModel, { key: 'i', size: 16, className: 'mh-triggerIcon' }),
				h('span', { key: 'l', className: 'mh-triggerLabel' },
					h('span', { className: flash1017 ? 'mh-tag1017' : undefined }, flash1017
						? [h('span', { key: 'n' }, label), h(Tag1017, { key: 'tag' })]
						: label)),
				text.effort !== null && text.effort !== undefined && state && state.current
					? h('span', { key: 'e', className: 'mh-triggerEffort' }, text.effort)
					: null,
				busyTrigger ? h(Spinner, { key: 's', small: true }) : null,
				h(IconChevronDown, { key: 'c', size: 14, className: 'mh-triggerChevron' })
			]))

		// 触发器也有兜底：最坏情况下渲染一个禁用的小按钮，绝不让条目被 abdicate。
		var seat = h(HubBoundary, {
			fallback: h('button', { type: 'button', className: 'mh-trigger', disabled: true, title: 'dsh-model-hub 渲染失败', 'data-model-hub': 'trigger-fallback' }, '模型中心不可用')
		}, trigger)

		var overlay = mounted && typeof document !== 'undefined' && document.body && typeof createPortal === 'function'
			// 弹窗崩溃时给一个**看得见**的降级提示（不能让“点了没反应”成为静默失败）。
			? createPortal(h(HubBoundary, { fallback: h('div', { className: 'mh-fallback', role: 'alert' }, TEXT.renderFailed), onFatal: props.onFatal, noticeText: TEXT.renderFailed }, h(ModelHubDialog, {
				visible: visible,
				state: state,
				providers: providers,
				pinnedIds: prefs.pinned,
				triggerRef: triggerRef,
				catalogReady: catalog !== null,
				catalogError: catalogError,
				prefsError: prefsError,
				select: props.select,
				onClose: function () {
					hide()
					if (triggerRef.current && typeof triggerRef.current.focus === 'function') triggerRef.current.focus()
				},
				onWrite: writeCapability,
				onReorder: onReorder,
				onTogglePin: onTogglePin,
				directoryError: props.directoryError,
				onRefreshCatalog: function () { refreshCatalog().catch(function () {}) }
			})), document.body)
			: null

		return h(React.Fragment, null, seat, overlay)
	}

	/* ══════════════════════════ 注册（遮蔽内置） ══════════════════════════ */

	function apply(ctx) {
		var WAIT_MS = 3000
		var waitTimer = null
		try {
			mhDiag('apply-start')
			ensureStyle()

			// 注册（拿到 modelDirectories / sessions 后调用；两条路径共用）
			var register = function (models, sessions) {
				ctx.slots.inject('conversation.input.model', function () {
					var dispose
					try {
						dispose = ctx.slots.register({
							name: 'conversation.input.model',
							// 负 priority：single 槽位里数值最小者渲染（内置未声明 priority ⇒ 0）。
							priority: SHADOW_PRIORITY,
							inject: function (sessionId) {
								// 任何取目录的异常都不允许冒泡到 renderer（那会让整条 slot 条目被 abdicate，
								// 插件看起来“完全没生效”）。降级为：触发器仍在，弹窗里给出明确错误。
								var directory = null
								var directoryError = null
								try {
									directory = models.directoryFor(sessionId)
								} catch (error) {
									directoryError = errorMessage(error)
									console.warn('[dsh-model-hub] modelDirectories.directoryFor 失败，模型位降级显示（内置选择器不受影响）：', error)
								}
								var available = directoryError === null && sessions.subagentAddress(sessionId) === undefined
								return {
									available: available,
									onFatal: function () { if (fatalDispose) fatalDispose() },
									directoryError: directoryError,
									directory: directory === null ? null : directory.store,
									load: function () {
										if (!available || directory === null) return
										try { directory.load().catch(function () {}) } catch (ignored) {}
									},
									select: function (selection) {
										if (!available || directory === null) {
											return Promise.resolve({
												ok: false,
												error: { code: 'model-hub/unavailable', message: directoryError === null ? TEXT.unavailable : directoryError }
											})
										}
										return directory.select(selection)
									}
								}
							}
						}, ModelHubSeat)
						fatalDispose = function () {
							var current = dispose
							dispose = null
							fatalDispose = null
							if (current) { try { current() } catch (ignored) {} }
						}
						mhDiag('slot-registered')
					} catch (error) {
						mhDiag('slot-register-failed', error)
						dispose = undefined
					}
					return function () { if (dispose) dispose() }
				})
			}

			// modelDirectories 由**内置 ui-model-selection** 提供：用户禁用它时，exports.inject 里挂着它
			// 会导致 apply 永不执行、静默永不启动（issue #1 的怀疑方向）。
			// 所以只在内核服务上声明依赖，把这一项放进 apply 内部等待。
			if (typeof ctx.inject === 'function') {
				waitTimer = window.setTimeout(function () {
					waitTimer = null
					mhDiag('waiting-services', null, { missing: ['modelDirectories'] })
				}, WAIT_MS)
				ctx.inject(['modelDirectories'], function (scoped) {
					if (waitTimer !== null) { window.clearTimeout(waitTimer); waitTimer = null }
					// 服务到位 ⇒ 收掉“未就绪”提示（如果之前已出现）
					mhDiagRemove(MH_DIAG_NOTICE)
					var models = scoped && scoped.modelDirectories ? scoped.modelDirectories : ctx.modelDirectories
					var sessions = scoped && scoped.sessions ? scoped.sessions : ctx.sessions
					register(models, sessions)
					return function () { if (waitTimer !== null) { window.clearTimeout(waitTimer); waitTimer = null } }
				})
			} else {
				// 老宿主 / 沙盘没有 ctx.inject：照旧直接取（取不到就在 register 里退化）
				register(ctx.modelDirectories, ctx.sessions)
			}

			if (typeof window !== 'undefined') {
				window.__DSH_MODEL_HUB__ = { version: MH_VERSION, priority: SHADOW_PRIORITY, build: MH_BUILD }
			}
			mhDiag('apply-ok')
		} catch (error) {
			// apply 已经失败：别再让等待定时器在 3s 后再报一次“服务未就绪”（那会误导排查方向）
			if (waitTimer !== null) { window.clearTimeout(waitTimer); waitTimer = null }
			mhDiag('apply-failed', error)
		}
	}

	// 只声明**内核级**服务；modelDirectories（内置 ui-model-selection 提供）在 apply 内等，
	// 否则用户禁用内置模型选择器时我们会永远等不到、静默不启动。
	// remote / remote.session 必须由**消费方自己**声明：
	// 内置 dsh-client-ui-model-selection/lib/client.js:1843-1850 就是这 6 个；
	// 少了这两个，modelDirectories.directoryFor() 内部取 ctx.remote.session 时会抛
	// 'cannot get property "remote.session" without inject'（typed-remote 的惰性 getter 检查的是调用方 fiber）。
	// 注意：modelDirectories 也依赖 remote.session —— 它在 apply 内的 ctx.inject 里等，
	// 而 inject 链是**调用方 fiber** 的，所以这两个仍在 exports.inject 里声明。
	exports.inject = ['slots', 'sessions', 'remote', 'remote.session']

	exports.apply = apply
}
