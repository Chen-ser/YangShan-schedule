#requires -version 5
<#
  YangShan Schedule - Windows shell installer (per-user, no admin needed)

  What it does:
    1. copies the built program (out/ or bin/Release/net10.0-windows) to
       %LOCALAPPDATA%\Programs\YangShanSchedule
    2. creates a Desktop shortcut and a Start Menu shortcut
    3. writes an uninstall entry under HKCU so it shows up in
       "Apps & features" / "Add or remove programs"
    4. optionally launches it

  Program dir  : %LOCALAPPDATA%\Programs\YangShanSchedule
  Data dir     : %LOCALAPPDATA%\YangShanSchedule   (kept by the uninstaller)

  This file is deliberately ASCII-only: Windows PowerShell 5.1 decodes a
  .ps1 without BOM using the system ANSI code page, which turns any literal
  non-ASCII text into mojibake. Chinese display names are therefore built
  from code points (see $AppName below).

  Usage:
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -NoLaunch
    powershell -ExecutionPolicy Bypass -File install.ps1 -Source <dir>
#>
[CmdletBinding()]
param(
    # Where the built program lives. Defaults to .\out, then bin\Release\net10.0-windows.
    [string]$Source,
    # Do not start the app after installing.
    [switch]$NoLaunch,
    # Do not create the Desktop shortcut.
    [switch]$NoDesktopShortcut
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---- names ------------------------------------------------------------------
# Yang Shan Ke Biao  (the app name, assembled from code points to stay ASCII)
$AppName    = [string]([char]0x4EF0 + [char]0x5C71 + [char]0x8BFE + [char]0x8868)
$AppDesc    = $AppName + ' - Beijing Information Science and Technology University class schedule'
$Publisher  = 'YangShan Schedule'
$Version    = '0.1.12'
$RegKey     = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\YangShanSchedule'

function Step($n, $text) { Write-Host ''; Write-Host "[$n] $text" -ForegroundColor Cyan }
function Ok($text)       { Write-Host "    $text" -ForegroundColor Green }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = (Resolve-Path (Join-Path $here '..\..')).Path

# ---- locate the built program ----------------------------------------------
function Resolve-SourceDir {
    param([string]$Explicit)
    $cands = New-Object System.Collections.Generic.List[string]
    if ($Explicit) { $cands.Add($Explicit) }
    $cands.Add((Join-Path $here 'out'))
    $cands.Add((Join-Path $here 'bin\Release\net10.0-windows'))
    foreach ($c in $cands) {
        $exe = Join-Path $c 'YangShanShell.exe'
        if ((Test-Path $c) -and (Test-Path $exe)) { return (Resolve-Path $c).Path }
    }
    throw "YangShanShell.exe not found. Run build.ps1 first, or pass -Source <dir>."
}

$src = Resolve-SourceDir -Explicit $Source
Write-Host "source : $src"

# ---- install dir ------------------------------------------------------------
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\YangShanSchedule'
$dataDir    = Join-Path $env:LOCALAPPDATA 'YangShanSchedule'

Step 1 "installing to $installDir"
if (Test-Path $installDir) {
    # Keep it simple and predictable: wipe and re-copy.
    Remove-Item $installDir -Recurse -Force
}
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Get-ChildItem -Path (Join-Path $src '*') -Exclude 'selfcheck.txt', 'crash.log', 'uitest*.txt' |
    Copy-Item -Destination $installDir -Recurse -Force

$exe = Join-Path $installDir 'YangShanShell.exe'
if (-not (Test-Path $exe)) { throw "copy failed, $exe is missing" }
$sizeKb = [int](((Get-ChildItem $installDir -Recurse -File | Measure-Object -Property Length -Sum).Sum) / 1KB)
Ok ("YangShanShell.exe {0:N1} MB, {1:N0} KB total" -f ((Get-Item $exe).Length / 1MB), $sizeKb)

# A per-user program dir is not on PATH, so adb-style side files are irrelevant
# here; the app only needs its own directory.

# ---- shortcuts --------------------------------------------------------------
Step 2 'creating shortcuts'
$ws = New-Object -ComObject WScript.Shell

function New-Shortcut {
    param([string]$LinkPath)
    $dir = Split-Path -Parent $LinkPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $lnk = $ws.CreateShortcut($LinkPath)
    $lnk.TargetPath       = $exe
    $lnk.WorkingDirectory = $installDir
    $lnk.IconLocation     = "$exe,0"
    $lnk.Description      = $AppDesc
    $lnk.Save()
    Ok $LinkPath
}

$startMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) $AppName
New-Shortcut (Join-Path $startMenuDir ($AppName + '.lnk'))

$desktopLink = $null
if (-not $NoDesktopShortcut) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $desktopLink = Join-Path $desktop ($AppName + '.lnk')
    New-Shortcut $desktopLink
}

# Uninstaller goes next to the program so the registry entry can point at it.
$uninstaller = Join-Path $installDir 'uninstall.ps1'
Copy-Item (Join-Path $here 'uninstall.ps1') $uninstaller -Force
Ok $uninstaller

# ---- uninstall entry --------------------------------------------------------
Step 3 'writing the uninstall entry'
$uninstallCmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $uninstaller + '"'
if (-not (Test-Path $RegKey)) { New-Item -Path $RegKey -Force | Out-Null }
New-ItemProperty -Path $RegKey -Name 'DisplayName'     -Value $AppName      -PropertyType String -Force | Out-Null
New-ItemProperty -Path $RegKey -Name 'DisplayVersion'  -Value $Version      -PropertyType String -Force | Out-Null
New-ItemProperty -Path $RegKey -Name 'Publisher'       -Value $Publisher    -PropertyType String -Force | Out-Null
New-ItemProperty -Path $RegKey -Name 'DisplayIcon'     -Value $exe          -PropertyType String -Force | Out-Null
New-ItemProperty -Path $RegKey -Name 'InstallLocation' -Value $installDir   -PropertyType String -Force | Out-Null
New-ItemProperty -Path $RegKey -Name 'UninstallString' -Value $uninstallCmd -PropertyType String -Force | Out-Null
New-ItemProperty -Path $RegKey -Name 'QuietUninstallString' -Value ($uninstallCmd + ' -Quiet') -PropertyType String -Force | Out-Null
New-ItemProperty -Path $RegKey -Name 'EstimatedSize'   -Value $sizeKb       -PropertyType DWord  -Force | Out-Null
New-ItemProperty -Path $RegKey -Name 'NoModify'        -Value 1             -PropertyType DWord  -Force | Out-Null
New-ItemProperty -Path $RegKey -Name 'NoRepair'        -Value 1             -PropertyType DWord  -Force | Out-Null
Ok $RegKey

# The first WebView2 launch creates the data dir; do it now so the app never
# starts up staring at a permission error.
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }

Write-Host ''
Write-Host "OK  $AppName installed" -ForegroundColor Green
Write-Host "    program : $installDir"
Write-Host "    data    : $dataDir"
if ($desktopLink) { Write-Host "    desktop : $desktopLink" }

if (-not $NoLaunch) {
    Step 4 'starting it'
    Start-Process -FilePath $exe -WorkingDirectory $installDir
    Ok 'started'
}
