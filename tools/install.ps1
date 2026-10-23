#Requires -Version 7.0
<#
.SYNOPSIS
    把本地 bundle 插件（默认 dsh-model-hub）安装进 DSH 桌面端 profile。
    这是**本地开发/可审计**的安装路径；对外分发优先用官方两条路（见 tools\README.md）：
      GUI  侧边栏「插件」-> 添加插件（包名 / Git 地址 / 压缩包 / 本地绝对路径）
      CLI  "<DSH 根>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add <spec>

.DESCRIPTION
    流程：预检（含运行中的桌面端宿主探测）-> DryRun 预览（profie-patch.mjs --dry-run，不写任何文件）
          -> 备份 -> node 精确改 profile\package.json -> pnpm install（workdir = profile）-> 回读校验。

    备份（除非 -NoBackup）：package.json / cordis.patch.yml / pnpm-lock.yaml
    一律写成 <原名>.bak-modelhub-<yyyyMMdd-HHmmss>。

    pnpm install 失败会自动从备份回滚 package.json 与 pnpm-lock.yaml
    （与官方 @deepseek-ai/dsh-plugin-manager 的失败语义一致），退出码 2。

    pnpm 默认用 **DSH 自带 runtime 的那一份**（与 DSH 自己维护 node_modules/lockfile 的版本一致，
    避免 lockfile 抖动）；拿不到时自动回退到 PATH 上的 pnpm 并告警。用 -PnpmMode 切换。

    所有路径都不写死盘符：DSH 根目录从运行中的桌面端进程推导，node 从 PATH 推导。

    退出码：0 成功 / 1 预检或应用失败 / 2 pnpm 失败已回滚 / 3 找不到 pnpm

.PARAMETER DryRun
    只预览：打印将要发生的改动、将要执行的命令、将备份哪些文件。不写文件、不备份、不跑 pnpm。

.PARAMETER SkipPnpm
    只改 JSON、不跑 pnpm（例如随后用 GUI 插件页完成安装时）。

.PARAMETER PnpmMode
    bundled（默认，DSH 自带 pnpm）| global（PATH 上的 pnpm）| auto（先自带，再全局）

.PARAMETER PnpmPath
    指定全局 pnpm（.cmd/.ps1/.cjs/.mjs 均可）。留空 = 自动探测。

.PARAMETER NodePath
    指定 node 可执行文件。留空 = 自动探测（PATH -> 运行中桌面端的 Electron-as-node）。

.PARAMETER DshDesktopRoot
    DSH 桌面端安装根目录（含 resources\runtime）。留空 = 从运行中的进程推导。

.EXAMPLE
    pwsh -File tools\install.ps1 -DryRun
    pwsh -File tools\install.ps1
    pwsh -File tools\install.ps1 -SkipPnpm
#>
[CmdletBinding()]
param(
    [string]$PluginPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dsh-model-hub'),
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [ValidateSet('bundled', 'global', 'auto')][string]$PnpmMode = 'bundled',
    [string]$PnpmPath = '',
    [string]$NodePath = '',
    [string]$DshDesktopRoot = '',
    [switch]$DryRun,
    [switch]$SkipPnpm,
    [switch]$NoBackup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_lib.ps1')

$PatchScript = Join-Path $PSScriptRoot 'profile-patch.mjs'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$ManagedFiles = @('package.json', 'cordis.patch.yml', 'pnpm-lock.yaml')
$Rc = @{ Ok = 0; Preflight = 1; PnpmFailed = 2; NoPnpm = 3 }

Head '预检'
Say ('工作目录              : ' + (Get-Location).Path)
Say ('插件目录(-PluginPath) : ' + $PluginPath)
Say ('profile(-ProfileDir)  : ' + $ProfileDir)

if (-not (Test-Path -LiteralPath $PatchScript)) { Bad ('缺少辅助脚本：' + $PatchScript); exit $Rc.Preflight }
if (-not (Test-Path -LiteralPath $ProfileDir)) { Bad ('profile 不存在：' + $ProfileDir); exit $Rc.Preflight }
if (-not (Test-Path -LiteralPath $PluginPath)) { Bad ('插件目录不存在：' + $PluginPath); exit $Rc.Preflight }
$PluginDir = (Resolve-Path -LiteralPath $PluginPath).ProviderPath
$ProfileDir = (Resolve-Path -LiteralPath $ProfileDir).ProviderPath
$pluginManifest = Join-Path $PluginDir 'package.json'
if (-not (Test-Path -LiteralPath $pluginManifest)) { Bad ('插件缺少 package.json：' + $pluginManifest); exit $Rc.Preflight }

$hostInfo = Get-DshHostInfo
if ($hostInfo.Found) {
    Say ('运行中的宿主 PID     : ' + $hostInfo.Pid)
    Say ('宿主可执行文件       : ' + $hostInfo.Exe)
    Say ('HMR                  : ' + $(if ($hostInfo.Hmr) { 'ON（--hmr）' } else { 'OFF（未检测到 --hmr）' }))
    Say ('宿主 --profile 参数  : ' + $hostInfo.ProfileArg)
    if ($hostInfo.ProfileArg -and ($hostInfo.ProfileArg.TrimEnd('\') -ne $ProfileDir.TrimEnd('\'))) {
        Warn '注意：宿主的 profile 参数与本次要改的 profile 目录不同，请确认你改的是对的 profile。'
    }
} else {
    Warn '没有探测到运行中的 DSH 桌面端宿主进程（可能未启动）——DSH 自带 pnpm 将无法推导。'
}

$nodeCmd = Resolve-NodeCommand -Preferred $NodePath -HostInfo $hostInfo
if ($null -eq $nodeCmd) { Bad '找不到可用的 node（PATH 上没有，也拿不到 Electron-as-node）'; exit $Rc.Preflight }
Say ('node                 : ' + $nodeCmd.Label)
$preNodeCheck = Invoke-Cmd -Cmd $nodeCmd -ExtraArgs @('--version') -WorkDir $null
Say ('node --version       : ' + ((($preNodeCheck.Output) | Out-String).Trim()))

$pnpmCmd = Resolve-PnpmCommand -Mode $PnpmMode -Preferred $PnpmPath -HostInfo $hostInfo -DshDesktopRoot $DshDesktopRoot -NodeCmd $nodeCmd
if ($pnpmCmd) {
    Say ('pnpm(-PnpmMode=' + $PnpmMode + ') : ' + $pnpmCmd.Label)
} else {
    Warn ('找不到可用的 pnpm（-PnpmMode=' + $PnpmMode + '）；-DryRun 仍可继续，真正执行时会失败。')
}

Head 'DryRun 预览（不写任何文件）'
$pre = Invoke-Patch -NodeCmd $nodeCmd -PatchScript $PatchScript -PatchArgs @('install', '--profile', $ProfileDir, '--plugin', $PluginDir, '--dry-run')
Say $pre.Raw
if ($null -eq $pre.Json -or -not $pre.Json.ok) {
    Bad 'DryRun 失败或被拒绝，已中止（未改任何文件）。上面 JSON 里的 code / message 是原因。'
    exit $Rc.Preflight
}

$pluginName = $pre.Json.plugin.name
$pluginVersion = $pre.Json.plugin.version
$pluginSpec = $pre.Json.plugin.spec

Head '计划'
Say ('插件            : ' + $pluginName + ' ' + $pluginVersion)
Say ('安装 spec       : ' + $pluginSpec)
Say ('profile         : ' + $ProfileDir)
Say ('依赖            : ' + $pre.Json.json.dependencyAction)
Say ('bundles         : ' + $pre.Json.json.bundleAction)
Say ('cordis.patch.yml: ' + $pre.Json.yaml.action)
foreach ($n in $pre.Json.notes) { Say ('note            : ' + $n) }
Say ''
Say ('将备份（.bak-modelhub-' + $Stamp + '）：')
foreach ($f in $ManagedFiles) {
    $src = Join-Path $ProfileDir $f
    if (Test-Path -LiteralPath $src) { Say ('  - ' + $f) } else { Say ('  - ' + $f + '   (不存在，跳过)') }
}
if ($SkipPnpm) {
    Say '将执行          : (跳过 pnpm，-SkipPnpm)'
} elseif ($pnpmCmd) {
    Say ('将执行          : ' + $pnpmCmd.Label + '  install   (工作目录 ' + $ProfileDir + ')')
} else {
    Say '将执行          : (找不到 pnpm)'
}
Say ('lockfileVersion : ' + (Get-LockfileVersion $ProfileDir) + '   (改动后会再报一次)')

if ($DryRun) {
    Head 'DryRun 结束'
    Good '没有写入任何文件、没有备份、没有跑 pnpm。'
    Say ('真正执行：pwsh -File ' + $PSCommandPath)
    exit $Rc.Ok
}

# ------------------------------------------------------------------ 备份 -----
$backups = Backup-ProfileFiles -ProfileDir $ProfileDir -Stamp $Stamp -Files $ManagedFiles -NoBackup:$NoBackup
$lockBefore = Get-LockfileVersion $ProfileDir

# ------------------------------------------------------- 应用 profile 改动 ----
Head '应用 profile 改动（node 精确改 JSON，幂等、越界拒绝）'
$app = Invoke-Patch -NodeCmd $nodeCmd -PatchScript $PatchScript -PatchArgs @('install', '--profile', $ProfileDir, '--plugin', $PluginDir)
Say $app.Raw
if ($null -eq $app.Json -or -not $app.Json.ok) {
    Bad '应用失败或被拒绝。'
    if ($backups.Count -gt 0) {
        $restored = Restore-Profile -Backups $backups -ProfileDir $ProfileDir
        Warn ('已回滚：' + (@($restored) -join ', '))
    }
    exit $Rc.Preflight
}
Good 'profile 改动已写入并通过回读校验'

# ------------------------------------------------------------ pnpm install ---
if ($SkipPnpm) {
    Warn '-SkipPnpm：跳过 pnpm install。请用 GUI 插件页完成安装/热发布，或稍后手动 pnpm install。'
} else {
    Head 'pnpm install'
    if (-not $pnpmCmd) {
        Bad '找不到可用的 pnpm。JSON 改动已写入并保留；可手工在 profile 目录跑 pnpm install。'
        exit $Rc.NoPnpm
    }
    Say ('使用：' + $pnpmCmd.Label)
    $res = Invoke-Cmd -Cmd $pnpmCmd -ExtraArgs @('install') -WorkDir $ProfileDir
    $res.Output | ForEach-Object { Write-Host $_ }
    if ($res.ExitCode -ne 0) {
        Bad ('pnpm install 失败，退出码 ' + $res.ExitCode)
        if ($backups.Count -gt 0) {
            $restored = Restore-Profile -Backups $backups -ProfileDir $ProfileDir
            Warn ('已回滚：' + (@($restored) -join ', '))
        }
        exit $Rc.PnpmFailed
    }
    Good 'pnpm install 成功'
}

# ---------------------------------------------------------------- 回读校验 ---
Head '回读校验'
$link = Join-Path $ProfileDir ('node_modules\' + $pluginName)
if (Test-Path -LiteralPath $link) { Good ('node_modules\' + $pluginName + ' 存在') }
else { Warn ('node_modules\' + $pluginName + ' 不存在（-SkipPnpm 或 pnpm 布局差异时正常）') }
$lockAfter = Get-LockfileVersion $ProfileDir
Say ('lockfileVersion : ' + $lockBefore + '  ->  ' + $lockAfter)
if ($lockBefore -ne $lockAfter) { Warn 'lockfileVersion 发生变化，说明 pnpm 版本与原先不同；已用 -PnpmMode bundled 时请把这条报给 lead。' }
$rb = Invoke-Patch -NodeCmd $nodeCmd -PatchScript $PatchScript -PatchArgs @('install', '--profile', $ProfileDir, '--plugin', $PluginDir, '--dry-run')
if ($null -ne $rb.Json -and $rb.Json.ok) {
    Say ('再次 DryRun：依赖 = ' + $rb.Json.json.dependencyAction + '，bundles = ' + $rb.Json.json.bundleAction + '   （应为 already-present，即幂等）')
}

# ------------------------------------------------------------------ 指引 -----
Head '下一步'
if ($hostInfo.Found) { Say ('当前宿主进程 PID : ' + $hostInfo.Pid) }
if ($hostInfo.Hmr) {
    Good '宿主命令行带 --hmr：配置变化可能热生效；仍然建议刷新 GUI 页面确认。'
} else {
    Warn '宿主命令行没有 HMR 开关。官方文档（dsh-plugin-manager）：没有 HMR 时，安装新包会发布'
    Warn 'runtime resolution，但「激活等待重启」。所以：先刷新 GUI 页面看插件是否出现；'
    Warn '没出现就去插件页确认它是否 enabled；仍不行就停下来报 lead，不要自己重启。'
}
Say ''
Say '重启会终止用户当前会话，也会终止正在这个桌面端里运行的 Agent 会话。'
Say '本任务纪律：重启前必须先报 lead / 与用户约时间，不要自作主张重启。'
Say ''
Say '官方安装路径（对外分发优先）：'
if ($hostInfo.Root) {
    $dshCmd = Join-Path $hostInfo.Root 'resources\runtime\cli\bin\dsh.cmd'
    Say ('  CLI : "' + $dshCmd + '" plugin --profile desktop add "' + $pluginSpec + '"')
}
Say '  GUI : 侧边栏「插件」-> 添加插件（包名 / Git 地址 / 压缩包 / 本地绝对路径）'
Say ''
Say '回滚方法：'
Say ('  1) 只关闭不卸载：pwsh -File ' + (Join-Path $PSScriptRoot 'uninstall.ps1') + ' -DisableOnly')
Say ('  2) 完整卸载    ：pwsh -File ' + (Join-Path $PSScriptRoot 'uninstall.ps1'))
if ($backups.Count -gt 0) {
    Say '  3) 手工兜底：把备份覆盖回去'
    foreach ($k in $backups.Keys) {
        Say ('       Copy-Item -LiteralPath "' + $backups[$k] + '" -Destination "' + (Join-Path $ProfileDir $k) + '" -Force')
    }
}
Head '安装脚本结束'
Good ('profile = ' + $ProfileDir + ' ；插件 = ' + $pluginName)
exit $Rc.Ok
