@echo off
rem ---------------------------------------------------------------
rem  WorkBuddy Session Menu - installer wrapper (ASCII only!)
rem
rem  Why this file has no Chinese: cmd.exe parses .cmd with the OEM
rem  code page (GBK on zh-CN). UTF-8 Chinese bytes collide with | < >
rem  and get spliced into bogus commands ('m' is not recognized).
rem  All Chinese output comes from Node, which writes UTF-16 to the
rem  console and is code-page independent.
rem
rem  Why WorkBuddy.exe runs the script: ELECTRON_RUN_AS_NODE=1 turns
rem  the Electron binary into a plain Node runtime. Users therefore do
rem  not need Node.js installed - if WorkBuddy is here, Node is here.
rem ---------------------------------------------------------------
chcp 65001 >nul 2>&1
setlocal
title WorkBuddy Session Menu

call :find_wb
if not defined WB goto :not_found

set "ELECTRON_RUN_AS_NODE=1"
"%WB%" "%~dp0bin\setup.mjs" %*
set "RC=%ERRORLEVEL%"
echo.
if not defined WBSM_NOPAUSE pause
exit /b %RC%

:find_wb
set "WB="
if exist "%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe" set "WB=%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe"
if defined WB goto :eof
if exist "%ProgramFiles%\WorkBuddy\WorkBuddy.exe" set "WB=%ProgramFiles%\WorkBuddy\WorkBuddy.exe"
if defined WB goto :eof
if exist "D:\Software\WorkBuddy\WorkBuddy.exe" set "WB=D:\Software\WorkBuddy\WorkBuddy.exe"
if defined WB goto :eof
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)"`) do set "WB=%%P"
goto :eof

:not_found
echo.
echo   [ERROR] WorkBuddy.exe not found.
echo.
echo   Install the WorkBuddy desktop client first, then run this again.
echo   If WorkBuddy lives somewhere unusual, set WORKBUDDY_EXE to its path.
echo.
pause
exit /b 1
