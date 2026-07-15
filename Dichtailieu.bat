@echo off
title StudyMed Translator Launcher
chcp 65001 > nul
echo ===================================================
echo 🚀 ĐANG KHỞI ĐỘNG HỆ THỐNG STUDYMED TRANSLATOR...
echo ===================================================

:: Lấy đường dẫn của chính thư mục chứa file .bat này
set CURRENT_DIR=%~dp0

:: PDF tạm được QueueManager đối chiếu với MongoDB và tự dọn an toàn khi backend khởi động.
:: Không xóa mù thư mục uploads vì có thể làm mất job pending hợp lệ.

:: 1. Khởi động Backend
echo [1/4] Đang bật Backend Server...
start "Backend Server" cmd /k "cd /d %CURRENT_DIR%med-translator-backend && node src/server.js"

:: 2. Khởi động Frontend
echo [2/4] Đang bật Frontend Server...
start "Frontend Server" cmd /k "cd /d %CURRENT_DIR%med-translator-frontend && npm run dev"

:: 3. Đợi và mở trình duyệt
echo [3/4] Đang mở trình duyệt...
timeout /t 5 /nobreak > NUL
start http://localhost:5173

echo ✅ Hệ thống đã sẵn sàng!
echo (Bạn có thể thu nhỏ cửa sổ này, đừng tắt để duy trì kết nối)
pause
