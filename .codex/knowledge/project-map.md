# Bản đồ kiến trúc và luồng dữ liệu

> **Phân lớp trạng thái:** “cloud baseline” dưới đây là code `e442641` vẫn đang có,
> không phải service live (Render đang suspended). “P015 target” là thiết kế đã chốt
> nhưng chưa implement. Không trộn hai lớp khi sửa code hoặc chẩn đoán.

## Thành phần

| Khu vực | Trách nhiệm | Điểm vào/chính |
| --- | --- | --- |
| `med-translator-frontend/` | React UI, chọn/nhóm file, direct upload R2, SSE resync, preview/copy/download | `src/main.jsx` → `src/App.jsx` |
| `med-translator-backend/src/server.js` | Express, CORS, health/readiness, Mongo connect và khởi động queue | server HTTP |
| `routes/translateRoute.js` + `controllers/translateController.js` | public API, maintenance-token guard và hình dạng response | `/api/translate` |
| `services/uploadBatchService.js` + `r2Service.js` | manifest, presigned PUT, confirm bằng HEAD R2, abandoned item và batch reconcile | cloud upload |
| `services/queueManager.js` | claim atomic, lease, retry, circuit breaker, pool, cancel, cleanup, folder/stat API | persistent worker |
| `services/sourceService.js` + `workers/pdfWorker.js` | stream source R2 xuống file `.part` tạm, rename atomically, chia PDF theo trang | lúc xử lý job |
| Quality services | context passport, stage executor, scheduler key, state machine, quality public view/header | quality jobs |
| MongoDB | nguồn sự thật về upload, queue, lease, stage, artifact kết quả và cleanup retry | `Job`, `TranslationChunk`, `UploadBatch`, `System` |
| Cloudflare R2 | lưu source PDF trong khi upload/chờ/xử lý/retry | object storage |
| `archive/` | hồ sơ đã đóng, không có import runtime | chỉ đọc |
| `project-015/` | kế hoạch chuyển trọn runtime/data mới về Windows | tài liệu, chưa import runtime |

## Luồng cloud baseline hiện có

```text
Người dùng chọn PDF + folder (hoặc priority)
  → frontend tạo clientBatchId/clientUploadId ổn định
  → POST /upload-batches/prepare
  → backend tạo/reuse UploadBatch + Job(status=uploading, sourceState=prepared)
     và trả presigned PUT URL hữu hạn cho từng item
  → browser PUT PDF trực tiếp đến R2 (tối đa 4 PUT đồng thời)
  → POST /upload-batches/:batchId/confirm
  → backend HEAD object, kiểm size/ETag, chuyển Job sang pending/sourceState=ready
  → queue atomic claim theo priority, thời điểm tạo, ID
  → Job processing có processingToken + lease heartbeat
  → backend process stream R2 object xuống cache local tạm
  → PDF worker chia PDF thành chunk, mặc định 2 trang/chunk
  → quality: document_context một lần/job, rồi xử lý chunk
  → persist stage/kết quả từng chunk vào MongoDB
  → completed khi tất cả chunk terminal (passed hoặc needs_review)
  → xóa source R2 ngay khi completed/cancelled; lỗi xóa được retry bằng sweeper
  → frontend nhận SSE public; khi mất kết nối thì HTTP resync
```

Render URL cũ hiện bị suspend. Luồng trên chỉ chạy khi backend cloud tương thích được
deploy lại và cấu hình Atlas/R2/Gemini hợp lệ.

## P015 target chưa triển khai

```text
Browser cùng máy
  → Node/Express tại 127.0.0.1 phục vụ frontend + API
  → upload PDF thẳng vào D:\StudyMedData qua file .part + validation + atomic rename
  → MongoDB local mới giữ queue/lease/quota/stage/result
  → tối đa 3 source lane như Render; PDF parse/split chỉ 1 lane CPU tại một thời điểm
  → resource governor tạm dừng admission khi RSS/system RAM/CPU/disk bị áp lực
  → Gemini API qua Internet
  → restart/sleep recovery từ local lease/artifact
```

P015 giữ cloud adapter để tạo branch web về sau, nhưng local runtime mặc định không
được phụ thuộc Render, Vercel, R2 hoặc Atlas. Upload cap target 159 MB; workload nghiệm
thu chính khoảng 10 MB. Không khẳng định các behavior này tồn tại trước khi code/test.

### Quality pipeline

```text
document_context (một lần mỗi quality job)
  → translate → medical_audit → revise → verify
                                      ├─ PASS + coverage COMPLETE → passed/completed
                                      └─ FAIL → repair #1 → reverify
                                                       ├─ PASS + coverage COMPLETE → passed/completed
                                                       └─ FAIL → repair #2 → reverify
                                                                        └─ FAIL/coverage thiếu → needs_review
```

`needs_review` là terminal hợp lệ của chunk, không phải job `failed`. Job vẫn `completed`, giữ Markdown cuối và public header cảnh báo nêu phạm vi trang cần rà soát. Chỉ `PASS` cộng coverage `COMPLETE` được đếm là `passed`.

## Ranh giới dữ liệu và bảo mật

- Browser không nhận credential MongoDB, R2 hay Gemini. Trong cloud baseline, browser
  chỉ nhận presigned R2 URL từ backend và URL này được kiểm HTTPS/R2 domain trước PUT;
  P015 target không cấp R2 URL cho browser.
- Trong cloud baseline, R2 chứa PDF gốc có thời hạn; filesystem backend chỉ là cache
  tạm. Trong P015 target, filesystem dưới data root mới là source bền của local job,
  nhưng contract/path safety đó chưa có trong code.
- MongoDB giữ metadata/artifact để resume. SSE chỉ là tín hiệu thời gian thực, không phải nguồn trạng thái.
- API public chỉ trả summary, result cuối và public quality summary/header. Không trả PDF base64, prompt, draft, audit/reverify raw, context passport, API key hay stack trace.
- Quality text transient được dọn khi chunk passed; artifact review private chỉ phục vụ resume/triage. Header P004 được dựng lúc đọc, không ghi ngược vào `TranslationChunk.content`.

## Bất biến phải giữ khi sửa mã

1. Claim phải atomic và có compare-and-set; job worker cũ không được ghi đè worker mới sau lease recovery (`processingToken` và lease là hàng rào).
2. `priority=1` luôn đi trước `priority=0` đối với job đang eligible; thứ tự trong cùng priority là `createdAt`, rồi `_id`. Không preempt job đã `processing`.
3. Circuit breaker/hibernate và maintenance pause ngăn claim job mới, không làm mất Job/UploadBatch đã persist. Maintenance cho physical request hoàn tất rồi suspend ở ranh giới stage; không abort qua cleanup `CANCELLED`. Priority upload vẫn có thể prepare/PUT/confirm khi worker ngủ.
4. Lane song song chỉ được claim khi mọi active source có size hợp lệ và tổng source không vượt budget. Source size chỉ là proxy bảo thủ cho RAM, không phải số đo RAM.
5. `clientUploadId`, `clientBatchId` và storage key phải giữ idempotency cho prepare/confirm/retry. Không báo người dùng có thể đóng máy trước `canCloseClient=true`.
6. Job mới lưu Markdown theo `TranslationChunk.content`; `Job.result` chỉ còn compatibility legacy.
7. Mỗi stage quality persist atomically; pipeline-version mismatch chỉ reset chunk dở dang, không rewrite chunk terminal có content.
8. `repairCount` không quá 2; coverage thiếu không bao giờ thành PASS; revision/repair phải qua guard giữ ít nhất 80% meaningful text của bản trước.
9. Global rate-limit circuit phải được re-check ngay trước Gemini reservation/API call. Generic 429 không đủ để kết luận RPD hết hoặc IP bị block; không tăng concurrency/project pool để dò lỗi quota.
10. Preview, Copy và Download phải nhận cùng header review do backend dựng, tránh UI tự tái diễn giải report private.
11. Cleanup source phải idempotent. Failed job R2 giữ source đến `sourceRetentionUntil` để cho phép retry; completed/cancel/delete dọn sớm. Thất bại xóa R2 phải có state/retry thay vì bỏ quên object.
12. P015 local cleanup chỉ được xóa path đã resolve bên dưới data root; không chấp
   nhận symlink/junction/path traversal. Đây là planned invariant cần test trước cutover.

## Vòng đời trạng thái

| Đối tượng | Trạng thái quan trọng | Ý nghĩa |
| --- | --- | --- |
| Job | `uploading → pending → processing → completed` | happy path cloud upload và dịch |
| Job | `failed`, `cancelled` | terminal; failed R2 còn source hợp lệ có thể được retry qua endpoint bulk retry |
| Job source | `prepared`, `ready`, `delete_pending`, `deleted`, `missing` | tách state object R2 khỏi state dịch |
| UploadBatch | `uploading`, `ready`, `partial`, `failed`, `completed`, `cancelled` | `canCloseClient` chỉ true khi `ready` và toàn bộ file confirmed/skipped |
| Quality chunk | `pending`, `translated`, `audited`, `revised`, `verified`, `repaired`, `reverified`, `completed`, `needs_review` | stage resume theo chunk |
| Quality status | `pending`, `passed`, `needs_review` | summary công khai của chunk/job |

## Không thuộc runtime

Scripts migration/backup/reconcile/smoke là công cụ vận hành được gọi tay. `uploads/`
hiện là cache/tạm; P015 data root dự kiến nằm ngoài repository. `archive/` và
`project-015/` là tài liệu, không import hoặc build runtime từ đó.
