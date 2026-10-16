@echo off
rem ---------------------------------------------------------------------------
rem YangShan Schedule - double-click entry point for the portable installer.
rem
rem Keep this file ASCII-only: cmd.exe reads a .cmd using the system ANSI code
rem page, so a literal non-ASCII byte here becomes mojibake (or worse, eats a
rem quote and breaks the control flow).
rem
rem Layout it expects next to itself:
rem   out\YangShanShell.exe   (produced by build.ps1)
rem   install.ps1
rem   uninstall.ps1
rem ---------------------------------------------------------------------------
setlocal
set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%install.ps1" -Source "%ROOT%out"
if errorlevel 1 (
  echo.
  echo Installation failed.
  pause
  exit /b 1
)
exit /b 0
