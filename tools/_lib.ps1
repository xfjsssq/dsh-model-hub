# tools/_lib.ps1 -- install.ps1 / uninstall.ps1 共用的辅助函数。
# 用法（在脚本里）：  . "$PSScriptRoot\_lib.ps1"
#
# 设计约束（Lead 要求）：
#   * **不写死盘符/安装路径**：DSH 根目录从"正在运行的桌面端进程"推导；node 从 PATH 推导；
#     pnpm 优先用 DSH 自带 runtime 的那一份（与 DSH 自己维护 node_modules/lockfile 的版本一致）。
#   * 所有函数都不产生"看起来成功"的假象：拿不到就返回 $null / 明确 Warn。

Set-StrictMode -Version Latest

function Say  { param([string]$m) Write-Host $m }
function Head { param([string]$m) Write-Host ''; Write-Host ('=== ' + $m + ' ===') -ForegroundColor Cyan }
function Good { param([string]$m) Write-Host ('[ok] ' + $m) -ForegroundColor Green }
function Warn { param([string]$m) Write-Host ('[!] ' + $m) -ForegroundColor Yellow }
function Bad  { param([string]$m) Write-Host ('[x] ' + $m) -ForegroundColor Red }

# ---------------------------------------------------------------- 命令描述对象 --
function New-Cmd {
    param([string]$Exe, [string[]]$CmdArgs, [hashtable]$Env, [string]$Label)
    return [pscustomobject]@{
        Exe   = $Exe
        Args  = @($CmdArgs)
        Env   = if ($Env) { $Env } else { @{} }
        Label = $Label
    }
}

function Test-Cmd {
    param([object]$Cmd)
    if (-not $Cmd) { return $false }
    return [bool](Test-Path -LiteralPath $Cmd.Exe)
}

function Invoke-Cmd {
    param([object]$Cmd, [string[]]$ExtraArgs, [string]$WorkDir)
    if (-not (Test-Cmd $Cmd)) { return [pscustomobject]@{ ExitCode = -1; Output = @('command not found: ' + $Cmd.Exe) } }
    $saved = @{}
    foreach ($k in $Cmd.Env.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k)
        [Environment]::SetEnvironmentVariable($k, [string]$Cmd.Env[$k])
    }
    $here = (Get-Location).Path
    try {
        if ($WorkDir) { Set-Location -LiteralPath $WorkDir }
        $allArgs = @($Cmd.Args) + @($ExtraArgs)
        $out = & $Cmd.Exe @allArgs 2>&1
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
        return [pscustomobject]@{ ExitCode = $code; Output = @($out) }
    } finally {
        Set-Location -LiteralPath $here
        foreach ($k in $Cmd.Env.Keys) {
            if ($saved.ContainsKey($k) -and $null -ne $saved[$k]) {
                [Environment]::SetEnvironmentVariable($k, [string]$saved[$k])
            } else {
                [Environment]::SetEnvironmentVariable($k, $null)
            }
        }
    }
}

# ------------------------------------------------- 运行中的 DSH 桌面端宿主信息 --
function Get-DshHostInfo {
    $info = [pscustomobject]@{
        Found        = $false
        Pid          = $null
        Exe          = $null
        Root         = $null
        PnpmCjs      = $null
        NodeExe      = $null
        Hmr          = $false
        ProfileArg   = $null
        CommandLine  = $null
    }
    $candidates = @()
    try {
        $candidates = @(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%dsh-desktop-host%'" -ErrorAction SilentlyContinue)
    } catch { $candidates = @() }
    if ($candidates.Count -eq 0) {
        try {
            $candidates = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -and $_.CommandLine.Contains('dsh-desktop-host') })
        } catch { $candidates = @() }
    }
    if ($candidates.Count -eq 0) { return $info }

    $p = $candidates | Select-Object -First 1
    $info.Found = $true
    $info.Pid = [int]$p.ProcessId
    $info.CommandLine = [string]$p.CommandLine
    if ($info.CommandLine -match '--hmr') { $info.Hmr = $true }
    if ($info.CommandLine -match '([A-Za-z]:\\[^"]*?\\profiles\\[^"\s]+)') { $info.ProfileArg = $Matches[1] }
    $info.Exe = $p.ExecutablePath
    if ($info.Exe -and (Test-Path -LiteralPath $info.Exe)) {
        $info.NodeExe = $info.Exe
        $info.Root = Split-Path -Parent $info.Exe
        $cand = Join-Path $info.Root 'resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
        if (Test-Path -LiteralPath $cand) { $info.PnpmCjs = $cand }
    }
    return $info
}

# ------------------------------------------------------------------- node ------
function Resolve-NodeCommand {
    param([string]$Preferred, [object]$HostInfo)
    if ($Preferred) {
        if (Test-Path -LiteralPath $Preferred) { return (New-Cmd -Exe $Preferred -CmdArgs @() -Env @{} -Label $Preferred) }
        Warn ('-NodePath 不存在，忽略：' + $Preferred)
    }
    $onPath = Get-Command -Name 'node' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { return (New-Cmd -Exe $onPath.Source -CmdArgs @() -Env @{} -Label ($onPath.Source + '  (PATH)')) }
    if ($HostInfo -and $HostInfo.NodeExe) {
        return (New-Cmd -Exe $HostInfo.NodeExe -CmdArgs @() -Env @{ ELECTRON_RUN_AS_NODE = '1' } -Label ($HostInfo.NodeExe + '  [Electron-as-node]'))
    }
    return $null
}

# ------------------------------------------------------------------- pnpm ------
function Resolve-GlobalPnpm {
    param([string]$Preferred, [object]$NodeCmd)
    if ($Preferred) {
        if (Test-Path -LiteralPath $Preferred) {
            if ($Preferred -match '\.(cjs|mjs|js)$') {
                $node = if ($NodeCmd) { $NodeCmd } else { Resolve-NodeCommand -Preferred '' -HostInfo $null }
                if ($node) { return (New-Cmd -Exe $node.Exe -CmdArgs (@($node.Args) + @($Preferred)) -Env $node.Env -Label ($node.Label + ' ' + $Preferred)) }
            } else {
                return (New-Cmd -Exe $Preferred -CmdArgs @() -Env @{} -Label $Preferred)
            }
        } else {
            Warn ('-PnpmPath 不存在，改为自动探测：' + $Preferred)
        }
    }
    $onPath = Get-Command -Name 'pnpm' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { return (New-Cmd -Exe $onPath.Source -CmdArgs @() -Env @{} -Label ($onPath.Source + '  (PATH)')) }
    if ($NodeCmd) {
        $nodeDir = Split-Path -Parent $NodeCmd.Exe
        foreach ($rel in @('node_modules\pnpm\bin\pnpm.cjs', '..\node_modules\pnpm\bin\pnpm.cjs')) {
            $cjs = Join-Path $nodeDir $rel
            if (Test-Path -LiteralPath $cjs) {
                return (New-Cmd -Exe $NodeCmd.Exe -CmdArgs (@($NodeCmd.Args) + @($cjs)) -Env $NodeCmd.Env -Label ($NodeCmd.Exe + ' ' + $cjs))
            }
        }
    }
    return $null
}

function Resolve-PnpmCommand {
    param([ValidateSet('bundled', 'global', 'auto')][string]$Mode, [string]$Preferred, [object]$HostInfo, [string]$DshDesktopRoot, [object]$NodeCmd)

    $bundled = $null
    if ($Mode -ne 'global') {
        $cjs = $null
        $exe = $null
        if ($HostInfo -and $HostInfo.PnpmCjs) { $cjs = $HostInfo.PnpmCjs; $exe = $HostInfo.Exe }
        if (-not $cjs -and $DshDesktopRoot) {
            $c = Join-Path $DshDesktopRoot 'resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
            if (Test-Path -LiteralPath $c) { $cjs = $c }
            if (-not $exe) {
                $e = Get-ChildItem -LiteralPath $DshDesktopRoot -Filter '*.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($e) { $exe = $e.FullName }
            }
        }
        if ($cjs -and $exe) {
            $bundled = New-Cmd -Exe $exe -CmdArgs @('--expose-internals', $cjs) -Env @{ ELECTRON_RUN_AS_NODE = '1' } -Label ($exe + ' --expose-internals ' + $cjs + '   [DSH bundled pnpm]')
        }
    }

    $global = Resolve-GlobalPnpm -Preferred $Preferred -NodeCmd $NodeCmd

    if ($Mode -eq 'bundled') {
        if ($bundled) { return $bundled }
        if ($global) { Warn ('DSH 自带 pnpm 不可用，回退到：' + $global.Label); return $global }
        return $null
    }
    if ($Mode -eq 'global') {
        if ($global) { return $global }
        if ($bundled) { Warn ('全局 pnpm 不可用，回退到：' + $bundled.Label); return $bundled }
        return $null
    }
    if ($bundled) { return $bundled }
    return $global
}

# ---------------------------------------------------------------- profile -----
function Get-LockfileVersion {
    param([string]$Dir)
    $lf = Join-Path $Dir 'pnpm-lock.yaml'
    if (-not (Test-Path -LiteralPath $lf)) { return '(no lockfile)' }
    $line = Select-String -LiteralPath $lf -Pattern '^lockfileVersion:' | Select-Object -First 1
    if ($line) { return ($line.Line -replace '^lockfileVersion:\s*', '').Trim() }
    return '(unknown)'
}

function Backup-ProfileFiles {
    param([string]$ProfileDir, [string]$Stamp, [string[]]$Files, [switch]$NoBackup)
    $backups = @{}
    if ($NoBackup) { Warn '-NoBackup：未做备份（不推荐）'; return $backups }
    Head ('备份 -> .bak-modelhub-' + $Stamp)
    foreach ($f in $Files) {
        $src = Join-Path $ProfileDir $f
        if (-not (Test-Path -LiteralPath $src)) { Warn ($f + ' 不存在，跳过'); continue }
        $dest = $src + '.bak-modelhub-' + $Stamp
        $n = 1
        while (Test-Path -LiteralPath $dest) { $dest = $src + '.bak-modelhub-' + $Stamp + '-' + $n; $n++ }
        Copy-Item -LiteralPath $src -Destination $dest -Force
        $backups[$f] = $dest
        Good ($f + '  ->  ' + (Split-Path -Leaf $dest))
    }
    return $backups
}

function Restore-Profile {
    param([hashtable]$Backups, [string]$ProfileDir)
    $done = @()
    foreach ($k in $Backups.Keys) {
        Copy-Item -LiteralPath $Backups[$k] -Destination (Join-Path $ProfileDir $k) -Force
        $done += $k
    }
    return $done
}

# --------------------------------------------------- profile-patch.mjs 调用 --
function Invoke-Patch {
    param([object]$NodeCmd, [string]$PatchScript, [string[]]$PatchArgs)
    $res = Invoke-Cmd -Cmd $NodeCmd -ExtraArgs (@($PatchScript) + @($PatchArgs)) -WorkDir $null
    $text = (($res.Output) | Out-String).Trim()
    $json = $null
    try { $json = $text | ConvertFrom-Json } catch { }
    return [pscustomobject]@{ ExitCode = $res.ExitCode; Raw = $text; Json = $json }
}
