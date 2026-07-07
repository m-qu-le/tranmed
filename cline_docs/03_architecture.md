# Kiến trúc hệ thống (Architecture)

## 1. Cấu trúc thư mục chính
- `med-translator-backend/`: Chứa mã nguồn server xử lý chính.
    - `src/controllers/`: Xử lý request từ client.
    - `src/services/`: Chứa logic nghiệp vụ (Gemini AI, PDF processing, Queue).
    - `src/models/`: Định nghĩa dữ liệu (Job status, System config).
    - `src/workers/`: Xử lý tác vụ nặng (Background workers).
    - `uploads/`: Lưu trữ file tạm.
- `med-translator-frontend/`: Chứa mã nguồn giao diện người dùng (React/Vite).

## 2. Mô hình kiến trúc
Dự án sử dụng kiến trúc **Client-Server truyền thống** với sự phân tách rõ ràng:
- **Client:** React SPA gửi yêu cầu dịch file.
- **Server:** Node.js Express API.
- **Xử lý bất đồng bộ:** Sử dụng `QueueManager` và `Workers` để đảm bảo server không bị block khi xử lý file lớn.

## 3. Luồng dữ liệu (Data Flow)
1. **Request:** Người dùng tải file lên qua Frontend -> Gửi tới `translateController.uploadFile` -> Lưu file vào `/uploads` -> Khởi tạo job trong `jobModel` -> Trả về `jobId`.
2. **Xử lý:** 
    - `queueManager` nhận task, đẩy vào hàng đợi xử lý.
    - `pdfWorker` chạy background, thực hiện tách text (`pdfService.extractText`).
    - `geminiService.translateText` gửi chunks nội dung tới API Gemini.
    - Kết quả lưu vào `jobModel`.
3. **Trả kết quả:** Frontend thực hiện polling `GET /status/:jobId` để cập nhật trạng thái UI.

## 4. Chi tiết các module Backend
- **Controllers (`translateController.js`):** Xử lý request HTTP, trung gian giữa Client và Service.
- **Routes (`translateRoute.js`):** Định nghĩa API endpoint (`POST /translate`, `GET /status/:id`).
- **Middlewares (`upload.js`):** Sử dụng `multer` xử lý upload file, kiểm tra dung lượng và loại file.
- **Utils (`pdfSplitter.js`):** Thuật toán chia nhỏ văn bản từ PDF thành chunks trước khi đẩy cho AI.
- **Services:**
    - `geminiService.js`: Chứa logic giao tiếp với API Gemini. Sử dụng `API_KEY` từ `.env`.
    - `pdfService.js`: Chứa hàm `extractText` trích xuất nội dung PDF.
    - `queueManager.js`: Quản lý hàng đợi tác vụ dịch.
    - `pdfWorker.js`: Thực hiện chia nhỏ (chunking) file lớn.
- **Models:** 
    - `jobModel.js`: Lưu trữ job (id, status, result).
    - `systemModel.js`: Lưu cấu hình hệ thống (AI model settings).

## 5. Quản lý trạng thái
- Frontend duy trì state `file`, `status`, `result` trong `App.jsx`.
- Backend duy trì `jobModel` (Pending, Processing, Completed, Failed).
