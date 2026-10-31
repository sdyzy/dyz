@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Liars Tavern NEON

echo.
echo  ==============================================================
echo    Liars Tavern NEON  //  Room server + public link
echo  ==============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [x] Node.js not found. Install Node.js 18 or newer first.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node --version') do set NODE_VER=%%v
echo  [ok] Node.js %NODE_VER%

if not exist "node_modules\ws\package.json" (
  echo  [..] First run: installing room server dependency...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo  [x] Dependency install failed. Check your network and retry.
    echo.
    pause
    exit /b 1
  )
)
echo  [ok] Room server dependency ready

if not exist "tools\cloudflared.exe" (
  echo  [..] cloudflared.exe not found, using serveo fallback.
) else (
  echo  [ok] cloudflared ready
)

where ssh >nul 2>nul
if errorlevel 1 (
  echo  [..] ssh not found; fallback tunnel may be unavailable.
) else (
  echo  [ok] ssh fallback available
)

echo  [..] Building single-file page...
node temporary\build.js
if errorlevel 1 (
  echo  [x] Build failed. See the errors above.
  echo.
  pause
  exit /b 1
)

echo.
echo  --------------------------------------------------------------
echo   Starting the room server and requesting a public link.
echo   If Cloudflare is unavailable it switches to serveo.
echo   The browser opens automatically. Phones can use the same link.
echo   Keep this window open. Press Ctrl+C to stop.
echo  --------------------------------------------------------------
echo.

node launch.js

echo.
echo  Server stopped.
pause
