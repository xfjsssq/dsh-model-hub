# dsh-model-hub

把 DeepSeek Harness 聊天界面的模型选择器从「一长串扁平列表」换成 **双栏模型中心**：

- **左栏 = 提供商**（可拖拽排序、可置顶，顺序持久化；只显示有模型的，未配置的收进折叠区）
- **右栏 = 模型列表**（打开时显示所选提供商的模型；输入查询后**跨全部提供商搜索**，结果按提供商分组）
- **鼠标悬停模型行 → 浮出能力卡**，可当场改：上下文档位（128K / 256K / 1000K）、输出档位（128K / 256K）、视觉开关、思考档位
- 所有改动**真实写入模型配置**并在运行时校验生效；点选模型 = 真正切换会话模型（与内置 `/model` 共用同一份会话目录）

> 适配版本：DSH 桌面版 `0.2.1-rc.2`（2026-10-23 实测，见下方「验证」）。

## 安装

### 方式一：官方 CLI / GUI（推荐）

```powershell
# 本地目录（开发）
dsh plugin --profile desktop add "<本目录绝对路径>"

# 从 GitHub（分发）
dsh plugin --profile desktop add github:<账号>/dsh-model-hub
dsh plugin --profile desktop add github:<账号>/dsh-model-hub#v0.1.0
```

`dsh` 不在 PATH 时用安装目录里的 CLI，或直接走 GUI：

```powershell
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add <spec>
# GUI：侧边栏「插件」→ 添加插件 → 粘贴包名 / Git 地址 / 压缩包 / 本地绝对路径
```

### 方式二：可审计脚本（本仓库 tools/）

```powershell
pwsh -File tools\install.ps1 -DryRun   # 先看将要改什么（只预览，不写）
pwsh -File tools\install.ps1           # 安装：备份 → 改两处 → pnpm install → 回读校验
pwsh -File tools\uninstall.ps1         # 卸载（-DisableOnly 只关不卸）
```

脚本自带**越界拒绝**：JSON diff 只允许落在 `dependencies.<包名>` 与 `dsh.profile.bundles`，其它键变了就拒绝写；卸载后 `cordis.patch.yml` 与 `package.json` 逐字节复原（沙箱往返 27/27 已验证）。

## 装完之后怎么生效（重要）

| 场景 | 需要做什么 |
|---|---|
| **宿主侧 API**（`/model-hub/api/*`） | 安装即生效，**不需要重启**（实测：路由 404 → 200，正在运行的宿主直接激活） |
| **客户端 UI**（composer 上的模型位） | **刷新页面一次**（桌面端 `Ctrl+R`）—— 页面的启动清单在加载时生成，刷新才会带上新插件 |
| **插件自身的宿主代码更新**（升级版本后） | 需要**重启 DSH**（没有 HMR 时，Node 模块不会热重载）；客户端半边刷新页面即可 |

关掉插件而不用卸载：把 `dsh-model-hub/cordis.patch.yml` 里的 `enabled` 改成 `false` —— 宿主 API 停用、客户端条目不再注册，**内置模型选择器原样恢复**（无 CSS/DOM 残留）。

## 使用

| 操作 | 结果 |
|---|---|
| 点击 composer 上的模型位 | 打开模型中心 |
| 左栏点击 / `←` `→` | 切换提供商 |
| 搜索框输入 | **跨全部提供商**按模型名/ID 模糊匹配，结果按提供商分组；清空后回到所选提供商 |
| `↑` `↓` + `Enter` | 键盘选模型（焦点留在搜索框） |
| 悬停模型行 120ms | 浮出能力卡 |
| 能力卡点档位 / 开关 | 写入模型配置 → 回读运行时确认 → 立即生效；对不上会显示 `NOT_EFFECTIVE` 并回滚 |
| 能力卡点思考档位 | 提交会话级 `reasoningEffort`；若不是当前模型，**一次点击同时切换该模型并应用档位**（卡片有提示） |
| 左栏拖拽 / 右键或行尾图钉 | 调整提供商顺序 / 置顶，立即持久化 |

## 数据与文件

- 偏好：`~/.dsh/model-hub/prefs.json`（提供商顺序、置顶、能力覆盖记录）
- 模型能力真正落在：profile 的 `cordis.patch.yml` → `llm-pi-ai.providers.<提供商>.models[]`（与设置页「模型」**同一处**）

## 架构

```
dsh-model-hub/
  index.js                 宿主侧 cordis 插件入口（inject: webServer / llm）
  lib/host/                catalog / settings-bridge / apply / selftest / prefs / routes
  client.js                浏览器侧 bundle（classic script，零构建，仅用 react/react-dom）
  cordis.patch.yml         组合声明（enabled 开关）
  docs/design-spec.md      审美与交互规格（含 v1.1 修订）
  test/host.test.mjs       零依赖桩宿主测试
```

宿主侧 HTTP API（同源 JSON；写接口要求 `Content-Type: application/json`）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/model-hub/api/health` | 诊断（`hasLlm` / `hasSettings` / 端口） |
| GET | `/model-hub/api/catalog` | 提供商 + 模型 + 元数据（上下文/输出/视觉/思考档位/是否有凭证） |
| GET/POST | `/model-hub/api/prefs` | 提供商顺序、置顶 |
| POST | `/model-hub/api/model` | 写能力 `{provider, model, patch:{contextWindow?, maxTokens?, vision?}}` → 返回 `effective` / `verify` / `prepared` |
| POST | `/model-hub/api/selftest` | 改前/改后对比（含 `prepareCall` 物化结果与可选还原），用于验证「真生效」 |

## 验证（2026-10-23，独立 teammate 用隔离实例 + 真宿主实测）

**冻结版本（七轮独立验证全绿）**：
`client.js` 107350 bytes / 2216 行 / sha256 `af3e5e10820eb2a2cb0c7545e37fcf3574b0086bbbfbc303efeeb32b2e365063`
完整报告：`_recon/verify/REPORT.md`（821 行，含 31 张截图与全部原始证据）。

- **不需要重启即激活**：真宿主 `/model-hub/api/*` 由 404 → 200；profile 只多出 `dependencies` 一项与 `bundles` 末尾一项，`cordis.patch.yml` sha256 未变。
- **改动真进请求**：`POST /model` 后 `prepareCall` 物化结果随之改变（`maxTokens 128000→65536`、`contextWindow 1000000→131072`、`inputModalities ['text','image']→['text']`），且**一次真实对话请求的 body 里确实带了新值**（本机 mock 上游收到 `max_completion_tokens=65536`，零上游费用）。
- **可还原**：selftest 临时改写后 `cordis.patch.yml` **逐字节复原**（sha256 前后相同）。
  - **例外**：`sha256` 逐字节比对只适用于「补丁仅修改已有字段」。若补丁 unset 了已有键（`reasoningEfforts: null`，或去掉 image 导致 `imagePixelBudget`/`imageMaxBytes` 被删），还原时该键只能重新追加到对象末尾，键序变化会让 sha256 变化，但**配置语义等价** —— 此时请改用**解析后深比较**（键集合 + 值）。
- **界面**：真实 GUI 里打开弹窗、provider 切换、搜索、悬停能力卡、改档位写穿、选中模型并发送成功；P0（客户端组件挂载即崩）经 A/B 归因 → 修复 → 同一套探针复验通过。
- **降级保证**：客户端注册/渲染失败时，内置模型选择器自动接管（实测确认没有白屏）。

## 测试

```powershell
cd dsh-model-hub
node --check index.js
node --test        # 57 项：catalog / 写入 / NOT_EFFECTIVE / prepareCall 一致性 / selftest 还原 / 路由 / prefs / inputModalities / reasoningEfforts
```

## 已知限制

- `/model` 斜杠命令的弹窗仍是内置 UI（新 UI 只接管 composer 上的模型位）。
- 思考档位是**会话级选择**（DSH 的 `ModelSelection.reasoningEffort`），不是模型配置字段；模型未公布档位时不显示该行。
- 给「上游其实不支持视觉」的模型强制打开视觉，会在请求时由上游报错 —— 卡片有一行警告，风险自负。
- 提供商排序/置顶存在 `prefs.json`；能力值不在插件侧缓存，每次打开弹窗重新拉取。
- 升级插件版本后，宿主侧代码需要重启 DSH 才更新。
- **不支持 pi-ai 的 `reasoningEfforts: false`**（该取值表示「该模型不推理」）：传入会得到 `INVALID_REASONING_EFFECTS`。要表达这个语义请传 `null` 删除该字段。这与设置页行为一致（设置页同样把 `false` 视为未声明）。

## 安装后验证清单（Windows 桌面版实测，逐步对照）

按顺序做；每步都写清"应该看到什么"。哪一步不对，先用下面的**自检口**定位，再报障。

| # | 做什么 | 应该看到什么 |
|---|---|---|
| 1 | `dsh plugin --profile desktop add <包名 / Git 地址 / 本地路径>`（或 GUI：侧边栏「插件」→ 添加插件） | 命令成功；profile 的 `package.json` 出现 `dependencies.dsh-model-hub`，`dsh.profile.bundles` 末尾多一项 |
| 2 | **重启 DSH 桌面端**（第一次安装尤其需要：宿主侧插件要重新装载组合） | 浏览器打开 `http://127.0.0.1:<GUI 端口>/model-hub/api/health` → `200`，且 `hasLlm:true`、`hasSettings:true` |
| 3 | **硬刷新页面**（`Ctrl+Shift+R`，普通刷新可能命中缓存） | 输入框右下角的模型位变成带图标的按钮；点它打开**双栏**面板（左提供商 / 右模型） |
| 4 | 悬停任意模型行 | 约 120ms 后浮出 200px 的能力卡（上下文 / 输出 / 输入类型 / 推理等级） |

> **为什么第一次安装通常要重启**：桌面端没有 HMR，插件升级后 `lib/host/*` 不会热重载。客户端那半只需刷新页面，宿主那半需要重启 —— 这两件事看起来一样，但不一样。

## 自检口：界面不出来时怎么一句话说清

**不需要打开 DevTools。** 插件会把浏览器侧的进展上报给宿主，直接在浏览器里打开：

```
http://127.0.0.1:<GUI 端口>/model-hub/api/health
```

关注四个字段：`pluginVersion`（磁盘上的版本）、`clientVersion`（**浏览器里实际跑的那一版**）、`clientState`（浏览器侧跑到哪一步）、`clientStateAgeMs`。

| `clientState.stage` | 含义 / 下一步 |
|---|---|
| 空（null） | 客户端**根本没加载**（或浏览器里是早于本机制的旧版本）—— 检查是否硬刷新过、包里 `client.js` 是否被下发 |
| `bundle-loaded` | 加载了，但 `apply` 没跑（卡在服务等待） |
| `waiting-services` | 卡住了 → 看 `clientState.missing` 里缺哪个服务 |
| `slot-register-failed` / `apply-failed` / `build-failed` | 抛错了 → 看 `clientState.error`；页面上也会有可关闭的红框与标题提示 |
| `apply-ok` / `slot-registered` | 客户端侧是健康的 → 问题不在这里 |

另外两条：`clientVersion` 为 null 但 `stage` 有值 → 浏览器跑的是**更早的构建**；`clientVersion ≠ pluginVersion` → 浏览器与磁盘**不是同一版**（该刷新或该重启）。

失败时页面上还会直接显示：`document.title` 带 `[模型中心 <阶段>]`，左下角一个可关闭的红框（阶段 + 构建标签 + 错误摘要 + 前 4 行栈）。成功时不显示任何东西。

## License

MIT