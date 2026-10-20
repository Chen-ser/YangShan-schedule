#requires -version 5
param(
  [string]$Destination = '',
  [switch]$Force
)

<#
  Install the local toolchain used by the Android and Windows shell builds.
  Nothing is installed system-wide:
    - Temurin JDK 17 -> D:\codex工作区\build-deps\jdk-17
    - .NET SDK 10    -> shells\windows\.dotnet
#>

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$workspaceRoot = Split-Path (Split-Path $repo -Parent) -Parent
$codexFolder = [string]::Concat(
  'codex',
  [char]0x5de5,
  [char]0x4f5c,
  [char]0x533a
)
if ([string]::IsNullOrWhiteSpace($Destination)) {
  $Destination = Join-Path (Join-Path $workspaceRoot $codexFolder) 'build-deps'
}
$jdkDir = Join-Path $Destination 'jdk-17'
$dotnetDir = Join-Path $repo 'shells\windows\.dotnet'
$jdkZip = Join-Path $Destination 'temurin-jdk17.zip'
$dotnetInstaller = Join-Path $Destination 'dotnet-install.ps1'

New-Item -ItemType Directory -Force -Path $Destination | Out-Null

if ($Force -and (Test-Path -LiteralPath $jdkDir)) {
  Remove-Item -LiteralPath $jdkDir -Recurse -Force
}

if (-not (Test-Path -LiteralPath (Join-Path $jdkDir 'bin\java.exe'))) {
  Write-Host 'Downloading Temurin JDK 17...'
  & curl.exe -L --fail --retry 3 --connect-timeout 30 `
    'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk' `
    -o $jdkZip
  if ($LASTEXITCODE -ne 0) { throw "JDK download failed with exit code $LASTEXITCODE" }
  $tmp = Join-Path $Destination 'jdk-extract'
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
  Expand-Archive -LiteralPath $jdkZip -DestinationPath $tmp -Force
  $root = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
  if (-not $root) { throw 'JDK archive did not contain a top-level directory.' }
  New-Item -ItemType Directory -Force -Path $jdkDir | Out-Null
  Get-ChildItem -LiteralPath $root.FullName -Force | Move-Item -Destination $jdkDir -Force
  Remove-Item -LiteralPath $tmp -Recurse -Force
}

if ($Force -and (Test-Path -LiteralPath $dotnetDir)) {
  Remove-Item -LiteralPath $dotnetDir -Recurse -Force
}

if (-not (Test-Path -LiteralPath (Join-Path $dotnetDir 'dotnet.exe'))) {
  Write-Host 'Downloading .NET SDK 10...'
  & curl.exe -L --fail --retry 3 --connect-timeout 30 'https://dot.net/v1/dotnet-install.ps1' -o $dotnetInstaller
  if ($LASTEXITCODE -ne 0) { throw "dotnet installer download failed with exit code $LASTEXITCODE" }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $dotnetInstaller `
    -Channel 10.0 -Quality GA -InstallDir $dotnetDir -NoPath
  if ($LASTEXITCODE -ne 0) { throw ".NET SDK installation failed with exit code $LASTEXITCODE" }
}

Write-Host "JDK  : $(Join-Path $jdkDir 'bin\java.exe')"
Write-Host "dotnet: $(Join-Path $dotnetDir 'dotnet.exe')"
