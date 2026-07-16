# StudyMed Translator — Backend

Express/MongoDB backend với persistent queue, atomic job lease, PDF Worker Thread, Gemini key rotation, retry có phân loại lỗi và kết quả lưu theo chunk.

## Chạy local

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Điền `MONGODB_URI`, `GEMINI_API_KEYS` và các biến `R2_*` theo `.env.example` trong `.env`. Không commit file này.

Các giới hạn quan trọng:

- `MAX_UPLOAD_STORAGE_MB`: ngân sách disk cho PDF tạm, mặc định 400 MB.
- `MAX_FILE_SIZE_MB`: giới hạn một PDF, mặc định 350 MB.
- `MAX_JOB_ATTEMPTS`: số lần xử lý tối đa, mặc định 3.
- `GEMINI_TIMEOUT_MS`: timeout một request Gemini, mặc định 180 giây.
- `TRANSLATION_PIPELINE_MODE`: `legacy` trong rollout đầu; chỉ chuyển `quality` sau benchmark/canary.
- `PDF_PAGES_PER_CHUNK`: số trang mỗi chunk, mặc định 2.
- `GEMINI_THINKING_LEVEL`: P003 bắt buộc `HIGH` cho quality mode.
- `QUALITY_MAX_REPAIR_CYCLES`: 0 hoặc 1; mặc định 1 để không tạo vòng lặp repair vô hạn.

## Kiểm tra và migration

```powershell
npm test
npm run test:coverage
npm audit
```

Trước lần deploy P001 đầu tiên, mặc định cần backup nếu database có dữ liệu, sau đó chạy:

```powershell
npm run migrate:p001:dry
npm run migrate:p001
npm run verify:p001
```

Migration có tính idempotent và đồng bộ index cho Job, System và TranslationChunk. Riêng đợt P001 ngày 15-07-2026, chủ dự án cho phép bỏ qua backup sau khi dry-run xác nhận cả `jobs`, `systems` và `translationChunks` đều có 0 document; migration và verification production đã hoàn thành thành công.

Trước migration P002, đặt thư mục backup ngoài repository rồi chạy:

```powershell
$env:P002_BACKUP_DIR='D:\duong-dan-backup'
npm run backup:p002
npm run migrate:p002:dry
npm run migrate:p002
```

P002 upload trực tiếp PDF vào R2 bằng presigned URL, MongoDB giữ trạng thái queue, còn Render chỉ stream một source về disk tạm khi xử lý. Các lệnh `benchmark:p002-source`, `benchmark:p002-upload` và `reconcile:r2` lần lượt kiểm tra streaming, throughput R2 và object mồ côi.

Trước deploy P003, sao lưu ra ngoài repository và chạy migration additive:

```powershell
$env:P003_BACKUP_DIR='D:\duong-dan-backup'
npm run backup:p003
npm run migrate:p003:dry
npm run migrate:p003
```

P003 không rewrite nội dung cũ. Migration chỉ đếm dữ liệu và đồng bộ index của `Job`/`TranslationChunk`; job legacy không có quality artifact vẫn preview/download như trước.

## Quality pipeline P003

Khi `TRANSLATION_PIPELINE_MODE=quality`, mỗi chunk 2 trang chạy tuần tự:

```text
translate → medical_audit → revise → verify
                                  └ FAIL critical/major → repair → reverify
                                                               └ FAIL → needs_review
```

- Tối đa 2 chunk chạy đồng thời; trong một chunk không chạy stage song song.
- Mỗi stage persist atomically cùng `pipelineVersion`; restart tiếp tục từ stage kế tiếp.
- Artifact hiện dùng pipeline version `p003-v1` và prompt version `p003-prompts-v1`; đổi version sẽ reset riêng chunk dở, không rewrite chunk terminal.
- Chỉ `content` cuối được trả qua result/download API. Draft, audit và verify report không public.
- `repairCount <= 1`; `needs_review` vẫn hoàn thành job nhưng UI cảnh báo chunk và page range.
- Revision/repair phải giữ tối thiểu 80% ký tự có nghĩa của bản trước. Output co rút bất thường bị xem là response lỗi để xoay key; nếu repair vẫn không hợp lệ sau rotation, pipeline giữ bản revised đầy đủ và đặt `needs_review`.
- Scheduler xoay 7 key theo request, giữ headroom 12 RPM/200k TPM/400 RPD mỗi key index, chuyển key ngay khi 429/invalid JSON/5xx và loại key 401/403.
- `/api/translate/metrics` trả counter key index, không trả giá trị key hay nội dung tài liệu.

Benchmark và fixture audit:

```powershell
npm run benchmark:p003:batch:dry
npm run benchmark:p003:batch
npm run benchmark:p003:analyze
npm run benchmark:p003:audit-fixtures
npm run benchmark:p003:readiness
npm run benchmark:p003:full:dry
npm run benchmark:p003:full
npm run benchmark:p003:full:analyze
npm run benchmark:p003:review-bundle
```

Raw artifact nằm trong `.p003-local/` ignored. Full-corpus runner checkpoint sau từng chunk và mặc định skip artifact đúng version/input/coverage khi resume. Lệnh `review-bundle` tạo 14 phiếu local gồm PDF đúng page range, bản dịch cuối và finding critical/major; không commit bundle. Báo cáo tổng hợp ở `cline_docs/project-003-benchmark-review.md`, `cline_docs/project-003-performance-resource.md` và `cline_docs/project-003-full-corpus-report.md`. Rollback không cần migration ngược: đặt `TRANSLATION_PIPELINE_MODE=legacy` và restart; job mới quay về pipeline cũ, artifact quality đã persist không bị rewrite.

Sau deploy production, kiểm tra `/api/readiness`, chạy một batch close-safe qua restart có kiểm soát, rồi dùng `npm run reconcile:r2` xác nhận không còn object mồ côi.
