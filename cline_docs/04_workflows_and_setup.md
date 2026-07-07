# Quy trình vận hành & Thiết lập (Workflows & Setup)

## 1. Cài đặt & Chạy Local
### Backend
1. Di chuyển vào thư mục backend: `cd med-translator-backend`
2. Cài đặt dependencies: `npm install`
3. Cấu hình file `.env` (cần API key cho Gemini).
4. Chạy server: `npm run dev` (hoặc `node src/server.js`)

### Frontend
1. Di chuyển vào thư mục frontend: `cd med-translator-frontend`
2. Cài đặt dependencies: `npm install`
3. Chạy môi trường phát triển: `npm run dev`

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
