# Backend

## Thành phần

- `src/config/env.js`: nạp `.env`, model Gemini, giới hạn upload/disk/retry/timeout và validate startup.
- `src/server.js`: CORS, health, error mapping, kết nối MongoDB; chỉ listen sau khi `translationQueue.initDB()` thành công.
- `src/middlewares/upload.js`: Multer disk storage ở đường dẫn tuyệt đối `uploads/`, một PDF/request, tên vật lý UUID.
- `src/middlewares/capacity.js` + `src/services/storageService.js`: khóa một upload, budget disk, capacity API và orphan cleanup.
- `src/services/queueManager.js`: atomic claim, lease, retry, circuit breaker, cancellation, chunk persistence, pagination và cleanup.
- `src/services/pdfService.js` + `src/workers/pdfWorker.js`: Worker đọc file, cắt 3 trang/chunk, hỗ trợ abort và transfer buffer không clone.
- `src/services/geminiService.js`: prompt, key rotation, timeout/abort, error taxonomy và pool tối đa 2 chunk.
- `src/models/translationChunkModel.js`: kết quả theo `{jobId, chunkIndex}`.
- `src/utils/processingError.js`: error code và retry policy dùng chung.

## API

Base path `/api/translate`; health ở `/api/health`.

| Method | Path | Ghi chú |
| --- | --- | --- |
| POST | `/` | multipart: một `files`, `folderName`, `clientUploadId`; rate limit và capacity guard |
| GET | `/capacity` | `canAcceptUpload`, lý do, file nguồn, disk budget và max file |
| GET | `/jobs?limit=&cursor=` | cursor pagination, tối đa 200 |
| GET | `/jobs/:jobId/result` | JSON Markdown; hỗ trợ legacy `Job.result` |
| GET | `/jobs/:jobId/download` | stream Markdown theo chunk |
| GET | `/status` | circuit breaker |
| GET | `/stream` | SSE + heartbeat 15 giây |
| DELETE | `/jobs/:jobId` | 202 nếu job processing đang chờ hủy |
| POST | `/bulk-delete` | tối đa 500 job ID |
| DELETE | `/folder/:folderName` | centralized cancellation/cleanup |
| POST | `/force-wakeup` | đánh thức circuit breaker |

## Schema chính

`Job`: UUID `jobId`, unique sparse `clientUploadId`, tên/folder/path, `pending|processing|completed|failed|cancelled`, legacy `result`, error code, attempts, retry time, cancel flag, processing token, lease và chunk progress.

`TranslationChunk`: `jobId`, `chunkIndex`, `content`; unique compound index.

`System`: unique `key`, `isHibernating`, stats circuit breaker.

## Vòng đời và lỗi

- Claim dùng một `findOneAndUpdate` pending → processing và tăng attempt.
- Lease 5 phút, heartbeat 1 phút. Lease hết hạn được phục hồi; job đã yêu cầu hủy được cleanup.
- `INVALID_PDF`, auth/config và lỗi vĩnh viễn không retry. Lỗi tạm retry có exponential backoff/jitter, tối đa theo `MAX_JOB_ATTEMPTS`.
- Chỉ `GEMINI_RATE_LIMIT` có `quotaRelated`; 10 lần quota liên tiếp kích hoạt ngủ 4 giờ.
- `FILE_MISSING` chuyển failed nhưng giữ TranslationChunk. Local Feeder re-upload cùng `clientUploadId`, Job được reset pending và resume phần thiếu.
- Lỗi vĩnh viễn khác/hết attempts xóa PDF và chunk; completed xóa PDF nhưng giữ Job/chunk.

## Lưu ý

AbortSignal dừng chờ ở client SDK/worker; theo đặc tính API, request Gemini đã tới dịch vụ có thể vẫn tính usage. Pipeline không nhận chunk mới và chờ các call đang bay settle trước khi chuyển job.
