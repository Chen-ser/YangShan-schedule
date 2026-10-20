#requires -version 5
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = (Resolve-Path (Join-Path $here '..\..')).Path
$workspace = Split-Path $repo -Parent
$codexFolder = [string]::Concat('codex', [char]0x5de5, [char]0x4f5c, [char]0x533a)
$deps = Join-Path (Join-Path (Split-Path $workspace -Parent) $codexFolder) 'build-deps'
$deps = (Resolve-Path $deps).Path
$jdk = Join-Path $deps 'jdk-17'
$gradle = 'D:\ds工作区\_android\gradle-8.11.1\bin\gradle.bat'

if (-not (Test-Path -LiteralPath (Join-Path $jdk 'bin\java.exe'))) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'tools\install-build-deps.ps1')
}
if (-not (Test-Path -LiteralPath $gradle)) {
  throw "Gradle not found at $gradle. Install Gradle 8.11.1 before building."
}

$env:JAVA_HOME = $jdk
$env:GRADLE_USER_HOME = Join-Path $here '.gradle-build-home'
$env:ANDROID_USER_HOME = Join-Path $here '.android-build-home'
$env:GRADLE_OPTS = '-Dfile.encoding=UTF-8'

node (Join-Path $here 'tools\prepare-assets.mjs')
& $gradle --no-watch-fs --no-daemon `
  '-Pkotlin.compiler.execution.strategy=in-process' `
  '-Pandroid.aapt2FromMavenOverride=C:\Program Files (x86)\Android\android-sdk\build-tools\36.0.0\aapt2.exe' `
  assembleDebug
if ($LASTEXITCODE -ne 0) { throw "Android build failed with exit code $LASTEXITCODE" }

Write-Host "APK: $(Join-Path $here 'app\build\outputs\apk\debug\app-debug.apk')"
