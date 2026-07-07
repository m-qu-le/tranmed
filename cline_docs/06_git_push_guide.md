# Hướng dẫn Push Code lên GitHub (Dự án Cá nhân)

Khi cần thực hiện push code cho dự án này, AI Agent cần tuân thủ quy trình sau để đảm bảo đúng tài khoản và không bị lỗi bảo mật:

1. **Xác nhận ngữ cảnh:** Dự án này thuộc tài khoản **Cá nhân** (`lequang2k5012345@gmail.com`).
2. **Kiểm tra cấu hình:** Luôn chạy lệnh kiểm tra trước khi push:
   ```bash
   git config --local user.email
   git remote -v
   ```
3. **Quy tắc quan trọng:**
   - Sử dụng remote URL: `git@github.com-personal:m-qu-le/tranmed.git`
   - **Tuyệt đối không** push các file chứa Secret/API Key. Nếu vô tình commit, phải dùng `git filter-branch` để loại bỏ khỏi lịch sử.
   - Nếu xảy ra lỗi `Permission denied`, kiểm tra lại remote URL theo hướng dẫn trong `CẨM NANG CẤU HÌNH VÀ SỬ DỤNG NHIỀU TÀI KHOẢN GITHUB.md`.