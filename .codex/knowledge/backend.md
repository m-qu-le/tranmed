# Backend

## Thành phần chính

- `src/config/env.js`: cấu hình runtime và P003; quality mặc định, 2 trang, HIGH, tối đa 2 repair.
- `src/services/uploadBatchService.js` + `r2Service.js`: prepare/confirm/abandon, presigned PUT, idempotency và cleanup R2.
- `src/services/sourceService.js`: stream một R2 source qua `.part`, kiểm byte rồi rename atomically.
- `src/services/queueManager.js`: atomic claim, lease, retry, circuit breaker, cancellation và phối hợp quality pipeline.
- `src/services/pdfService.js` + `src/workers/pdfWorker.js`: Worker cắt PDF 2 trang/chunk, giữ page range.
- `src/services/qualityDocumentContextService.js`: context passport toàn PDF một lần/job, persist để resume.
- `src/services/qualityPipelineState.js`: state machine `p003-v3`, strict PASS và tối đa hai repair/reverify.
- `src/services/qualityGeminiExecutors.js`: prompt/stage executor, structured validation, key scheduler và text coverage guard.
- `src/models/jobModel.js`, `translationChunkModel.js`, `uploadBatchModel.js`: metadata queue, artifact chất lượng và batch upload.

## API

Base `/api/translate`; health `/api/health`; readiness `/api/readiness`.

| Method | Path | Ghi chú |
| --- | --- | --- |
| POST | `/upload-batches/prepare` | Tạo/reuse manifest và presigned URL |
| POST | `/upload-batches/:batchId/confirm` | HEAD R2, xác nhận size/ETag, đưa job pending |
| POST | `/upload-batches/:batchId/abandon` | Bỏ item lỗi và dọn object |
| GET | `/upload-batches`, `/:batchId` | Resume trạng thái cloud batch |
| POST | `/` | Multipart legacy, một file/request; vẫn tương thích |
| GET | `/jobs?limit=&cursor=` | Cursor pagination, tối đa 200 |
| GET | `/jobs/:jobId/result` | JSON final Markdown + public quality summary |
| GET | `/jobs/:jobId/download` | Stream final Markdown theo chunk |
| GET | `/status`, `/metrics`, `/stream` | System state, telemetry công khai, SSE |
| DELETE | `/jobs/:jobId`, `/folder/:folderName` | Centralized cancellation/cleanup |
| POST | `/bulk-delete`, `/force-wakeup` | Xóa tối đa 500 ID; reset circuit breaker |

## Schema và vòng đời

- `Job` giữ source R2 state, upload batch, lease, mode/version, context passport, progress và warning.
- `TranslationChunk` unique `{jobId, chunkIndex}`; giữ page range, stage, reports, final `content`, `repairCount <= 2` và usage theo stage (`repair_2/reverify_2` khi cần).
- `UploadBatch` giữ manifest/progress để frontend resume và chỉ báo `canCloseClient` khi an toàn.
- Completed/failed/cancelled đều đi qua source cleanup; lỗi R2 deletion được persist để sweeper retry.

## Quality semantics

- Pipeline/prompt: `p003-v3` / `p003-prompts-v3`; context: `p003-context-v1`.
- Audit/verify JSON phải hợp schema; coverage thiếu không thể PASS.
- Mọi FAIL kể cả minor kích hoạt repair nếu còn cycle.
- Vòng hai sửa bản repaired theo reverify report mới nhất; sau vòng hai còn lỗi thành `needs_review`.
- PASS xóa full-text transient; needs-review giữ artifact chẩn đoán. Public API không lộ report/context.
