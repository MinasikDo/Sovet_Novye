@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
set "launchExit=%errorlevel%"
if not "%launchExit%"=="0" (
  echo.
  echo Startup failed. See the message above.
  pause
)
exit /b %launchExit%
