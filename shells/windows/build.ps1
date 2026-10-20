#requires -version 5
<#
  仰山课表 · Windows 壳 构建脚本

  做的事（按顺序）：
    1. node web/build.mjs          生成 dist 下的课表内核（单文件 HTML）
    2. node tools/fetch-nupkg.mjs  把 WebView2 的 .nupkg 下到 feed/（离线用）
    3. dotnet build -c Release     编译，内核作为嵌入式资源打进 exe
    4. 把可运行的那一堆文件复制到 out/

  这个文件刻意只用 ASCII：#requires -version 5 的 PowerShell 读 .ps1 时，
  没有 BOM 的文件会按系统 ANSI 代码页解码，中文字面量会变乱码。

  用法：powershell -ExecutionPolicy Bypass -File build.ps1
#>

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = (Resolve-Path (Join-Path $here '..\..')).Path
$out  = Join-Path $here 'out'

function Step($n, $text) { Write-Host ""; Write-Host "[$n] $text" -ForegroundColor Cyan }
function Find-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @(
        'C:\Program Files\nodejs\node.exe',
        'C:\Program Files (x86)\nodejs\node.exe',
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if (Test-Path $p) { return $p }
    }
    throw 'node.exe not found. Install Node.js 22+ first.'
}

$node = Find-Node
Write-Host "node : $node"
Write-Host "repo : $repo"

$localDotnet = Join-Path $here '.dotnet\dotnet.exe'
$dotnet = if (Test-Path -LiteralPath $localDotnet) { $localDotnet } else { 'dotnet' }
if ($dotnet -eq 'dotnet' -and -not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  throw 'dotnet.exe not found. Run ..\..\tools\install-build-deps.ps1 first.'
}
Write-Host "dotnet: $dotnet"

# ---- 1. web build -----------------------------------------------------------
Step 1 'building the schedule core (web/build.mjs)'
Push-Location $repo
try {
    & $node 'web/build.mjs'
    if ($LASTEXITCODE -ne 0) { throw "web/build.mjs failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

$coreHtml = Get-ChildItem -Path (Join-Path $repo 'dist') -Filter '*.html' -File -ErrorAction SilentlyContinue
if (-not $coreHtml) { throw 'dist does not contain the single-file schedule core.' }
Write-Host ("core : {0} ({1:N0} KB)" -f $coreHtml[0].Name, ($coreHtml[0].Length / 1KB))

# ---- 2. offline nuget feed --------------------------------------------------
Step 2 'fetching the WebView2 package into feed/'
Push-Location $here
try {
    & $node 'tools/fetch-nupkg.mjs'
    if ($LASTEXITCODE -ne 0) { throw "fetch-nupkg.mjs failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

# ---- 3. compile -------------------------------------------------------------
# The sandbox denies writes to the default %USERPROFILE%\.dotnet and the default
# NuGet cache, so keep both inside this directory.
Step 3 'compiling'
$env:DOTNET_CLI_HOME = Join-Path $here '.dotnet'
$env:NUGET_PACKAGES  = Join-Path $here '.nuget'
$env:NUGET_SCRATCH   = Join-Path $here '.nuget-scratch'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'

Push-Location $here
try {
    & $dotnet build -c Release --nologo
    if ($LASTEXITCODE -ne 0) { throw "dotnet build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

# ---- 4. collect -------------------------------------------------------------
Step 4 'collecting runnable files into out/'
$bin = Join-Path $here 'bin\Release\net10.0-windows'
if (-not (Test-Path $bin)) { throw "build output not found: $bin" }

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null
# selfcheck.txt / uitest*.txt / crash.log are produced by running the shell in place,
# not build artifacts -- keep them out of the shipped folder.
Get-ChildItem -Path (Join-Path $bin '*') -Exclude 'selfcheck.txt', 'crash.log', 'uitest*.txt' |
  Copy-Item -Destination $out -Recurse -Force

$exe = Join-Path $out 'YangShanShell.exe'
$size = (Get-Item $exe).Length
Write-Host ""
Write-Host ("OK  {0}  ({1:N0} KB, core embedded)" -f $exe, ($size / 1KB)) -ForegroundColor Green
Write-Host "Double-click it, or right-click the tray icon for auto-refresh settings."
