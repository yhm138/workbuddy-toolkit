@echo off
rem ---------------------------------------------------------------
rem  One-click installer entry. Content must stay ASCII-only:
rem  cmd.exe parses batch files byte-wise in the OEM codepage, so
rem  UTF-8 Chinese would be split into illegal commands.
rem  All user-facing Chinese text lives in bin\setup.mjs.
rem ---------------------------------------------------------------
chcp 65001 >nul 2>&1
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
node "%~dp0bin\setup.mjs" %*
goto :finish

:withwb
set "ELECTRON_RUN_AS_NODE=1"
set "ERRF=%TEMP%\wb-session-bridge.err"
"%WB%" "%~dp0bin\setup.mjs" %* 2>"%ERRF%"
set "RC=%ERRORLEVEL%"
rem Electron prints a harmless crashpad line before our script runs.
rem Swallow it so the first thing a first-time user sees is our own text.
if exist "%ERRF%" (
  type "%ERRF%" | findstr /v /i /c:"crashpad" /c:"ERROR:third_party"
  del "%ERRF%" >nul 2>&1
)
goto :done

:nonode
echo.
echo   WorkBuddy was not found, and Node.js is not installed either.
echo   Please install WorkBuddy first (it ships its own Node runtime).
echo.
set "RC=2"
goto :done

:finish
set "RC=%ERRORLEVEL%"

:done
echo.
if not defined DSH2WB_NOPAUSE pause
exit /b %RC%
