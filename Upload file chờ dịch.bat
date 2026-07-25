@echo off
setlocal
chcp 65001 > nul
title StudyMed - Upload file cho dich

set "STUDYMED_TOOL_ROOT=%~dp0"

where node > nul 2>&1
if errorlevel 1 (
    echo.
    echo LOI: Khong tim thay Node.js. Hay cai Node.js 22 roi chay lai.
    echo.
    pause
    exit /b 1
)

node "%STUDYMED_TOOL_ROOT%med-translator-backend\scripts\local-uploader.js" %*
set "STUDYMED_UPLOAD_EXIT=%ERRORLEVEL%"

echo.
if "%STUDYMED_UPLOAD_EXIT%"=="0" (
    echo Tool da ket thuc an toan.
) else (
    echo Tool gap loi. PDF nguon van duoc giu nguyen; chay lai de resume sau khi xu ly loi.
)
echo.
pause
exit /b %STUDYMED_UPLOAD_EXIT%
