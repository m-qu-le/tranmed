# Trạng thái hiện tại & Lộ trình (Current State & Roadmap)

## 1. Module đã hoàn thiện
- **Core Engine:** Hệ thống tiếp nhận, xử lý file và queue đã được thiết lập khung cơ bản.
- **AI Integration:** Kết nối Gemini API đã sẵn sàng.
- **Frontend UI:** Khung cơ bản cho phép tương tác đã có sẵn.

## 2. Các điểm cần chú ý / TODOs
- **File Processing:** Kiểm tra lại khả năng xử lý các file PDF dung lượng lớn.
- **Error Handling:** Cải thiện cơ chế phản hồi lỗi từ Gemini API (rate limiting, timeout).
- **Security:** Tăng cường kiểm duyệt file upload (kiểm tra MIME type, giới hạn dung lượng file).
- **Codebase:** Không tìm thấy các comment `TODO` hoặc `FIXME` trong mã nguồn logic chính (`src/`), các `TODO` tìm thấy chủ yếu nằm trong `node_modules` (thư viện bên thứ ba).

## 3. Tech Debt & Risks
- **Rate Limiting:** Gemini API có giới hạn, cần bổ sung cơ chế retry hoặc quản lý queue chặt chẽ hơn để tránh bị ban.
- **Memory Management:** Khi xử lý nhiều tác vụ song song, cần giám sát tài nguyên hệ thống (CPU/RAM).
- **Refactoring:** Kiến trúc hiện tại còn khá đơn giản, nếu mở rộng tính năng (thêm loại file, thêm ngôn ngữ), có thể cần tách biệt Service layer mạnh hơn.