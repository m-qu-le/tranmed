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
- `TRANSLATION_WORKER_CONCURRENCY`: chỉ nhận `1` hoặc `2`, mặc định `1`. Rollback tải xử lý bằng cách đặt lại `1` và restart Render.
- `GEMINI_TIMEOUT_MS`: timeout một request Gemini, mặc định 180 giây.
- `MAINTENANCE_CONTROL_TOKEN`: mã riêng để tạm dừng hàng đợi trước redeploy; đặt một chuỗi ngẫu nhiên dài trên Render, không đặt trong biến `VITE_*` hay commit vào Git.
- `TRANSLATION_PIPELINE_MODE`: mặc định `quality` sau khi chủ dự án chốt B4; đặt rõ `legacy` để rollback.
- `PDF_PAGES_PER_CHUNK`: số trang mỗi chunk, mặc định 2.
- `GEMINI_THINKING_LEVEL`: P003 bắt buộc `HIGH` cho quality mode.
- `QUALITY_MAX_REPAIR_CYCLES`: từ 0 đến 2; mặc định 2. Không có vòng lặp vô hạn.

## Redeploy có kiểm soát

Sau khi mọi batch upload đã báo an toàn trên Cloud, chọn nút nhỏ **“Tạm dừng để redeploy”** ở góc trên trái, nhập `MAINTENANCE_CONTROL_TOKEN`, rồi chờ banner báo không còn job đang chạy. Khi đó có thể redeploy Render. Chế độ tạm dừng chỉ tồn tại trong instance cũ; server mới tự nhận queue và chạy bình thường, không cần bấm nút khởi động lại.

## Thống kê và worker pool P005

- `GET /api/translate/jobs/stats` tổng hợp `pending`, `processing`, `completed`, `failed` trên toàn collection; phân trang `/jobs` không phải nguồn thống kê dashboard.
- `GET /api/translate/status` có thêm `worker.concurrency`, `worker.activeJobs`, `worker.activeSourceBytes` và `worker.parallelSourceBudgetBytes`; không công khai ID hay tên file active.
- Khi concurrency là `2`, lane thứ hai chỉ nhận đúng job FIFO kế tiếp nếu mọi job active có `sourceSize` hợp lệ và tổng không quá 10 MiB. Job lớn hoặc thiếu size chạy một mình.
- Ngưỡng source bytes là proxy bảo thủ cho RAM, không phải phép đo bộ nhớ thực. Chỉ bật production `2` sau canary hai PDF nhỏ và giữ peak RAM dưới 80% giới hạn instance.
- P005 không đổi schema và không cần migration. Rollback worker chỉ cần đặt `TRANSLATION_WORKER_CONCURRENCY=1` rồi restart.

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

Khi `TRANSLATION_PIPELINE_MODE=quality`, job tạo một context passport có cấu trúc từ toàn PDF rồi mỗi chunk 2 trang chạy tuần tự:

```text
document_context (một lần/job, Gemini File tạm được xóa sau khi dùng)
    ↓
translate → medical_audit → revise → verify
                                  ├ PASS + coverage COMPLETE → completed
                                  └ FAIL (kể cả minor) → repair 1 → reverify
                                                               ├ PASS + coverage COMPLETE → completed
                                                               └ FAIL → repair 2 → reverify
                                                                                  └ FAIL → needs_review
```

- Tối đa 2 chunk chạy đồng thời; trong một chunk không chạy stage song song.
- Mỗi stage persist atomically cùng `pipelineVersion`; restart tiếp tục từ stage kế tiếp.
- Artifact mới dùng pipeline version `p003-v3`, prompt version `p003-prompts-v3` và context version `p003-context-v1`; đổi version sẽ reset riêng chunk dở, không rewrite chunk terminal.
- Context passport bị giới hạn kích thước, chỉ hỗ trợ nhất quán thuật ngữ; PDF chunk luôn là nguồn quyết định. Passport được persist một lần/job để resume không upload lại toàn PDF và không được trả qua API công khai.
- Audit/verify phải trả checklist coverage có trích đoạn nguồn–đích. Audit thiếu coverage sẽ xoay key; verify/reverify thiếu coverage kết thúc chunk ở `needs_review`, không được PASS.
- Chỉ `content` cuối được trả qua result/download API. Draft, audit và verify report không public.
- Chỉ báo cáo cuối `PASS` với coverage đầy đủ mới được gắn `passed`. Mọi lỗi có bằng chứng, kể cả minor, đều kích hoạt repair; `repairCount <= 2`. Sau vòng hai vẫn FAIL thì chunk thành `needs_review` và UI cảnh báo page range.
- Revision/repair phải giữ tối thiểu 80% ký tự có nghĩa của bản trước. Output co rút bất thường bị xem là response lỗi để xoay key; nếu repair vẫn không hợp lệ sau rotation, pipeline giữ bản revised đầy đủ và đặt `needs_review`.
- Scheduler xoay 7 key theo request, giữ headroom 12 RPM/200k TPM/400 RPD mỗi key index, chuyển key ngay khi 429/invalid JSON/5xx và loại key 401/403.
- `/api/translate/metrics` trả counter key index, không trả giá trị key hay nội dung tài liệu.

### Cảnh báo kiểm soát chất lượng P004

Job quality đã hoàn thành nhưng có chunk `needs_review` sẽ nhận một khối cảnh báo ở đầu Markdown khi xem trước, copy hoặc tải file. Khối này nêu phần/trang cần đối chiếu, số vòng sửa, lỗi còn tồn tại trong báo cáo xác minh cuối, severity, coverage và trích đoạn nguồn–đích có sẵn. Đây là hỗ trợ rà soát; người đọc vẫn phải đối chiếu PDF gốc và không xem cảnh báo tự động là kết luận chuyên môn cuối cùng.

Header chỉ được dựng khi trả kết quả; không ghi vào `TranslationChunk.content`, nên resume/retry và artifact dịch chuẩn không đổi. Lỗi kỹ thuật ở bước repair chỉ lưu mã nguyên nhân có cấu trúc, không lưu raw response, prompt hoặc stack trace. Job legacy và job quality đạt toàn bộ tiếp tục trả nội dung như trước. P004 là thay đổi schema additive, nullable và không cần migration bắt buộc.

Khi rà soát thực tế, tìm đúng file PDF theo tên bản tải xuống, mở phần/trang ghi trong header, rồi so lần lượt `Nguồn PDF`, `Bản dịch hiện tại`, `Giải thích` và `Cần sửa`. Test P004 chỉ dùng fixture/mock thuần; không gọi PDF, Gemini, R2 hay MongoDB production.

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

Raw artifact benchmark đã được xóa khi P003 đóng. Báo cáo tổng hợp đã lọc nằm tại `archive/project-003/`; không chạy lại benchmark chỉ để tái tạo chúng. Rollback không cần migration ngược: đặt `TRANSLATION_PIPELINE_MODE=legacy` và restart; job mới quay về pipeline cũ, artifact quality đã persist không bị rewrite.

Sau deploy production, kiểm tra `/api/readiness`, chạy một batch close-safe qua restart có kiểm soát, rồi dùng `npm run reconcile:r2` xác nhận không còn object mồ côi.
