@echo off
chcp 65001 >nul
title TransTool LAN Transfer
cd /d %~dp0

rem If port 7100 is already used by an old instance, stop it and restart
netstat -ano | findstr ":7100" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo.
  echo  [TransTool] An old instance is still running on port 7100.
  echo  Stopping the old process and restarting...
  ping -n 3 127.0.0.1 >nul
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7100" ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>nul
  ping -n 2 127.0.0.1 >nul
)

rem 优先使用随包自带的 Node 运行时（无需安装 Node.js）
if exist "%~dp0node.exe" (
  set "NODEEXE=%~dp0node.exe"
) else (
  set "NODEEXE=node"
  where node >nul 2>nul
  if errorlevel 1 (
    echo [Error] Node.js runtime not found.
    echo Please keep node.exe in this folder, or install Node.js from https://nodejs.org
    echo.
    pause
    exit /b 1
  )
)

echo Starting TransTool. Keep this window open.
echo.
"%NODEEXE%" server.js
echo.
echo ==========================================================
echo  TransTool has exited. If it was an error, please copy
echo  the messages above for support.
echo ==========================================================
pause
