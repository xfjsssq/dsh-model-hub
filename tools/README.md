# tools/ —— dsh-model-hub 的安装、回滚与取证脚本

> 这些脚本只服务"本地开发 + 可审计"。**对外分发请优先走官方两条路**（下面第 1 节）。
> 本目录的脚本从不修改 \`app.asar\`，也从不调用任何上游模型（不产生费用）。

## 1. 安装这个插件的三条路

| 路径 | 命令 / 操作 | 说明 |
|---|---|---|
| **GUI**（推荐给用户） | 侧边栏「插件」-> 添加插件 | 接受 包名 / Git 地址 / 压缩包 / **本地绝对路径**。官方路径，会自己维护 \`package.json\`/\`lockfile\`/失败回滚。 |
| **CLI**（推荐给脚本） | \`"<DSH 根>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add <spec>\` | \`dsh plugin\` 把剩余参数**原样转发给 profile 目录下的 pnpm**（见 \`dsh plugin --help\`）。所以 \`add <spec>\`、\`remove <pkg>\`、\`why <pkg>\` 都可用。 |
| **本目录脚本**（本地开发） | \`pwsh -File tools\install.ps1\` | 手改 \`profile\package.json\` + 跑 pnpm。**先跑 \`-DryRun\` 看 diff**。 |

\`<spec>\` 三选一：包名（可带版本/标签，如 \`dsh-model-hub@0.1.0\`）、Git 地址、**本地绝对路径**。
本地路径在这个仓库里就是 \`<本目录绝对路径>\`
（脚本会自动把它写成 \`file:<绝对路径>\` 形式的依赖）。

### 生效语义（官方文档结论，实测记录）

\`@deepseek-ai/dsh-plugin-manager\` 的 README：**"没有 HMR 时，安装新包、启用组合包以及删除成功后，
都会发布 profile 的 runtime resolution；……激活等待重启。"**
所以：**先装 → 刷新 GUI 页面看插件是否出现 → 没出现就去插件页确认它是否 enabled → 仍不行再考虑重启。**
当前这台宿主进程的命令行里**没有 \`--hmr\`**（脚本每次运行都会实测并打印）。

> 重启会终止用户当前会话，也会终止正在这个桌面端里运行的 Agent 会话。**不要自作主张重启。**

## 2. 脚本清单

| 文件 | 用途 |
|---|---|
| \`install.ps1\` | 安装：预检 -> DryRun -> 备份 -> node 精确改 JSON -> pnpm install -> 回读校验 -> 重启/回滚指引 |
| \`uninstall.ps1\` | 卸载；\`-DisableOnly\` 只写一条带标记的 \`disabled: true\` 覆盖项；\`-EnableOnly\` 撤销它 |
| \`profile-patch.mjs\` | 被上面两个脚本调用的**精确编辑器**：JSON parse→mutate→re-serialize→**re-parse**；越界拒绝；YAML 只动自己写的标记块 |
| \`_lib.ps1\` | 上面两个 ps1 共用的辅助函数（被 dot-source） |
| \`selftest.ps1\` | **沙箱往返演练**：在 \`%TEMP%\` 的 profile 副本上验证装机/卸载幂等，真实 profile 只读 |
| \`probe-modelhub.mjs\` | 对宿主路由取证：每次调用打印 **HTTP 状态码 + 响应体**，默认只读 |
| \`mock-openai.mjs\` | 本地假上游（127.0.0.1），零费用验证请求体里的 \`max_tokens\` 等参数 |

## 3. install.ps1

\`\`\`powershell
pwsh -File tools\install.ps1 -DryRun     # 只预览：不写文件、不备份、不跑 pnpm
pwsh -File tools\install.ps1             # 真正执行
pwsh -File tools\install.ps1 -SkipPnpm   # 只改 JSON（随后用 GUI 插件页完成安装）
\`\`\`

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| \`-PluginPath\` | \`$PSScriptRoot\..\dsh-model-hub\` | 插件目录（用脚本位置推导，**不写死盘符**） |
| \`-ProfileDir\` | \`$env:USERPROFILE\.dsh\profiles\desktop\` | 目标 profile |
| \`-PnpmMode\` | \`bundled\` | \`bundled\`=DSH 自带 runtime 的 pnpm（与 DSH 维护 lockfile 的版本一致）；\`global\`=PATH 上的 pnpm；\`auto\`=先自带再全局。拿不到 bundled 会自动回退并告警 |
| \`-PnpmPath\` | 空=自动探测 | 指定全局 pnpm（\`.cmd\`/\`.ps1\`/\`.cjs\`/\`.mjs\` 均可） |
| \`-NodePath\` | 空=自动探测 | PATH 上的 \`node\` -> 运行中桌面端的 **Electron-as-node** |
| \`-DshDesktopRoot\` | 空=自动推导 | DSH 安装根目录；默认从**正在运行的**宿主进程推导 |
| \`-DryRun\` / \`-SkipPnpm\` / \`-NoBackup\` | — | 见上 |

行为要点：

* 备份三个文件为 \`<原名>.bak-modelhub-<yyyyMMdd-HHmmss>\`：\`package.json\`、\`cordis.patch.yml\`、\`pnpm-lock.yaml\`。
* **pnpm install 失败会自动从备份回滚** \`package.json\` 与 \`pnpm-lock.yaml\`（与官方插件管理器的失败语义一致），退出码 **2**。
* 退出码：\`0\` 成功 / \`1\` 预检或应用失败 / \`2\` pnpm 失败已回滚 / \`3\` 找不到 pnpm。
* \`profile-patch.mjs\` 的 JSON 改动**只允许**落在 \`dependencies.<包名>\` 与 \`dsh.profile.bundles\` 两处，别的键变了它直接**拒绝写**。
* 本插件自带 \`dsh.bundle.patch\`，所以 **profile 的 \`cordis.patch.yml\` 不会被改**（但仍会备份）。

## 4. 回滚

\`\`\`powershell
pwsh -File tools\uninstall.ps1 -DisableOnly   # 最轻：写一条 disabled 覆盖项，内置模型选择器恢复
pwsh -File tools\uninstall.ps1                # 完整卸载（改 package.json + pnpm install 裁剪依赖）
pwsh -File tools\uninstall.ps1 -EnableOnly    # 撤销 -DisableOnly
\`\`\`

最兜底：把 \`.bak-modelhub-<ts>\` 覆盖回对应的三个文件。

## 5. 取证

\`\`\`bash
# 沙箱往返演练（不碰真实 profile）
pwsh -File tools\selftest.ps1

# 宿主路由：默认只读，先确认路由通了
node tools/probe-modelhub.mjs
# 全量：只读 + POST /model 往返 + selftest 四字段 + restore + patch 文件逐字节复原校验
node tools/probe-modelhub.mjs --mode all
\`\`\`

\`probe-modelhub.mjs\` 会：

* 每次调用都打印 **HTTP 状态码 + 响应体**（\`--verbose\` 打印全文）；
* 把完整原始响应写进 \`_recon/verify/probe-<ts>.json\`；
* 若 \`selftest\` 响应里**没有** \`prepareCall\` 物化后的 config，会大声报出来（不自己绕过）；
* 整轮前后各算一次 \`cordis.patch.yml\` 的 sha256，断言它**逐字节复原**（selftest 会临时改它）。

若路由返回 **401**（GUI 的浏览器会话认证），带 Cookie：

\`\`\`bash
node tools/probe-modelhub.mjs --cookie "dsh_web_session@127.0.0.1:57826=...."
# 或设环境变量 DSH_COOKIE
\`\`\`

## 6. 零费用的"参数真的进了请求体"验证

\`\`\`bash
node tools/mock-openai.mjs --expect-max-tokens 262144
# 打印 PORT=<n>；把某个临时 provider 的 baseURL 填 http://127.0.0.1:<n>/v1
# 在 GUI 里选那个模型发一句 hi -> 脚本会断言收到的 max_tokens
\`\`\`

只 bind \`127.0.0.1\`，不向外转发，不调用上游，**不产生任何费用**。做完请把临时 provider 的 \`baseURL\` 还原。

## 7. 纪律

* 不修改 \`app.asar\`；不改别人的源码。
* 任何会**产生上游真实费用**的调用一律不做（本目录脚本都不联网）。
* **重启 DSH 桌面端前必须先报 Lead / 与用户约时间。**
