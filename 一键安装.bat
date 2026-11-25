@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Agent Monitor Setup
echo ============================================
echo    Agent Monitor - One-Click Setup
echo ============================================
echo.
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if defined NODE_EXE goto run
if exist "%ProgramFiles%
odejs
ode.exe" set "NODE_EXE=%ProgramFiles%
odejs
ode.exe"
if defined NODE_EXE goto run
if exist "%LOCALAPPDATA%ProgramsNuwaxesources
odewin32-x64in
ode.exe" set "NODE_EXE=%LOCALAPPDATA%ProgramsNuwaxesources
odewin32-x64in
ode.exe"
if defined NODE_EXE goto run
echo [!] Node.js not found. Install Node.js 22+ from https://nodejs.org/zh-cn
echo     Download LTS, double-click, keep clicking Next. Then run this file again.
echo.
pause
exit /b 1
:run
echo [1/2] Detecting installed clients and installing...
echo.
"%NODE_EXE%" install.mjs --platform auto
echo.
echo [2/2] Done. Opening dashboard navigator...
echo.
start "" "%~dp0dashboard.html"
echo Navigator opened in browser. You can close this window.
echo.
pause
