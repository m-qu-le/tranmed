# Frontend

React 19 + Vite. `src/api/client.js` chuẩn hóa `VITE_API_URL`; `App.jsx` hiện vẫn chứa phần lớn UI/logic.

## Cloud Uploader

- Người dùng chọn tối đa 200 PDF cho một batch và nhóm bằng folder.
- `src/cloudUploader.js` gửi manifest tới `/upload-batches/prepare`, PUT trực tiếp lên presigned R2 URL với concurrency 4 rồi confirm theo nhóm hữu hạn.
- `clientUploadId` và `clientBatchId` ổn định giúp prepare/confirm/retry idempotent.
- URL hết hạn được refresh bằng prepare lại; PUT/confirm có retry hữu hạn.
- Chỉ khi backend trả `canCloseClient=true` mới báo có thể đóng tab/máy. Batch cloud đã confirm có thể resume từ Mongo/R2 sau F5.
- Item không thể upload có thể abandon; backend dọn object và đánh dấu skipped.

## Jobs, SSE và chất lượng

- Initial load/reconnect lấy `/status`, `/jobs` và `/upload-batches`; SSE chỉ là kênh cập nhật, không phải nguồn trạng thái duy nhất.
- Card quality hiển thị context/translate/audit/revise/verify/repair/reverify, số passed và warning page range.
- Chỉ backend quyết định strict PASS. Frontend không suy diễn report riêng hoặc gọi bản dịch “đã kiểm chứng hoàn toàn”.
- Job `needs_review` vẫn preview/copy/download final content và hiển thị “Hoàn thành có cảnh báo”.
- Legacy job không có quality fields vẫn hoạt động.

## Kết quả

- Job card lazy-fetch result để preview/copy; list summary không chứa Markdown đầy đủ.
- Download job/folder dùng streaming endpoint và File System Access API khi có.
- Tên Windows được sanitize; collision so không phân biệt hoa thường và thêm `_2`, `_3`, ...; writable đóng trong `finally`.

## Kiểm thử và khoản nợ

- Vitest + Testing Library; Cloud Uploader test batch 200 file, concurrency 4, retry PUT và confirm chunk.
- Chạy `npm test`, `npm run lint`, `npm run build`.
- Khoản nợ: tách `App.jsx`, thay `alert/confirm`, bổ sung e2e SSE/retry/cancel/download collision. Các việc này không chặn trạng thái đóng P003.
