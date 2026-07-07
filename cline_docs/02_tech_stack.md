# Ngăn xếp công nghệ (Tech Stack)

## 1. Runtime & Ngôn ngữ
- **Node.js**: Nền tảng thực thi chính cho backend.
- **JavaScript (ES6+)**: Ngôn ngữ chính cho cả backend và frontend.

## 2. Frameworks & Thư viện chính
### Backend (`med-translator-backend`)
- **Express.js**: Framework web cho backend.
- **Gemini API**: Dịch vụ AI dùng để xử lý dịch thuật.
- **Multer**: Middleware xử lý upload file.
- **PDF-related libraries**: Sử dụng để phân tách và xử lý file PDF.

### Frontend (`med-translator-frontend`)
- **Vite**: Công cụ build frontend thế hệ mới.
- **React**: Thư viện UI.

## 3. Cơ sở dữ liệu & Lưu trữ
- **FileSystem**: Lưu trữ file tạm thời trong thư mục `uploads/`.
- *(Dự kiến)*: Đang sử dụng các file model (`jobModel.js`) cho thấy có sự quản lý trạng thái tác vụ.

## 4. Công cụ Build & Development
- **ESLint**: Kiểm soát chất lượng code.
- **dotenv**: Quản lý biến môi trường.

## 5. Phân tích Dependencies quan trọng
- `geminiService.js`: Kết nối trực tiếp với API của Google Gemini.
- `queueManager.js`: Cốt lõi của hệ thống xử lý bất đồng bộ, giúp quản lý các yêu cầu dịch thuật nặng mà không làm treo server.
- `pdfWorker.js`: Xử lý tách/phân tích PDF ở background thread.