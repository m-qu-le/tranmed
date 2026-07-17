# Bản đồ dự án

StudyMed Translator nhận batch PDF y khoa, upload trực tiếp lên Cloudflare R2, dịch toàn văn sang Markdown tiếng Việt bằng Gemini và cho phép preview/copy/download kết quả.

| Khu vực | Vai trò | Điểm vào |
| --- | --- | --- |
| `med-translator-backend/` | Express API, MongoDB queue, R2 source, PDF Worker, Gemini quality pipeline | `src/server.js` |
| `med-translator-frontend/` | React/Vite, Cloud Uploader, SSE, warning và tải Markdown | `src/main.jsx` → `src/App.jsx` |
| `.codex/knowledge/` | Kiến trúc, vận hành và bất biến bền vững cho Codex | file này |
| `archive/project-003/` | Báo cáo lịch sử P003 đã lọc nội dung; không phải runtime | `project-003-production-long-canary-analysis.md` |
| `archive/project-004/` | Hồ sơ cảnh báo kiểm soát chất lượng đã đóng; không phải runtime | `project-004.md` |
| `archive/project-005/` | Hồ sơ thống kê toàn cục và worker hai lane đã đóng; không phải runtime | `project-005.md` |
| `archive/project-001/`–`archive/project-005/` | Hồ sơ năm dự án đã đóng | `project-00x.md` |

## Luồng hiện hành

```text
React tạo upload batch (tối đa 200 PDF)
  → backend cấp presigned PUT URL + Job uploading
  → browser PUT trực tiếp lên R2, concurrency 4
  → backend confirm size/ETag; canCloseClient khi mọi item confirmed/skipped
  → atomic claim pending → processing + processingToken + lease
  → Render stream một R2 object về file .part rồi rename atomically
  → PDF Worker cắt 2 trang/chunk và trả page range
  → quality: tạo context passport toàn PDF một lần/job
  → worker mặc định code là 1 job; production hiện cấu hình 2 và chỉ admission job FIFO thứ hai khi tổng source ≤ 10 MiB
  → trong mỗi job, tối đa 2 chunk chạy đồng thời; mỗi chunk tuần tự:
       translate → audit → revise → verify
         PASS + coverage COMPLETE → completed
         FAIL bất kỳ severity → repair 1 → reverify
           FAIL + coverage COMPLETE → repair 2 → reverify
           vẫn FAIL/coverage thiếu → needs_review
  → persist sau từng stage; final luôn ở TranslationChunk.content
  → completed khi mọi chunk passed hoặc needs_review
  → P004 dựng header rà soát từ report cuối khi Preview/Copy/Download
  → xóa source R2; cleanup lỗi được persist cho sweeper retry
  → SSE phát stage/progress/warning; header không được ghi ngược vào content
```

## Bất biến phải giữ

- Claim Job atomic; processing token + lease ngăn worker cũ ghi đè worker mới.
- Worker pool không vượt cấu hình `1|2`; job lớn/không rõ size chạy đơn và lane hai không bỏ qua FIFO.
- Chỉ báo có thể đóng tab khi backend xác nhận batch an toàn trên R2.
- `clientUploadId`, `clientBatchId` và storage key UUID giữ prepare/confirm/retry idempotent.
- Job mới không lưu toàn bộ Markdown trong `Job.result`; field này chỉ phục vụ legacy.
- Artifact persist cùng `pipelineVersion`; mismatch reset chunk dở nhưng không chạm chunk terminal.
- `repairCount <= 2`; vòng hai dùng bản repaired và reverify report mới nhất.
- Chỉ PASS + coverage COMPLETE mới là `passed`; `needs_review` vẫn có final download và page-range warning.
- Preview, Copy và Download phải dùng cùng header P004, dựng tại thời điểm đọc và không làm thay đổi artifact đã persist.
- Revision/repair có text coverage guard 80%; output co rút bất thường không được thay bản đầy đủ hơn.
- Result API chỉ public phần report đã chọn và escape trong header P004; SSE không public draft, context passport, audit/verify excerpt, PDF base64, key hay toàn prompt.
- Một key 429 được key khác cứu không làm tăng circuit failure toàn cục.
- Cancel kiểm AbortSignal và processing token trước/sau stage; cleanup dọn source và chunk đúng semantics.

## Ranh giới runtime

- Frontend không giữ secret R2/Gemini/MongoDB; chỉ nhận presigned URL hữu hạn từ backend.
- MongoDB là nguồn sự thật cho batch, job, lease, stage và cleanup retry. SSE chỉ là tín hiệu; reconnect luôn resync qua HTTP.
- R2 là nguồn PDF bền vững trong lúc chờ/xử lý. Filesystem Render chỉ là cache tạm của đúng source đang chạy và có thể mất bất kỳ lúc nào.
- Gemini được gọi trong backend. Mỗi chunk chạy stage tuần tự; concurrency chỉ nằm giữa tối đa hai chunk và trong pool upload phía browser.
- Kết quả public chỉ lấy `TranslationChunk.content`; report/context/artifact trung gian là private và được dọn khi có thể.

## Cấu hình P003

- `TRANSLATION_PIPELINE_MODE=quality` là mặc định; `legacy` chỉ là đường rollback.
- `PDF_PAGES_PER_CHUNK=2`, `GEMINI_THINKING_LEVEL=HIGH`, temperature quality = 1.
- `QUALITY_MAX_REPAIR_CYCLES=2`, không cho giá trị lớn hơn 2.
- Scheduler headroom: 12 RPM, 200k TPM, 400 RPD/key index; counter RAM chỉ để quan sát.
- `samplepdf/` là dữ liệu đầu vào local của người dùng và không được commit. `.p003-local/` là artifact benchmark đã xóa khi đóng dự án; không tái tạo nếu chưa mở công việc benchmark mới.

## Phần không thuộc runtime

- `archive/project-001/`–`archive/project-005/` là bằng chứng/quyết định lịch sử, không được import bởi ứng dụng.
- `scripts/migrate-*`, `backup-*`, `reconcile-r2.js` và smoke scripts là công cụ vận hành chủ động, không chạy trong server.
- Unit/regression test được giữ vì khóa các bất biến production. Harness benchmark P002/P003 một lần và test riêng của chúng đã được xóa.
