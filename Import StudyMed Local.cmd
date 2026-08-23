@echo off
setlocal
chcp 65001 > nul
title StudyMed - Nap file cho dich local

set "STUDYMED_TOOL_ROOT=%~dp0"

where node > nul 2>&1
if errorlevel 1 (
    echo.
    echo LOI: Khong tim thay Node.js. Hay cai Node.js 22 roi chay lai.
    echo.
    pause
    exit /b 1
)

node "%STUDYMED_TOOL_ROOT%med-translator-backend\scripts\local-batch-importer.js" %*
set "STUDYMED_IMPORT_EXIT=%ERRORLEVEL%"

echo.
if "%STUDYMED_IMPORT_EXIT%"=="0" (
    echo Tool da ket thuc an toan.
) else (
    echo Tool gap loi. File nguon van duoc giu nguyen; chay lai de resume sau khi xu ly loi.
)
echo.
pause
exit /b %STUDYMED_IMPORT_EXIT%
