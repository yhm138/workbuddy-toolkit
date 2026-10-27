@echo off
rem ---------------------------------------------------------------
rem  Enable "Copy Session ID" in WorkBuddy's conversation context menu.
rem  ASCII only on purpose: cmd.exe parses .cmd with the OEM code page
rem  (GBK on zh-CN), so UTF-8 Chinese here gets split into garbage
rem  commands. All user-facing text lives in context-menu.mjs.
rem ---------------------------------------------------------------
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

"%NODE%" "%~dp0context-menu.mjs" enable %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
