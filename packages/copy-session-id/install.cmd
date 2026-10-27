@echo off
rem  Same as the Chinese-named file; kept in ASCII for scripts and CI.
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
echo.
pause
exit /b 1
