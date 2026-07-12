@echo off
setlocal enabledelayedexpansion

echo.
echo ============================================================
echo   DOCS Editor - Run (dev mode)
echo ============================================================
echo.

where bun >nul 2>nul
if !errorlevel! neq 0 (
  set "PATH=%USERPROFILE%\.bun\bin;!PATH!"
)
where bun >nul 2>nul
if !errorlevel! neq 0 (
  echo [!] bun not found. Run install.bat first.
  pause
  exit /b 1
)

set "ELECTRON_CMD="
if exist "node_modules\.bin\electron.cmd" (
  set "ELECTRON_CMD=node_modules\.bin\electron.cmd"
) else if exist "node_modules\.bin\electron.exe" (
  set "ELECTRON_CMD=node_modules\.bin\electron.exe"
) else if exist "node_modules\.bin\electron" (
  set "ELECTRON_CMD=node_modules\.bin\electron"
)

if "!ELECTRON_CMD!"=="" (
  echo [!] Electron not found. Run install.bat first.
  pause
  exit /b 1
)

echo [i] Electron found: !ELECTRON_CMD!
echo [i] Starting Next.js dev server...
start "DOCS Editor - Next.js" cmd /k "bun run dev"

echo [i] Waiting 12 seconds for server...
timeout /t 3 /nobreak >nul

echo [i] Starting Electron...
start "DOCS Editor - Electron" cmd /k "!ELECTRON_CMD! electron\main.js"

echo.
echo [+] Application launched.
echo.
exit
