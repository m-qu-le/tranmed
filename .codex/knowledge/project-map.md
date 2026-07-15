# Bản đồ dự án

StudyMed Translator nhận hàng loạt PDF y khoa, upload trực tiếp lên Cloudflare R2, dịch toàn văn sang Markdown tiếng Việt bằng Gemini và cho phép xem, copy hoặc tải kết quả.

| Khu vực | Vai trò | Điểm vào |
| --- | --- | --- |
| `med-translator-backend/` | Express API, MongoDB queue, R2 source, PDF Worker, Gemini quality pipeline | `src/server.js` |
| `med-translator-frontend/` | React/Vite, Cloud Uploader, SSE, warning và tải Markdown | `src/main.jsx` → `src/App.jsx` |
| `.codex/knowledge/` | Kiến thức bền vững cho Codex | file này |
| `cline_docs/` | Baseline/manifest/báo cáo benchmark đã lọc nội dung | `project-003-benchmark-review.md` |
| `project 003.md` | Kế hoạch, checklist, cổng benchmark và rollout P003 | root |

## Luồng hiện hành

```text
React lập upload batch (tối đa 200 PDF)
  → backend cấp presigned PUT URL và Job uploading
  → browser PUT trực tiếp lên R2, concurrency 4
  → confirm size/ETag; batch close-safe khi mọi item confirmed/skipped
  → atomic claim pending → processing + processingToken + lease
  → Render stream đúng một R2 object về file .part, rename atomically
  → PDF Worker cắt 2 trang/chunk và trả page range
  → legacy mode: tối đa 2 Gemini translation call đồng thời
  → quality mode: tối đa 2 chunk; từng chunk chạy tuần tự
       translate → audit → revise → verify → repair tối đa một lần → reverify
  → persist TranslationChunk sau từng stage; final luôn ở content
  → completed khi mọi chunk passed hoặc needs_review
  → xóa source R2; cleanup lỗi được persist để sweeper retry
  → SSE phát stage/progress/warning; reconnect resync /status + /jobs
  → preview/copy/download chỉ ghép content cuối
```

## Bất biến phải giữ

- Claim Job là atomic; processing token + lease ngăn worker cũ ghi đè worker mới.
- Browser chỉ được báo có thể đóng khi backend xác nhận toàn batch an toàn trên R2.
- `clientUploadId`, `clientBatchId` và storage key UUID giữ prepare/confirm/retry idempotent.
- Job mới không lưu toàn bộ Markdown vào `Job.result`; field này chỉ đọc dữ liệu legacy.
- Quality stage persist cùng `pipelineVersion`; version mismatch reset chunk dở nhưng không chạm final content.
- `repairCount <= 1`; `needs_review` là terminal có cảnh báo, không phải lỗi làm mất download.
- Result API/SSE không public draft, audit excerpt, verify report, PDF base64, key hoặc toàn bộ prompt.
- Chỉ lỗi toàn key/quota cuối cùng mới tăng circuit counter; một key 429 được key khác cứu không làm hệ thống ngủ.
- Cancel kiểm AbortSignal và processing token trước/sau stage; cleanup xóa toàn bộ TranslationChunk và source.
- SSE có thể mất event; frontend luôn resync `/status`, `/jobs` và upload batches khi reconnect.

## Cấu hình và rollback P003

- Rollout đầu giữ `TRANSLATION_PIPELINE_MODE=legacy`.
- Quality mode bắt buộc 2 trang/chunk, thinking `HIGH`, temperature 1 và tối đa một repair.
- Scheduler headroom: 12 RPM, 200k TPM, 400 RPD/key index; counter RAM chỉ phục vụ quan sát.
- Rollback: đổi mode về `legacy` và restart. Không migration ngược hoặc rewrite artifact.
- PDF nguồn, raw benchmark, bản dịch và blind answer key chỉ nằm trong `samplepdf/` hoặc `.p003-local/`, đều Git ignored.

## Quy ước

- JavaScript ESM, async filesystem, controller mỏng và logic vòng đời nằm trong service.
- Dùng UUID cho ID/storage key; tên gốc chỉ để hiển thị và tên download.
- Migration production phải có dry-run, backup khi collection có dữ liệu và hậu kiểm count/index.
- Không bật quality mặc định chỉ dựa trên self-judge của Gemini; cần duyệt blind review và canary.
