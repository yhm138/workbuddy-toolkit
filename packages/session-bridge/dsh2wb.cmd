@echo off
rem  CLI launcher. Same trick as install.cmd: WorkBuddy.exe doubles as Node.
rem  No pause here - this one gets called from scripts and other agents.
setlocal

set "WB="
if exist "%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe" set "WB=%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe"
if not defined WB if exist "%ProgramFiles%\WorkBuddy\WorkBuddy.exe" set "WB=%ProgramFiles%\WorkBuddy\WorkBuddy.exe"
set "PF86=%ProgramFiles(x86)%"
if not defined WB if exist "%PF86%\WorkBuddy\WorkBuddy.exe" set "WB=%PF86%\WorkBuddy\WorkBuddy.exe"
if not defined WB for /f "usebackq delims=" %%P in (`powershell -NoProfile -NonInteractive -Command "(Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)" 2^>nul`) do set "WB=%%P"

if defined WB goto :withwb
where node >nul 2>&1
if errorlevel 1 goto :nonode
node "%~dp0bin\dsh2wb.mjs" %*
exit /b %ERRORLEVEL%

:withwb
set "ELECTRON_RUN_AS_NODE=1"
set "ERRF=%TEMP%\wb-session-bridge-cli.err"
"%WB%" "%~dp0bin\dsh2wb.mjs" %* 2>"%ERRF%"
set "RC=%ERRORLEVEL%"
rem Electron prints a harmless crashpad line on startup; drop it so the first
rem line of output is always ours (scripts and agents parse this).
if exist "%ERRF%" (
  type "%ERRF%" | findstr /v /i /c:"crashpad" /c:"ERROR:third_party"
  del "%ERRF%" >nul 2>&1
)
exit /b %RC%

:nonode
echo   WorkBuddy was not found, and Node.js is not installed either. 1>&2
exit /b 2
