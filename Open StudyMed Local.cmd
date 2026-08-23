@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0med-translator-backend\scripts\Open-StudyMedLocal.ps1"
if errorlevel 1 pause
