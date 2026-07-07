# Quy trình vận hành & Thiết lập (Workflows & Setup)

## 1. Cài đặt & Chạy Local
### Backend
1. Di chuyển vào thư mục backend: `cd med-translator-backend`
2. Cài đặt dependencies: `npm install`
3. Cấu hình file `.env` (cần API key cho Gemini, MONGODB_URI).
4. Chạy server: `npm run dev` (hoặc `node src/server.js`)

### Frontend
1. Di chuyển vào thư mục frontend: `cd med-translator-frontend`
2. Cài đặt dependencies: `npm install`
3. Chạy môi trường phát triển: `npm run dev`
4. Cấu hình biến môi trường `VITE_API_URL` (ví dụ: `http://localhost:8080`) trong file `.env.local` nếu cần override.

## 2. Triển khai (Deployment)
### Render (Backend)
- Thiết lập biến môi trường `MONGODB_URI`, `GEMINI_API_KEYS` trên Dashboard.
- Đảm bảo CORS trong `src/server.js` cho phép domain của Frontend (Vercel).

### Vercel (Frontend)
- Thiết lập biến môi trường `VITE_API_URL` trỏ tới URL Backend trên Render.
- Thực hiện `Redeploy` để cập nhật cấu hình mới.
## 2. Các Scripts quan trọng
- **Backend:** 
    - `npm run dev`: Chạy server ở chế độ phát triển (watch mode).
    - `npm start`: Chạy production.
- **Frontend:**
    - `npm run dev`: Khởi động Vite development server.
    - `npm run build`: Build project để deploy.

## 3. Quy chuẩn Code (Code Conventions)
- **Cấu trúc:** Kiến trúc module hóa, tách biệt logic HTTP và Business Logic.
- **Xử lý lỗi:** Sử dụng try/catch cho các call API và File System.
- **Đặt tên:** `camelCase` cho biến và file.
- **Async/Await:** Bắt buộc cho mọi thao tác I/O.

## 4. Chi tiết Frontend (App.jsx)
- **State:** `file` (lưu file object), `status` (chuỗi trạng thái), `result` (kết quả text).
- **Logic:** 
    - `handleFileChange`: Xử lý input change.
    - `handleUpload`: `FormData` -> `POST /api/translate`.
    - Polling: Gọi API lấy trạng thái sau mỗi 2-3s.
