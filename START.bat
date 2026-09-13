@echo off
REM ================================================================================
REM  Simorgh Grid - double-click launcher
REM
REM  Exists so nobody has to open PowerShell or remember a command. It runs
REM  install.ps1 with the execution policy bypassed FOR THIS PROCESS ONLY, which
REM  does not change any machine-wide setting.
REM ================================================================================

title Simorgh Grid - Setup

where powershell >nul 2>nul
if errorlevel 1 (
  echo.
  echo   PowerShell was not found on this system.
  echo   Run install.ps1 manually, or install PowerShell.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*

echo.
echo   Press any key to close this window.
pause >nul
