@echo off
REM ============================================================================
REM  push-to-github.cmd -- first push of this repo to GitHub
REM
REM  NOTE: this file is deliberately PURE ASCII.
REM  A .cmd containing non-ASCII must be stored in GBK and run under chcp 936;
REM  a UTF-8 .cmd under chcp 65001 makes cmd.exe lose byte alignment and eat
REM  characters (echo -> cho, robocopy -> obocopy).  So: ASCII file, ASCII text.
REM
REM  NOTE: control flow uses GOTO labels, not if/else blocks.
REM  A literal "(" or ")" inside an if( ... ) else( ... ) block breaks cmd's
REM  parenthesis counting and makes the else-branch run in the success case.
REM  That bug was actually shipped in a first draft of this file.
REM
REM  What it does:
REM    1. sets origin to the GitHub URL (replacing it if already present)
REM    2. pushes main
REM  Git will show a sign-in window the first time -- log in there with your
REM  browser.  No token is stored in this file.
REM ============================================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set REPO_URL=https://github.com/Chen-ser/YangShan-schedule.git

echo.
echo   YangShan Schedule  --  push to GitHub
echo   ------------------------------------------------
echo   remote : %REPO_URL%
echo   branch : main
echo.

for /f "delims=" %%i in ('git remote get-url origin 2^>nul') do set EXISTING=%%i
if not defined EXISTING goto addremote
echo   origin already points at: %EXISTING%
echo   removing it and setting the one above.
git remote remove origin

:addremote
git remote add origin %REPO_URL%
if errorlevel 1 goto noremote

echo.
echo   Pushing... a sign-in window may appear. Log in there with your browser.
echo.
git push -u origin main
if errorlevel 1 goto failed
goto ok

:noremote
echo.
echo   FAILED to add the remote.
echo   Is git on PATH?  Check with:   git --version
echo   This machine's git lives at:   C:\Users\lian3\.dsh\git\cmd\git.exe
goto end

:failed
echo.
echo   ================================================
echo    PUSH FAILED
echo   ================================================
echo.
echo   Most common cause: the repository does not exist yet, or it was
echo   created WITH a README / .gitignore / license, so the histories differ.
echo.
echo   Create it EMPTY here, then run this file again:
echo     https://github.com/new
echo       Owner            = Chen-ser
echo       Repository name  = yangshan-schedule
echo       Visibility       = Public
echo       Add README       = OFF
echo       Add .gitignore   = None
echo       License          = None
echo.
echo   Other causes: wrong password / cancelled sign-in, or a proxy
echo   blocking https://github.com.  This repo forces the OpenSSL TLS
echo   backend because the Windows schannel backend fails on this machine
echo   with SEC_E_NO_CREDENTIALS -- if the clone URL is changed to SSH,
echo   that fix no longer applies.
goto end

:ok
echo.
echo   ================================================
echo    PUSH OK
echo   ================================================
echo.
echo   Next, turn on GitHub Pages:
echo     1. open https://github.com/Chen-ser/YangShan-schedule/settings/pages
echo     2. under "Build and deployment" set Source = "GitHub Actions"
echo     3. wait about 1 minute, then open:
echo        https://chen-ser.github.io/YangShan-schedule/
echo.
echo   NOTE the repo name keeps its capitals: YangShan-schedule.
echo   github.com is case-insensitive but the Pages URL is NOT --
echo   the all-lowercase path returns 404.

:end
echo.
pause
endlocal
