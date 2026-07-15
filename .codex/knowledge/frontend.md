# Frontend

React 19 + Vite. `src/api/client.js` chuẩn hóa `VITE_API_URL`, fallback đầy đủ `https://tranmed.onrender.com/api/translate` và Axios timeout. `App.jsx` hiện vẫn chứa phần lớn UI/logic; đây là khoản nợ refactor, không phải kiến trúc đích.

## Local Feeder

- Người dùng có thể chọn hàng trăm PDF và nhóm bằng folder.
- Mỗi file được cấp `clientUploadId` bằng `crypto.randomUUID()` một lần.
- File objects nằm trong bộ nhớ/tab của trình duyệt; chỉ một file được POST khi `/capacity` cho phép.
- Sau upload, feeder chờ server kết thúc/giải phóng capacity rồi mới gửi file kế tiếp.
- Nếu job failed `FILE_MISSING`, feeder lùi index và re-upload cùng ID để backend resume chunk.
- File references chỉ được giải phóng khi task hoàn tất hoặc người dùng xóa task. `beforeunload` cảnh báo khi còn công việc local.
- Khi đã upload một file, feeder chỉ chuyển file kế tiếp sau khi Job hiện tại được xác nhận `completed`; capacity trống không phải tín hiệu hoàn thành.
- Khi Local Queue còn việc, trình duyệt gọi `/status` mỗi 5 phút để tạo inbound HTTP traffic, hạn chế Render Free spin-down sau 15 phút idle.
- F5/đóng tab vẫn làm mất Local Feeder; MongoDB không thể phục hồi các File chưa upload từ máy người dùng.

## Cloud jobs và SSE

- Initial load và reconnect lấy `/status` + trang đầu `/jobs`.
- EventSource nhận status/progress/system state; JSON parse được bảo vệ và UI hiển thị trạng thái kết nối.
- `/jobs` có nút tải thêm theo cursor.
- `encodeURIComponent` được dùng cho job/folder ID trên URL; UUID là chuẩn cho job mới.

## Kết quả

- Job card lazy-fetch result để preview/copy; summary không chứa Markdown đầy đủ.
- Download cả folder dùng streaming endpoint và File System Access API.
- Tên Windows được sanitize; collision được so không phân biệt hoa thường và thêm `_2`, `_3`, ...; writable luôn đóng trong `finally`.

## Kiểm thử

Vitest + Testing Library. Test feeder tạo 100 `File`, xác nhận chỉ file đầu được POST; test restart xác nhận `FILE_MISSING` re-upload đúng file cũ với cùng UUID và không gửi file kế tiếp. Chạy `npm test -- --run`, `npm run lint`, `npm run build`.

## Khoản nợ còn lại

- Tách `JobCard`, folder, Local Queue và banner khỏi `App.jsx`.
- Thay dần `alert/confirm` bằng thông báo trong UI có ngữ cảnh.
- Bổ sung test SSE reconnect, retry/cancel UI và download collision end-to-end.
