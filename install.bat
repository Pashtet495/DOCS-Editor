@echo off
setlocal enabledelayedexpansion

echo.
echo ============================================================
echo   DOCS Editor - Environment setup
echo ============================================================
echo.

REM --- Use mirrors for Electron downloads (avoids ECONNRESET from GitHub) ---
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
set "ELECTRON_CUSTOM_DIR={{ version }}"

where bun >nul 2>nul
if !errorlevel! neq 0 (
  echo [i] bun not found. Installing bun...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
  if !errorlevel! neq 0 (
    echo [!] Failed to install bun.
    pause
    exit /b 1
  )
  set "PATH=%USERPROFILE%\.bun\bin;!PATH!"
  echo [+] bun installed.
)

echo.
echo [i] Installing project dependencies...
call bun install
if !errorlevel! neq 0 (
  echo [!] Error during bun install.
  pause
  exit /b 1
)

echo.
echo [i] Installing electron and electron-builder (via mirror)...
call bun add -d electron@latest electron-builder@latest
if !errorlevel! neq 0 (
  echo [!] Error installing electron. Trying without mirror...
  set "ELECTRON_MIRROR="
  call bun add -d electron@latest electron-builder@latest
  if !errorlevel! neq 0 (
    echo [!] Failed to install electron. Check your internet connection.
    pause
    exit /b 1
  )
)

echo.
echo [i] Verifying Electron binary download...
call npx electron --version >nul 2>nul
if !errorlevel! neq 0 (
  echo [!] Electron binary download may have failed. Retrying with mirror...
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  call node node_modules\electron\install.js
  if !errorlevel! neq 0 (
    echo [!] Electron binary not installed. Build may fail.
    echo     Try manually: set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
    echo     Then: bun add -d electron
  )
)

echo.
echo ============================================================
echo   Setup complete!
echo   run-dev.bat  - run in dev mode
echo   build.bat    - build portable version
echo ============================================================
echo.
pause
