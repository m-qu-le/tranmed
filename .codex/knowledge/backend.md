# Backend: queue, API, storage và quality

> **Trạng thái 11-08-2026:** tài liệu phần lớn mô tả code cloud baseline `e442641`.
> Render đang suspended và P015 local-first chưa được triển khai. `src/server.js` vẫn
> bind `0.0.0.0`, yêu cầu Mongo/Gemini/R2 và khởi động cloud worker; không gọi đây là
> local runtime cho tới khi P015 thay đổi/test các contract đó.

## Khởi động

`src/server.js` nạp `runtimeConfig`, khởi tạo Gemini key scheduler, cấu hình CORS/body parser, đăng ký health/readiness và router `/api/translate`, rồi mới mở HTTP sau khi MongoDB kết nối. Sau Mongo connect, `translationQueue.initDB()` phục hồi lease hết hạn, dọn cancel dở, nạp trạng thái circuit breaker, quét local orphan, khởi chạy source-cleanup sweeper và worker; `uploadBatchService.startReconciler()` xử lý batch upload tồn đọng.

Startup fail-fast nếu thiếu Mongo/Gemini/R2 required env, R2 endpoint không HTTPS, hoặc `MAX_FILE_SIZE_MB >= MAX_UPLOAD_STORAGE_MB`. Không đưa secret vào thông báo lỗi public/log không redacted.

## Queue và khả năng phục hồi

- Job pending eligible có `sourceState=ready`; claim sắp theo `{ priority: -1, createdAt: 1, _id: 1 }`, sau đó CAS để tránh duplicate claim.
- Khi claim, job nhận `processingToken`, `leaseExpiresAt` và heartbeat gia hạn lease. Khởi động lại/lỗi worker chỉ phục hồi job processing khi lease hết hạn; worker cũ mất quyền ghi.
- `MAX_JOB_ATTEMPTS` kiểm soát retry xử lý. Queue phân loại infrastructure/content/terminal, đặt `nextRetryAt` và lập timer để thức dậy đúng hạn.
- Nếu key pool không cấp phát được, circuit breaker persist trạng thái hibernate trong `System`; wake-up tự động hoặc `/force-wakeup` sẽ chạy lại worker. Hibernation không chặn cloud upload. Quota pool exhaustion đi theo deadline authoritative của scheduler, không đợi bộ đếm retry job.
- `pauseForRedeploy()` ngừng claim mới/retry timer, cho physical request đang chạy hoàn tất rồi suspend job ở ranh giới stage về pending. API pause/cancel bắt buộc header `X-Maintenance-Token` khớp `MAINTENANCE_CONTROL_TOKEN` bằng `timingSafeEqual`; chỉ deploy khi status là `maintenanceState=drained` và active/waiting/processing đều bằng 0.
- Pool nhận strict từ 1 đến 3 job, fallback code là 3. Job đầu có thể chạy độc lập;
  lane tiếp chỉ nhận đúng job FIFO tiếp theo khi mọi active job có `sourceSize` hợp lệ
  và tổng không vượt `PARALLEL_SOURCE_BUDGET_BYTES`. Budget nhận 10–100 MiB, fallback
  15 MiB. Unknown/large source chặn parallel admission khi đã có active job, không bị
  bỏ qua vĩnh viễn.
- `sourceSize` chỉ là proxy cho RAM. Code hiện chưa có P015 RSS/system-CPU admission,
  PDF split serialization hay hard 50%-RAM governor. Các mục đó là target trong
  `../../project-015/`, không phải hành vi hiện hành.

## R2, upload batch và cleanup hiện hành

`UploadBatch` + `Job` tạo durable manifest trước khi browser upload. Manifest hiện nhận 1–500 PDF, mỗi file không vượt `MAX_FILE_SIZE_MB` và tổng batch không vượt 2 GiB. Prepare/repeat prepare với `clientBatchId`/`clientUploadId` phải reuse an toàn; confirm chỉ chuyển item sau khi backend HEAD object và so size/ETag. Abandon dùng cho item lỗi và cố gắng dọn object. Priority manifest là boolean: true ép folder reserved `Ưu tiên` và persist `priority=1`; client không thể giả priority bằng tên folder.

P015 dự kiến thêm `storageProvider=local` và MongoDB local, nhưng code baseline vẫn
bắt buộc cấu hình R2 khi startup. Endpoint multipart legacy có local file path không
đồng nghĩa P015 local storage/data-root safety đã hoàn thành.

Khi xử lý, `sourceService` stream object R2 xuống file `.part`, kiểm byte và rename atomically rồi mới PDF split; file local luôn được dọn trong `finally`. Completed, cancel và delete gọi `SourceCleanupService` ngay. Nếu delete R2 lỗi, Job chuyển `delete_pending`/`retry`, lưu retry deadline theo exponential backoff (tối đa 6 giờ) và sweeper 60 giây sẽ thử lại. Failed job có `sourceState=ready` được giữ theo `R2_SOURCE_RETENTION_DAYS` để UI có thể retry; sweeper sẽ dọn sau retention.

## Quality pipeline

Quality mode có version `p010-v1`, prompt version `p003-prompts-v3` và context `p003-context-v1`.

- Toàn PDF tạo document context một lần bằng Gemini Files API; file Gemini tạm phải được xóa trong `finally`. Context được persist private để resume, có giới hạn kích thước và chỉ là trợ giúp nhất quán thuật ngữ; chunk PDF là nguồn quyết định.
- PDF mặc định chia hai trang/chunk. Bên trong chunk stage tuần tự: translate → medical audit JSON → revise → verify JSON; tối đa hai chunk chạy song song trong một job.
- Text stage dùng 65,536 output tokens; context/audit/verify/reverify JSON dùng 16,384. Tất cả quality request dùng `thinkingLevel: HIGH`, `includeThoughts: false`; không gửi `temperature`, top-p/top-k, thinking budget hoặc candidate count.
- Scheduler xoay API key, theo dõi quota/cooldown/disabled và metadata không chứa key. 429, invalid JSON/schema và 5xx có thể xoay key; 401/403 disable key cho đến restart/reconfigure.
- Dispatcher tạo batch theo adaptive `limit`, không theo `maxLimit`. Năm project độc lập trả 429 trong 10 giây mở global rate-limit circuit; stage re-check gate ngay trước reservation/API call. Circuit backoff 60 giây → 2 → 4 → 8 → tối đa 10 phút, có jitter và cần 10 physical success liên tiếp để reset. State circuit cùng consecutive project 429/cooldown được persist để restart không tạo cold-start burst.
- Generic 429 không tự đánh dấu project RPD-exhausted. Cooldown project tăng dần khi provider không gửi `Retry-After`; admission chỉ chờ Pacific reset khi daily counter thực sự đạt configured RPD.
- Audit/verify JSON phải pass validator và coverage checklist. Verify/reverify `PASS` chỉ hợp lệ khi coverage `COMPLETE`; bất kỳ FAIL nào có thể repair tối đa hai vòng. Output revision/repair co rút dưới guard coverage 80% bị từ chối để không thay bản đầy đủ bằng bản mất nội dung.
- `needs_review` giữ final content tốt nhất hiện có. Nếu repair output invalid, reason private chỉ lưu mã lỗi cấu trúc, không lưu raw Gemini response/prompt. Job quality completed có review chunk nhận header Markdown P004 dựng khi đọc.

## API của cloud baseline

Base: `/api/translate`. API không có authentication người dùng; CORS, rate limit
upload, validation, request-size limit và không lộ dữ liệu private là boundary bắt
buộc nếu deploy web. Với P015, boundary dự kiến là loopback-only, nhưng code hiện vẫn
listen `0.0.0.0`; phải sửa và test trước khi coi an toàn trên máy cá nhân.

| Method | Path | Hành vi |
| --- | --- | --- |
| GET | `/api/health` | ping Mongo; heartbeat cơ bản |
| GET | `/api/readiness` | ping Mongo + HeadBucket R2; 503 nếu không ready |
| POST | `/upload-batches/prepare` | validate manifest, tạo/reuse batch/job và cấp presigned URLs |
| POST | `/upload-batches/:batchId/confirm` | xác nhận items trên R2, job ready trở thành pending |
| POST | `/upload-batches/:batchId/abandon` | bỏ item không upload được và cleanup object nếu có |
| GET | `/upload-batches`, `/:batchId` | resume batch cloud; list recent bị giới hạn bởi controller |
| POST | `/` | upload multipart legacy, tối đa một PDF/request |
| GET | `/capacity` | capacity upload cục bộ/legacy |
| GET | `/jobs?limit=&cursor=` | summary toàn cục, cursor ObjectId, limit 1–200 |
| GET | `/folders/:folderName/jobs?limit=&cursor=` | lazy-load summary folder, limit 1–100; priority folder lọc theo `priority=1` |
| GET | `/jobs/stats` | aggregate toàn collection: bốn trạng thái, folder catalog và cloud totals |
| GET | `/jobs/terminal-failures` | failed jobs với retry advice/public retryability |
| POST | `/jobs/retry-terminal` | thử lại failed R2 còn source ready và error retryable |
| GET | `/jobs/:jobId/result` | final Markdown + public quality summary; prepend P004 header khi cần |
| GET | `/jobs/:jobId/download` | stream cùng final Markdown/header, attachment `.md` |
| DELETE | `/jobs/:jobId`, `/folder/:folderName` | cancel/delete; processing trả pending cleanup semantics |
| POST | `/bulk-delete` | cancel/delete tối đa 500 job IDs khác nhau |
| GET | `/status`, `/metrics`, `/gemini-keys/status` | queue/storage/maintenance status, in-memory metrics, key status đã redacted |
| GET | `/stream` | SSE: connected, public job update/log, system status, batch status, source cleanup; heartbeat 15 giây |
| POST | `/force-wakeup` | đánh thức circuit breaker nếu đang hibernate |
| POST | `/maintenance/pause`, `/maintenance/cancel` | maintenance control có token, không phải public action |

`/jobs` và `/folders/.../jobs` dùng cursor `_id` tăng dần; đây là pagination danh sách chứ không phải số liệu dashboard. `/jobs/stats` là nguồn total/folder count.

## MongoDB schema cần biết

- `Job`: identity/name/folder/priority; queue and lease fields; storage/source cleanup state; retry/failure info; quality aggregate/context; `result` legacy. Index claim chính là `{ status, priority, createdAt, _id }`.
- `TranslationChunk`: unique `{jobId, chunkIndex}`, page range, pipeline/prompt version, stage, private artifacts, final `content`, `repairCount <= 2`, final quality status/reason và usage metadata.
- `UploadBatch`: unique `batchId`, optional unique `clientBatchId`, manifest counters/status/priority. Virtual `canCloseClient` chỉ true khi batch ready và all items confirmed/skipped.
- `System`: queue hibernation state/timing persist qua restart.
- `GeminiQuotaState`: rolling quota events, daily counts, cooldown và consecutive rate-limit streak theo stable project ID; không chứa API key.
- `GeminiSchedulerState`: group cursor và global rate-limit circuit deadline/reason/backoff/open count.

Không đổi enum/index hoặc xóa field trước khi truy tất cả caller, migration lịch sử và khả năng đọc job legacy. Migration P001–P003 có sẵn nhưng chỉ được chạy theo quy trình `operations.md`.
