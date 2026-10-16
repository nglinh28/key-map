@echo off
chcp 65001 >nul
title FT Keymap Server - Localhost
cd /d "%~dp0"

set "DATABASES_DIR=%~dp0..\databases"

echo ========================================================
echo   FT Keymap Server (Web Admin)
echo ========================================================
echo.
echo Su dung databases tai: %DATABASES_DIR%
echo Server dang khoi dong tai: http://localhost:8787
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [LOI] Khong tim thay Node.js! Vui long cai dat Node.js tu https://nodejs.org
    echo.
    pause
    exit /b 1
)

start "" "http://localhost:8787"
node server.js
if %errorlevel% neq 0 (
    echo.
    echo Server da dung.
    pause
)
