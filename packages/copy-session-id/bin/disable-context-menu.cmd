@echo off
rem  Remove WORKBUDDY_REMOTE_DEBUGGING_PORT and go back to the stock menu.
rem  ASCII only - see enable-context-menu.cmd for the reason.
setlocal
set "NODE="
where node >nul 2>&1 && set "NODE=node"
if not defined NODE (
  for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if not defined NODE if exist "%%~fD\node.exe" set "NODE=%%~fD\node.exe"
  )
)
if not defined NODE (
  echo [x] Node.js not found.
  echo     Install Node.js 18+ and run this file again.
  echo.
  pause
  exit /b 1
)

"%NODE%" "%~dp0context-menu.mjs" disable
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
