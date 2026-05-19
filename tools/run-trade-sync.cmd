@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-trade-sync.ps1" %*
if "%~1"=="" pause
