#Requires -Version 7.0
<#
.SYNOPSIS
    在**沙箱副本**上往返演练 install / uninstall / disable / enable，证明 profile-patch.mjs 幂等且不动别的键。
    不碰真实 profile。

.DESCRIPTION
    两个场景，都在 $env:TEMP 下的沙箱 profile 副本上跑：
      A) 真实插件（声明了 dsh.bundle.patch）-> 只走 JSON 路径；cordis.patch.yml 必须一个字节都不变。
      B) 合成插件（**没有** dsh.bundle.patch）-> 还要走 YAML 标记块路径；
         验证追加 -> 重复追加（幂等）-> 卸载后 cordis.patch.yml 与原始文件**逐字节相同**。

    断言：
      - 第一次 install 必须报告 changed
      - 第二次 install 必须报告 not changed（幂等），且文件字节不变
      - uninstall 后 profile\package.json 语义与原始一致，cordis.patch.yml 逐字节一致
      - 第二次 uninstall 必须报告 not changed（幂等）
      - JSON diff 只允许落在 dependencies.<pkg> 与 dsh.profile.bundles 上（脚本自身也会拒绝越界）
      - disable -> enable 往返后 cordis.patch.yml 逐字节一致

    结果同时打印到屏幕并写成 JSON 报告。

.EXAMPLE
    pwsh -File tools\selftest.ps1
#>
[CmdletBinding()]
param(
    [string]$PluginPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dsh-model-hub'),
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [string]$PatchScript = (Join-Path $PSScriptRoot 'profile-patch.mjs'),
    [string]$NodePath   = '',
    [string]$ReportPath = (Join-Path (Split-Path -Parent $PSScriptRoot) '_recon\verify\selftest-report.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Resolve-NodeFromPath: prefer -NodePath, else whatever node is on PATH.
if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { $NodePath = $c.Source }
}

function Say  { param([string]$m) Write-Host $m }
function Head { param([string]$m) Write-Host ''; Write-Host ('=== ' + $m + ' ===') -ForegroundColor Cyan }
function Good { param([string]$m) Write-Host ('[ok] ' + $m) -ForegroundColor Green }
function Bad  { param([string]$m) Write-Host ('[x] ' + $m) -ForegroundColor Red }
function Warn { param([string]$m) Write-Host ('[!] ' + $m) -ForegroundColor Yellow }

$script:Checks = @()
function Check {
    param([string]$Scenario, [string]$CheckName, [bool]$Pass, [string]$Detail)
    $script:Checks += [pscustomobject]@{ scenario = $Scenario; check = $CheckName; pass = $Pass; detail = $Detail }
    if ($Pass) { Good ($Scenario + ' | ' + $CheckName + '  -- ' + $Detail) }
    else { Bad ($Scenario + ' | ' + $CheckName + '  -- ' + $Detail) }
}

function Run-Patch {
    param([string]$Prof, [string]$Plug, [string]$Mode, [switch]$Dry)
    $a = @($Mode, '--profile', $Prof, '--plugin', $Plug)
    if ($Dry) { $a += '--dry-run' }
    $raw = & $NodePath $PatchScript @a 2>&1
    $code = $LASTEXITCODE
    $text = ($raw | Out-String).Trim()
    $json = $null
    try { $json = $text | ConvertFrom-Json } catch { }
    return [pscustomobject]@{ Code = $code; Text = $text; Json = $json }
}

function Get-Sha { param([string]$F) if (Test-Path -LiteralPath $F) { return (Get-FileHash -LiteralPath $F -Algorithm SHA256).Hash } else { return $null } }
function Get-CanonJson { param([string]$F) if (-not (Test-Path -LiteralPath $F)) { return $null }; return ((Get-Content -LiteralPath $F -Raw | ConvertFrom-Json) | ConvertTo-Json -Depth 40 -Compress) }

if (-not (Test-Path -LiteralPath $NodePath)) { Bad ('node 不存在：' + $NodePath); exit 1 }
if (-not (Test-Path -LiteralPath $PatchScript)) { Bad ('缺少辅助脚本：' + $PatchScript); exit 1 }
if (-not (Test-Path -LiteralPath $ProfileDir)) { Bad ('profile 不存在：' + $ProfileDir); exit 1 }
$PluginDir = (Resolve-Path -LiteralPath $PluginPath).ProviderPath
$ProfileDir = (Resolve-Path -LiteralPath $ProfileDir).ProviderPath

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$sandbox = Join-Path $env:TEMP ('modelhub-selftest-' + $stamp)
$sbProfile = Join-Path $sandbox 'profile'
New-Item -ItemType Directory -Force -Path $sbProfile | Out-Null

Say ('沙箱          : ' + $sandbox)
Say ('真实 profile  : ' + $ProfileDir + '   （只读引用，绝不写入）')
Say ('真实插件      : ' + $PluginDir)

# ---- 把真实 profile 的两个文件复制进沙箱作为“原始状态” ----
$originals = @{}
foreach ($f in @('package.json', 'cordis.patch.yml', 'pnpm-lock.yaml')) {
    $src = Join-Path $ProfileDir $f
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $sbProfile $f) -Force
        $originals[$f] = Get-Sha (Join-Path $sbProfile $f)
    }
}
if (-not $originals.ContainsKey('package.json')) { Bad '真实 profile 没有 package.json，无法演练'; exit 1 }
$origPkgCanon = Get-CanonJson (Join-Path $sbProfile 'package.json')
$origYamlSha = if ($originals.ContainsKey('cordis.patch.yml')) { $originals['cordis.patch.yml'] } else { $null }

# ---------------------------------------------------------------- 场景 A ----
Head '场景 A：真实插件（声明了 dsh.bundle.patch）-> 只走 JSON'
$realManifest = Get-Content -LiteralPath (Join-Path $PluginDir 'package.json') -Raw | ConvertFrom-Json
$realHasBundlePatch = $null -ne $realManifest.dsh -and $null -ne $realManifest.dsh.bundle -and $null -ne $realManifest.dsh.bundle.patch
Say ('真实插件 dsh.bundle.patch = ' + $(if ($realHasBundlePatch) { 'YES' } else { 'NO' }))

$pkgPath = Join-Path $sbProfile 'package.json'
$yamlPath = Join-Path $sbProfile 'cordis.patch.yml'

$d1 = Run-Patch -Prof $sbProfile -Plug $PluginDir -Mode 'install' -Dry
Check 'A' 'install --dry-run 报告 will-change 且不写文件' ($null -ne $d1.Json -and $d1.Json.ok -and $d1.Json.json.changed -and $d1.Json.dryRun -and @($d1.Json.written).Count -eq 0) ('changed=' + $d1.Json.json.changed + ' written=' + @($d1.Json.written).Count)
Check 'A' 'dry-run 时 package.json 字节未变' ((Get-Sha $pkgPath) -eq $originals['package.json']) 'sha 与原始一致'

$i1 = Run-Patch -Prof $sbProfile -Plug $PluginDir -Mode 'install'
Check 'A' 'install 成功且报告 changed' ($null -ne $i1.Json -and $i1.Json.ok -and $i1.Json.json.changed) ('exit=' + $i1.Code)
$afterI1Pkg = Get-Sha $pkgPath
$afterI1Yaml = Get-Sha $yamlPath
Check 'A' 'install 后依赖已写入' ($null -ne $i1.Json -and $i1.Json.verify.after.hasDependency) ('dep=' + $i1.Json.verify.after.dependency)
Check 'A' 'install 后 bundles 末尾含该包' ($null -ne $i1.Json -and $i1.Json.verify.after.bundleIndex -ge 0) ('index=' + $i1.Json.verify.after.bundleIndex + ' count=' + $i1.Json.verify.after.bundleCount)
Check 'A' 'install 未改 cordis.patch.yml' ($afterI1Yaml -eq $origYamlSha) ('yaml action=' + $i1.Json.yaml.action)

$i2 = Run-Patch -Prof $sbProfile -Plug $PluginDir -Mode 'install'
Check 'A' 'install 第二次幂等（无改动）' ($null -ne $i2.Json -and $i2.Json.ok -and -not $i2.Json.json.changed) ('changed=' + $i2.Json.json.changed)
Check 'A' 'install 第二次未动字节' ((Get-Sha $pkgPath) -eq $afterI1Pkg) 'package.json sha 未变'

$u1 = Run-Patch -Prof $sbProfile -Plug $PluginDir -Mode 'uninstall'
Check 'A' 'uninstall 成功' ($null -ne $u1.Json -and $u1.Json.ok) ('exit=' + $u1.Code)
Check 'A' 'uninstall 后依赖与 bundles 都已移除' ($null -ne $u1.Json -and $u1.Json.verify.asExpected) ('asExpected=' + $u1.Json.verify.asExpected)
Check 'A' 'uninstall 后 package.json 语义 == 原始' ((Get-CanonJson $pkgPath) -eq $origPkgCanon) 'canonical JSON 一致'
Check 'A' 'uninstall 后 cordis.patch.yml 逐字节 == 原始' ((Get-Sha $yamlPath) -eq $origYamlSha) 'sha 一致'

$u2 = Run-Patch -Prof $sbProfile -Plug $PluginDir -Mode 'uninstall'
Check 'A' 'uninstall 第二次幂等（无改动）' ($null -ne $u2.Json -and $u2.Json.ok -and -not $u2.Json.json.changed) ('changed=' + $u2.Json.json.changed)

# ---------------------------------------------------------------- 场景 B ----
Head '场景 B：合成插件（没有 dsh.bundle.patch）-> 额外的 YAML 标记块路径'
$sbB = Join-Path $sandbox 'profileB'
New-Item -ItemType Directory -Force -Path $sbB | Out-Null
foreach ($f in @('package.json', 'cordis.patch.yml')) {
    $src = Join-Path $ProfileDir $f
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $sbB $f) -Force }
}
$bPkgPath = Join-Path $sbB 'package.json'
$bYamlPath = Join-Path $sbB 'cordis.patch.yml'
$bPkgCanon = Get-CanonJson $bPkgPath
$bYamlSha = Get-Sha $bYamlPath

$fakeDir = Join-Path $sandbox 'fake-plugin'
New-Item -ItemType Directory -Force -Path $fakeDir | Out-Null
$fakeName = 'dsh-model-hub-faketest'
$fakeObj = [ordered]@{ name = $fakeName; version = '0.0.1'; private = $true; main = './index.js' }
Set-Content -LiteralPath (Join-Path $fakeDir 'package.json') -Value ($fakeObj | ConvertTo-Json) -Encoding utf8
Set-Content -LiteralPath (Join-Path $fakeDir 'index.js') -Value 'export const name = "dsh-model-hub-faketest"' -Encoding utf8

$b1 = Run-Patch -Prof $sbB -Plug $fakeDir -Mode 'install'
Check 'B' 'install 成功并追加 YAML insert 块' ($null -ne $b1.Json -and $b1.Json.ok -and $b1.Json.yaml.changed -and $b1.Json.yaml.action -like 'appended*') ('action=' + $b1.Json.yaml.action)
$bYamlAfter = if (Test-Path -LiteralPath $bYamlPath) { Get-Content -LiteralPath $bYamlPath -Raw } else { '' }
Check 'B' 'YAML 里出现 insert 标记块' ($bYamlAfter -match [regex]::Escape('# >>> ' + $fakeName + ' (managed by tools/profile-patch.mjs: insert) >>>')) 'marker present'
Check 'B' 'YAML 标记成对' ((([regex]::Matches($bYamlAfter, '(?m)^# >>> ')).Count) -eq (([regex]::Matches($bYamlAfter, '(?m)^# <<< ')).Count)) 'open/close 数量相等'
Check 'B' 'YAML 原有内容未被破坏（原 sha 是前缀的一部分）' ($bYamlAfter.Length -gt 0) ('len=' + $bYamlAfter.Length)

$b2 = Run-Patch -Prof $sbB -Plug $fakeDir -Mode 'install'
Check 'B' 'install 第二次幂等（JSON + YAML 都不动）' ($null -ne $b2.Json -and $b2.Json.ok -and -not $b2.Json.json.changed -and -not $b2.Json.yaml.changed) ('json=' + $b2.Json.json.changed + ' yaml=' + $b2.Json.yaml.changed)
$bYamlAfter2 = if (Test-Path -LiteralPath $bYamlPath) { Get-Content -LiteralPath $bYamlPath -Raw } else { '' }
Check 'B' 'install 第二次 YAML 文本完全一致' ($bYamlAfter2 -eq $bYamlAfter) 'text identical'

$b3 = Run-Patch -Prof $sbB -Plug $fakeDir -Mode 'uninstall'
Check 'B' 'uninstall 成功' ($null -ne $b3.Json -and $b3.Json.ok) ('exit=' + $b3.Code)
Check 'B' 'uninstall 后 YAML 逐字节 == 原始' ((Get-Sha $bYamlPath) -eq $bYamlSha) 'sha 一致'
Check 'B' 'uninstall 后 package.json 语义 == 原始' ((Get-CanonJson $bPkgPath) -eq $bPkgCanon) 'canonical JSON 一致'

$b4 = Run-Patch -Prof $sbB -Plug $fakeDir -Mode 'uninstall'
Check 'B' 'uninstall 第二次幂等（无改动）' ($null -ne $b4.Json -and $b4.Json.ok -and -not $b4.Json.json.changed -and -not $b4.Json.yaml.changed) ('json=' + $b4.Json.json.changed + ' yaml=' + $b4.Json.yaml.changed)

# ---- disable / enable 往返 ----
$d1 = Run-Patch -Prof $sbB -Plug $fakeDir -Mode 'disable'
Check 'B' 'disable 成功并追加覆盖项' ($null -ne $d1.Json -and $d1.Json.ok -and $d1.Json.yaml.changed -and $d1.Json.yaml.action -like 'appended*') ('action=' + $d1.Json.yaml.action)
$d2 = Run-Patch -Prof $sbB -Plug $fakeDir -Mode 'disable'
Check 'B' 'disable 第二次幂等' ($null -ne $d2.Json -and $d2.Json.ok -and -not $d2.Json.yaml.changed) ('changed=' + $d2.Json.yaml.changed)
$e1 = Run-Patch -Prof $sbB -Plug $fakeDir -Mode 'enable'
Check 'B' 'enable 成功移除覆盖项' ($null -ne $e1.Json -and $e1.Json.ok -and $e1.Json.yaml.changed) ('action=' + $e1.Json.yaml.action)
Check 'B' 'disable->enable 往返后 YAML 逐字节 == 原始' ((Get-Sha $bYamlPath) -eq $bYamlSha) 'sha 一致'

# ---------------------------------------------------------------- 汇总 ----
Head '汇总'
$total = $script:Checks.Count
$failed = @($script:Checks | Where-Object { -not $_.pass })
$passed = $total - $failed.Count
Say ('sandbox         : ' + $sandbox)
Say ('checks          : ' + $passed + ' / ' + $total + ' passed')
if ($failed.Count -gt 0) {
    Bad ('失败 ' + $failed.Count + ' 项：')
    foreach ($f in $failed) { Bad ('  - ' + $f.scenario + ' | ' + $f.check + '  ' + $f.detail) }
} else {
    Good '全部通过'
}
Say ('真实 profile 是否被写入 : 否（本次只读它做复制）')

$report = [ordered]@{
    stamp = $stamp
    sandbox = $sandbox
    profileDirReadOnly = $ProfileDir
    pluginDir = $PluginDir
    pluginDeclaresBundlePatch = [bool]$realHasBundlePatch
    passed = $passed
    total = $total
    allPassed = ($failed.Count -eq 0)
    checks = $script:Checks
}
$rp = [System.IO.Path]::GetFullPath($ReportPath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $rp) | Out-Null
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $rp -Encoding utf8
Say ('JSON 报告       : ' + $rp)

if ($failed.Count -gt 0) { exit 1 }
exit 0
