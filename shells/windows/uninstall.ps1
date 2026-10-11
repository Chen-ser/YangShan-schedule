#requires -version 5
<#
  YangShan Schedule - Windows shell uninstaller (per-user, no admin needed)

  What it removes:
    - the Desktop and Start Menu shortcuts
    - %LOCALAPPDATA%\Programs\YangShanSchedule   (the program itself)
    - the HKCU uninstall entry
    - the "remembered account" credential in Windows Credential Manager

  What it keeps unless you ask:
    - %LOCALAPPDATA%\YangShanSchedule  (settings + the schedule WebView2 cache)
      pass -PurgeData to delete that too

  ASCII-only on purpose: PowerShell 5.1 decodes a BOM-less .ps1 with the ANSI
  code page, so non-ASCII literals would turn into mojibake. The Chinese app
  name is assembled from code points.

  Usage:
    powershell -ExecutionPolicy Bypass -File uninstall.ps1
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Quiet
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -PurgeData
#>
[CmdletBinding()]
param(
    # No prompts, no "press enter" - used by the Apps & features entry.
    [switch]$Quiet,
    # Also delete %LOCALAPPDATA%\YangShanSchedule (settings + cached schedule).
    [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$AppName   = [string]([char]0x4EF0 + [char]0x5C71 + [char]0x8BFE + [char]0x8868)
$RegKey    = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\YangShanSchedule'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\YangShanSchedule'
$dataDir    = Join-Path $env:LOCALAPPDATA 'YangShanSchedule'

function Step($text) { Write-Host ''; Write-Host "[x] $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "    $text" -ForegroundColor Green }

if (-not $Quiet) {
    Write-Host "This will uninstall $AppName."
    if (-not $PurgeData) {
        Write-Host "Your schedule and settings in $dataDir will be KEPT."
        Write-Host "(use -PurgeData to delete them as well)"
    } else {
        Write-Host "Your schedule and settings in $dataDir will be DELETED."
    }
    $answer = Read-Host 'Continue? [y/N]'
    if ($answer -notmatch '^[Yy]') { Write-Host 'Cancelled.'; exit 0 }
}

# ---- stop a running instance ------------------------------------------------
$procs = Get-Process -Name 'YangShanShell' -ErrorAction SilentlyContinue
if ($procs) {
    Step 'stopping the running app'
    $procs | ForEach-Object { try { $_.Kill() } catch { } }
    Start-Sleep -Milliseconds 800
    Ok 'stopped'
}

# ---- shortcuts --------------------------------------------------------------
Step 'removing shortcuts'
$links = New-Object System.Collections.Generic.List[string]
$links.Add((Join-Path ([Environment]::GetFolderPath('Programs')) ($AppName + '.lnk')))
$links.Add((Join-Path ([Environment]::GetFolderPath('Programs')) (Join-Path $AppName ($AppName + '.lnk'))))
$links.Add((Join-Path ([Environment]::GetFolderPath('Desktop')) ($AppName + '.lnk')))
foreach ($l in $links) {
    if (Test-Path $l) { Remove-Item $l -Force; Ok $l }
}
# The Start Menu folder we created, if it is now empty.
$smDir = Join-Path ([Environment]::GetFolderPath('Programs')) $AppName
if ((Test-Path $smDir) -and -not (Get-ChildItem $smDir -Force)) { Remove-Item $smDir -Force; Ok $smDir }

# ---- remembered credential --------------------------------------------------
Step 'forgetting the saved account'
try {
    $sig = @'
using System;
using System.Runtime.InteropServices;
public static class CredDel {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags; public uint Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
        public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDeleteW(string target, uint type, uint flags);
}
'@
    if (-not ('CredDel' -as [type])) { Add-Type -TypeDefinition $sig -Language CSharp }
    # 1 = CRED_TYPE_GENERIC
    $gone = [CredDel]::CredDeleteW('YangShanSchedule/bistu', 1, 0)
    if ($gone) { Ok 'deleted YangShanSchedule/bistu from Windows Credential Manager' }
    else       { Ok 'no saved credential (nothing to delete)' }
} catch {
    Write-Host "    (could not touch the credential store: $($_.Exception.Message))" -ForegroundColor Yellow
}

# ---- registry ---------------------------------------------------------------
Step 'removing the uninstall entry'
if (Test-Path $RegKey) { Remove-Item $RegKey -Recurse -Force; Ok $RegKey }

# ---- files ------------------------------------------------------------------
Step 'removing program files'
if (Test-Path $installDir) { Remove-Item $installDir -Recurse -Force; Ok $installDir }

if ($PurgeData) {
    Step 'removing your data'
    if (Test-Path $dataDir) { Remove-Item $dataDir -Recurse -Force; Ok $dataDir }
} else {
    if (Test-Path $dataDir) { Ok "kept $dataDir" }
}

Write-Host ''
Write-Host "OK  $AppName removed" -ForegroundColor Green

if (-not $Quiet) {
    Write-Host ''
    Read-Host 'Press Enter to close'
}
