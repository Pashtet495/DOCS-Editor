@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM  build.bat - Build DOCS Editor portable version
REM ============================================================

echo.
echo ============================================================
echo   DOCS Editor - Build portable version
echo ============================================================
echo.

REM --- Use mirrors for Electron downloads (avoids ECONNRESET from GitHub) ---
REM These env vars tell electron-builder & the electron package to download
REM binaries from npmmirror.com instead of github.com/electron/electron/releases.
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
set "ELECTRON_CUSTOM_DIR={{ version }}"

REM --- Kill any running DOCS Editor / Electron processes ---
echo [i] Closing any running DOCS Editor processes...
taskkill /f /im "DOCS Editor.exe" >nul 2>nul
taskkill /f /im electron.exe >nul 2>nul
timeout /t 2 /nobreak >nul

REM --- Clean old dist ---
if exist "dist\win-unpacked" (
  rmdir /s /q "dist\win-unpacked" 2>nul
)

REM --- Ensure bun is in PATH ---
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

REM --- Check electron-builder ---
set "BUILDER_CMD="
if exist "node_modules\.bin\electron-builder.cmd" (
  set "BUILDER_CMD=node_modules\.bin\electron-builder.cmd"
) else if exist "node_modules\.bin\electron-builder.exe" (
  set "BUILDER_CMD=node_modules\.bin\electron-builder.exe"
) else if exist "node_modules\.bin\electron-builder" (
  set "BUILDER_CMD=node_modules\.bin\electron-builder"
)

if "!BUILDER_CMD!"=="" (
  echo [!] electron-builder not found. Run install.bat first.
  pause
  exit /b 1
)

REM --- Pre-cache Electron binary (download via mirror before electron-builder runs) ---
echo [i] Pre-caching Electron binary via mirror...
call npx electron --version >nul 2>nul
if !errorlevel! neq 0 (
  echo [!] Electron binary not found. Trying to install...
  call bun add -d electron@latest
  if !errorlevel! neq 0 (
    echo [!] Failed to install electron. Check your internet connection.
    pause
    exit /b 1
  )
)

echo [i] Step 1/2: Next.js production build (static export to out/)...
call bun run build
if !errorlevel! neq 0 (
  echo [!] Next.js build error.
  pause
  exit /b 1
)

REM --- Verify out/ directory was created ---
if not exist "out\index.html" (
  echo [!] Build did not generate out\index.html. Check next.config.ts has output: "export".
  pause
  exit /b 1
)
echo [+] Static export generated: out\index.html

echo.
echo [i] Step 2/2: Packaging via electron-builder...
"!BUILDER_CMD!" --win --x64
if !errorlevel! neq 0 (
  echo [!] electron-builder error.
  echo     Make sure no DOCS Editor or Electron process is running.
  echo     If the error is a download failure (ECONNRESET), try setting
  echo     ELECTRON_MIRROR manually or pre-installing electron:
  echo       set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  echo       bun add -d electron
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   Build complete!
echo.
echo   Portable:  dist\win-unpacked\DOCS Editor.exe
echo ============================================================
echo.
pause
