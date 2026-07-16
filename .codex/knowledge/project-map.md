# Bản đồ dự án

StudyMed Translator nhận batch PDF y khoa, upload trực tiếp lên Cloudflare R2, dịch toàn văn sang Markdown tiếng Việt bằng Gemini và cho phép preview/copy/download kết quả.

| Khu vực | Vai trò | Điểm vào |
| --- | --- | --- |
| `med-translator-backend/` | Express API, MongoDB queue, R2 source, PDF Worker, Gemini quality pipeline | `src/server.js` |
| `med-translator-frontend/` | React/Vite, Cloud Uploader, SSE, warning và tải Markdown | `src/main.jsx` → `src/App.jsx` |
| `.codex/knowledge/` | Kiến thức bền vững cho Codex | file này |
| `cline_docs/` | Báo cáo P003 đã lọc nội dung | `project-003-production-long-canary-analysis.md` |
| `project 003.md` | Hồ sơ quyết định và đóng PROJECT 003 | root |

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
  → tối đa 2 chunk chạy đồng thời; mỗi chunk tuần tự:
       translate → audit → revise → verify
         PASS + coverage COMPLETE → completed
         FAIL bất kỳ severity → repair 1 → reverify
           FAIL + coverage COMPLETE → repair 2 → reverify
           vẫn FAIL/coverage thiếu → needs_review
  → persist sau từng stage; final luôn ở TranslationChunk.content
  → completed khi mọi chunk passed hoặc needs_review
  → xóa source R2; cleanup lỗi được persist cho sweeper retry
  → SSE phát stage/progress/warning; preview/download chỉ ghép content cuối
```

## Bất biến phải giữ

- Claim Job atomic; processing token + lease ngăn worker cũ ghi đè worker mới.
- Chỉ báo có thể đóng tab khi backend xác nhận batch an toàn trên R2.
- `clientUploadId`, `clientBatchId` và storage key UUID giữ prepare/confirm/retry idempotent.
- Job mới không lưu toàn bộ Markdown trong `Job.result`; field này chỉ phục vụ legacy.
- Artifact persist cùng `pipelineVersion`; mismatch reset chunk dở nhưng không chạm chunk terminal.
- `repairCount <= 2`; vòng hai dùng bản repaired và reverify report mới nhất.
- Chỉ PASS + coverage COMPLETE mới là `passed`; `needs_review` vẫn có final download và page-range warning.
- Revision/repair có text coverage guard 80%; output co rút bất thường không được thay bản đầy đủ hơn.
- Result API/SSE không public draft, context passport, audit/verify excerpt, PDF base64, key hay toàn prompt.
- Một key 429 được key khác cứu không làm tăng circuit failure toàn cục.
- Cancel kiểm AbortSignal và processing token trước/sau stage; cleanup dọn source và chunk đúng semantics.

## Cấu hình P003

- `TRANSLATION_PIPELINE_MODE=quality` là mặc định; `legacy` chỉ là đường rollback.
- `PDF_PAGES_PER_CHUNK=2`, `GEMINI_THINKING_LEVEL=HIGH`, temperature quality = 1.
- `QUALITY_MAX_REPAIR_CYCLES=2`, không cho giá trị lớn hơn 2.
- Scheduler headroom: 12 RPM, 200k TPM, 400 RPD/key index; counter RAM chỉ để quan sát.
- Raw PDF/benchmark/bản dịch nằm trong `samplepdf/` hoặc `.p003-local/` và không được commit.
