# Khoản trống và rủi ro còn mở

Cập nhật sau kiểm tra local Project 001 ngày 15-07-2026.

## Trạng thái production

- Migration MongoDB, unique index verification, deploy backend trước/frontend sau và Gemini smoke PDF một trang đã đạt ngày 15-07-2026.
- Sau smoke, PDF nguồn được dọn và MongoDB trở lại `jobs=0`, `systems=0`, `translationChunks=0`.
- Chưa chạy batch nhiều chương bằng UI thật và chưa theo dõi production đủ 24 giờ.
- Batch 5 file đầu tiên có 4 `FILE_MISSING`; hotfix idle polling/feeder/HTTP keepalive đã deploy nhưng batch chưa được chạy lại để nghiệm thu.
- Chưa đo peak RAM với PDF nhỏ/trung bình/gần giới hạn. Transfer buffer đã giảm một bản clone nhưng `pdf-lib` vẫn cần giữ PDF gốc và các chunk trong worker trong lúc cắt.
- Chưa chạy bài tích hợp thực tế file kết quả trên 16 MB, restart Render giữa job, disk gần 400 MB hoặc mất MongoDB giữa upload.
- Chưa theo dõi 24 giờ sau deploy. Xem các cổng G5/G9 trong `project 001.md`.

## Test còn thiếu

- Ma trận đầy đủ mọi error code: status, retry, circuit counter và cleanup.
- Cancellation ở mọi thời điểm bằng Gemini/Mongo mock tích hợp, gồm folder nhiều trạng thái và worker remote/stale lease.
- SSE disconnect/reconnect đúng lúc completed.
- Preview/download job legacy và filename Unicode `#`, `%` end-to-end.
- Download collision qua File System Access API và result lớn.

## Khoản nợ code/UX

- `frontend/src/App.jsx` vẫn lớn, có inline style và nhiều `alert/confirm`.
- Preview/copy vẫn ghép toàn bộ chunk thành JSON string trong RAM; download đã streaming. Tài liệu cực lớn nên ưu tiên download.
- `getUploadStorageUsage()` scan/stat toàn bộ `uploads`; thiết kế một source file làm chi phí nhỏ, nhưng cần theo dõi production.
- Rate limit upload là 120 request/giờ. Batch dịch thông thường chậm hơn mức này, nhưng cần điều chỉnh nếu chương rất nhỏ và throughput tăng.
- Không có authentication theo quyết định rõ ràng của chủ dự án; vẫn cần giữ CORS, rate limit, file/disk validation vì endpoint công khai có thể bị truy cập ngoài ý muốn.

## Giới hạn nền tảng

- Render filesystem ephemeral: nếu tab Local Feeder không còn mở, backend không thể tự lấy lại PDF đã mất.
- Render Free spin down sau 15 phút không có inbound HTTP/WebSocket message và xóa filesystem local. Frontend có keepalive 5 phút khi còn Local Queue, nhưng laptop sleep/tab bị hủy vẫn cần người dùng chọn lại file. Xem https://render.com/docs/free.
- Hủy AbortSignal ngăn client tiếp tục chờ/nhận chunk mới nhưng không đảm bảo dịch vụ Gemini đã dừng tính phí cho request đã nhận.
- File System Access API không có trên mọi trình duyệt; người dùng vẫn có thể preview/copy từng job.

## Nguồn sự thật

Mã nguồn hiện tại và `project 001.md` ưu tiên hơn `cline_docs/`, `.clinerules` và tài liệu Cline cũ. Không đọc/ghi secret vào knowledge base.
