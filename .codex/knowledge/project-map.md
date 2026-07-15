# Bản đồ dự án

StudyMed Translator nhận PDF y khoa, dịch toàn văn sang Markdown tiếng Việt bằng Gemini và cho phép xem, copy hoặc tải kết quả.

| Khu vực | Vai trò | Điểm vào |
| --- | --- | --- |
| `med-translator-backend/` | Express API, MongoDB, queue, PDF Worker, Gemini | `src/server.js` |
| `med-translator-frontend/` | React/Vite, Local Feeder, SSE và tải Markdown | `src/main.jsx` → `src/App.jsx` |
| `.codex/knowledge/` | Kiến thức bền vững cho Codex | file này |
| `cline_docs/` | Handover lịch sử từ Cline; có thể đã cũ | `01_project_overview.md` |
| `project 001.md` | Kế hoạch, checklist, ma trận test và nhật ký đại tu | root |

## Luồng hiện hành

```text
Người dùng chọn tối đa hàng trăm PDF
  → React giữ File trong Local Feeder của tab
  → GET /capacity
  → POST đúng 1 PDF + clientUploadId
  → Multer lưu tên vật lý UUID.pdf
  → tạo Job UUID ở MongoDB
  → atomic claim pending → processing + processingToken + lease
  → PDF Worker đọc theo filePath, cắt 3 trang/chunk, transfer buffer
  → tối đa 2 Gemini call đồng thời
  → upsert từng TranslationChunk và phát progress SSE
  → completed khi đủ chunk; xóa PDF nguồn
  → preview/copy qua result API; tải lớn qua streaming download
```

## Bất biến phải giữ

- Một `QueueManager` chỉ xử lý một job; claim MongoDB là atomic để không nhân đôi job.
- File mới chỉ được nhận khi không có PDF `pending|processing` và còn disk budget.
- `clientUploadId` làm upload idempotent. Nếu Render mất PDF, tải lại phải dùng cùng ID, cùng Job và giữ chunk đã dịch để resume.
- Job mới không lưu toàn bộ Markdown vào `Job.result`; field này chỉ để đọc dữ liệu legacy.
- Retry phải có `attemptCount`, `maxAttempts`, `nextRetryAt`; chỉ lỗi quota tăng circuit counter.
- Xóa job processing là soft-cancel trước, AbortSignal dừng worker/Gemini, cleanup diễn ra sau khi request đang bay kết thúc.
- SSE có thể mất event; frontend phải resync `/status` và `/jobs` khi reconnect.

## Quy ước

- JavaScript ESM, async filesystem, controller mỏng và logic vòng đời nằm trong service.
- ID nội bộ là UUID, tên gốc chỉ dùng hiển thị/tên download.
- Giữ backward compatibility với job cũ có `result` trong suốt Project 001.
- Không chạy migration production khi chưa backup và review dry-run.
