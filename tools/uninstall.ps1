#Requires -Version 7.0
<#
.SYNOPSIS
    从 DSH 桌面端 profile 卸载本地 bundle 插件（默认 dsh-model-hub），或只把它关掉。

.DESCRIPTION
    完整卸载（默认）：
      1) 备份 package.json / cordis.patch.yml / pnpm-lock.yaml -> .bak-modelhub-<ts>
      2) node 精确改：删依赖 + 从 dsh.profile.bundles 移除（并清掉本套脚本写过的 YAML 标记块）
      3) pnpm install（workdir = profile）以裁剪已移除的依赖
      4) 回读校验：确认依赖与 bundles 里都不再有它

    -DisableOnly（快速关闭，不卸载、不跑 pnpm）：
      只往 profile\cordis.patch.yml 追一条带标记的 '- id: <pkg> / disabled: true' 覆盖项。
      内置模型选择器随即恢复（没有 HMR 时仍需重启桌面端才生效）。幂等：已有该块时不重复追加。
      -EnableOnly 撤销这个覆盖项、把插件重新打开。

    官方卸载路径：GUI 侧边栏「插件」里删除，或
      "<DSH 根>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-model-hub

    退出码：0 成功 / 1 预检或应用失败 / 2 pnpm 失败 / 3 找不到 pnpm

.EXAMPLE
    pwsh -File tools\uninstall.ps1 -DryRun
    pwsh -File tools\uninstall.ps1 -DisableOnly
    pwsh -File tools\uninstall.ps1
    pwsh -File tools\uninstall.ps1 -EnableOnly
#>
[CmdletBinding()]
param(
    [string]$PluginPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dsh-model-hub'),
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [ValidateSet('bundled', 'global', 'auto')][string]$PnpmMode = 'bundled',
    [string]$PnpmPath = '',
    [string]$NodePath = '',
    [string]$DshDesktopRoot = '',
    [switch]$DisableOnly,
    [switch]$EnableOnly,
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

if ($DisableOnly -and $EnableOnly) { Bad '-DisableOnly 与 -EnableOnly 不能同时用'; exit 1 }
$mode = 'uninstall'
if ($DisableOnly) { $mode = 'disable' }
if ($EnableOnly) { $mode = 'enable' }

Head '预检'
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
    Say ('HMR                  : ' + $(if ($hostInfo.Hmr) { 'ON（--hmr）' } else { 'OFF（未检测到 --hmr）' }))
    Say ('宿主 --profile 参数  : ' + $hostInfo.ProfileArg)
} else {
    Warn '没有探测到运行中的 DSH 桌面端宿主进程。'
}

$nodeCmd = Resolve-NodeCommand -Preferred $NodePath -HostInfo $hostInfo
if ($null -eq $nodeCmd) { Bad '找不到可用的 node（PATH 上没有，也拿不到 Electron-as-node）'; exit $Rc.Preflight }
Say ('node                 : ' + $nodeCmd.Label)
$pnpmCmd = Resolve-PnpmCommand -Mode $PnpmMode -Preferred $PnpmPath -HostInfo $hostInfo -DshDesktopRoot $DshDesktopRoot -NodeCmd $nodeCmd
if ($pnpmCmd) { Say ('pnpm(-PnpmMode=' + $PnpmMode + ') : ' + $pnpmCmd.Label) }
else { Warn ('找不到可用的 pnpm（-PnpmMode=' + $PnpmMode + '）') }

Head ('DryRun 预览（mode = ' + $mode + '，不写任何文件）')
$pre = Invoke-Patch -NodeCmd $nodeCmd -PatchScript $PatchScript -PatchArgs @($mode, '--profile', $ProfileDir, '--plugin', $PluginDir, '--dry-run')
Say $pre.Raw
if ($null -eq $pre.Json -or -not $pre.Json.ok) {
    Bad 'DryRun 失败或被拒绝，已中止（未改任何文件）。'
    exit $Rc.Preflight
}
$pluginName = $pre.Json.plugin.name
Say ''
Say ('插件            : ' + $pluginName + ' ' + $pre.Json.plugin.version)
Say ('profile         : ' + $ProfileDir)
Say ('依赖            : ' + $pre.Json.json.dependencyAction)
Say ('bundles         : ' + $pre.Json.json.bundleAction)
Say ('cordis.patch.yml: ' + $pre.Json.yaml.action)

if ($DryRun) {
    Head 'DryRun 结束'
    Good '没有写入任何文件、没有备份、没有跑 pnpm。'
    if ($mode -eq 'uninstall') { Say ('真正执行：pwsh -File ' + $PSCommandPath) }
    elseif ($mode -eq 'disable') { Say ('真正执行：pwsh -File ' + $PSCommandPath + ' -DisableOnly') }
    else { Say ('真正执行：pwsh -File ' + $PSCommandPath + ' -EnableOnly') }
    exit $Rc.Ok
}

# ------------------------------------------------------------------ 备份 -----
$backups = Backup-ProfileFiles -ProfileDir $ProfileDir -Stamp $Stamp -Files $ManagedFiles -NoBackup:$NoBackup
$lockBefore = Get-LockfileVersion $ProfileDir

# ------------------------------------------------------------------ 应用 -----
Head ('应用改动（mode = ' + $mode + '）')
$app = Invoke-Patch -NodeCmd $nodeCmd -PatchScript $PatchScript -PatchArgs @($mode, '--profile', $ProfileDir, '--plugin', $PluginDir)
Say $app.Raw
if ($null -eq $app.Json -or -not $app.Json.ok) {
    Bad '应用失败或被拒绝。'
    exit $Rc.Preflight
}
Good '改动已写入并通过回读校验'

# ------------------------------------------------------------ pnpm install ---
if ($mode -eq 'uninstall' -and -not $SkipPnpm) {
    Head 'pnpm install（裁剪已移除的依赖）'
    if (-not $pnpmCmd) {
        Bad '找不到可用的 pnpm。JSON 已改完，可手工在 profile 目录跑 pnpm install。'
        exit $Rc.NoPnpm
    }
    Say ('使用：' + $pnpmCmd.Label)
    $res = Invoke-Cmd -Cmd $pnpmCmd -ExtraArgs @('install') -WorkDir $ProfileDir
    $res.Output | ForEach-Object { Write-Host $_ }
    if ($res.ExitCode -ne 0) {
        Bad ('pnpm install 失败，退出码 ' + $res.ExitCode + '。package.json 已改好；备份在 .bak-modelhub-' + $Stamp + '，必要时手工覆盖回去。')
        exit $Rc.PnpmFailed
    }
    Good 'pnpm install 成功'
    Say ('lockfileVersion : ' + $lockBefore + '  ->  ' + (Get-LockfileVersion $ProfileDir))
} elseif ($SkipPnpm -and $mode -eq 'uninstall') {
    Warn '-SkipPnpm：未跑 pnpm，请稍后手动 pnpm install 以裁剪依赖。'
}

# -------------------------------------------------------------- 回读校验 -----
Head '回读校验'
$rb = Invoke-Patch -NodeCmd $nodeCmd -PatchScript $PatchScript -PatchArgs @('uninstall', '--profile', $ProfileDir, '--plugin', $PluginDir, '--dry-run')
if ($null -ne $rb.Json -and $rb.Json.ok) {
    Say ('再次 DryRun：依赖 = ' + $rb.Json.json.dependencyAction + '，bundles = ' + $rb.Json.json.bundleAction + '   （应为 not-present，即幂等）')
}
$nm = Join-Path $ProfileDir ('node_modules\' + $pluginName)
if (Test-Path -LiteralPath $nm) { Warn ('node_modules\' + $pluginName + ' 仍在（pnpm 未跑或未裁剪），不影响内置 UI 恢复') }
else { Good ('node_modules\' + $pluginName + ' 已不在') }

# ------------------------------------------------------------------ 指引 -----
Head '下一步'
if ($hostInfo.Found) { Say ('当前宿主进程 PID : ' + $hostInfo.Pid) }
if ($mode -eq 'disable') {
    Good '已写入 disabled 覆盖项：内置模型选择器会恢复（没有 HMR 时需要重启桌面端才生效）。'
    Say ('重新打开：pwsh -File ' + $PSCommandPath + ' -EnableOnly')
} elseif ($mode -eq 'enable') {
    Good '已删除 disabled 覆盖项：插件重新打开（没有 HMR 时需要重启桌面端才生效）。'
} else {
    Say '卸载已完成。'
    if (-not $hostInfo.Hmr) { Warn '宿主命令行没有 HMR 开关：内置 UI 要到重启 DSH 桌面端后才完全恢复。' }
    Say '若重启前想立刻恢复内置 UI，更轻的办法是：'
    Say ('  pwsh -File ' + $PSCommandPath + ' -DisableOnly')
}
Say ''
Say '重启会终止用户当前会话，也会终止正在这个桌面端里运行的 Agent 会话。'
Say '本任务纪律：重启前必须先报 lead / 与用户约时间。'
if ($backups.Count -gt 0) {
    Say ''
    Say ('本次备份（.bak-modelhub-' + $Stamp + '）：')
    foreach ($k in $backups.Keys) { Say ('  ' + $k + '  ->  ' + $backups[$k]) }
}
Head '卸载脚本结束'
exit $Rc.Ok
