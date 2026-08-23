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
- `CLOUD_DIRECT_UPLOAD_RATE_LIMIT_PER_HOUR`: giới hạn upload PDF trực tiếp qua Render trên cloud, mặc định 120/giờ/IP. Luồng R2 batch không dùng giới hạn này.
- `CLOUD_UPLOAD_CONTROL_RATE_LIMIT_PER_HOUR`: giới hạn request prepare/confirm batch R2, mặc định 600/giờ/IP. Giữ mức này để chống abuse nhưng không chặn thư viện lớn.
- `R2_SOURCE_RETENTION_DAYS`: giữ source của job lỗi cuối trước khi app tự xóa, mặc định 7 ngày. Cấu hình Cloudflare R2 Lifecycle 8 ngày cho prefix source chỉ là hàng rào chống object mồ côi; app vẫn xóa source ngay khi hoàn thành hoặc khi người dùng dọn hàng đợi.
- `MAX_FILE_SIZE_MB`: giới hạn một PDF, mặc định 350 MB.
- `MAX_JOB_ATTEMPTS`: số lần xử lý tối đa của pipeline legacy, mặc định 3. Quality job dùng giới hạn 7 cho lỗi cấp tài liệu; lỗi nội dung cấp chunk dùng chính sách riêng bên dưới.
- `TRANSLATION_WORKER_CONCURRENCY`: chỉ nhận số nguyên từ `1` đến `3`, mặc định `3`.
- `PARALLEL_SOURCE_BUDGET_MB`: chỉ nhận số nguyên từ `10` đến `100`, mặc định `15`. Đây là tổng `sourceSize` của các job chạy song song, không phải RAM thực tế.
- `GEMINI_TIMEOUT_MS`: timeout một request Gemini, mặc định 180 giây.
- `GEMINI_MODEL`: mặc định `gemini-3.5-flash-lite`. Khi deploy, đặt rõ biến này trên Render; không dựa vào fallback để có thể truy vết model đang chạy.
- `MAINTENANCE_CONTROL_TOKEN`: mã riêng để tạm dừng hàng đợi trước redeploy; đặt một chuỗi ngẫu nhiên dài trên Render, không đặt trong biến `VITE_*` hay commit vào Git.
- `TRANSLATION_PIPELINE_MODE`: mặc định `quality` sau khi chủ dự án chốt B4; đặt rõ `legacy` để rollback.
- `PDF_PAGES_PER_CHUNK`: số trang mỗi chunk, mặc định 2.
- `GEMINI_THINKING_LEVEL`: P003 bắt buộc `HIGH` cho quality mode.
- `QUALITY_MAX_REPAIR_CYCLES`: từ 0 đến 2; mặc định 2. Không có vòng lặp vô hạn.

## Redeploy có kiểm soát

Sau khi mọi batch upload đã báo an toàn trên Cloud, chọn nút nhỏ **“Tạm dừng để redeploy”** ở góc trên trái, nhập `MAINTENANCE_CONTROL_TOKEN`, rồi chờ banner báo không còn job đang chạy. Khi đó có thể redeploy Render. Chế độ tạm dừng chỉ tồn tại trong instance cũ; server mới tự nhận queue và chạy bình thường, không cần bấm nút khởi động lại.

## Chẩn đoán Gemini trên Render Free

Khi Render không có Shell, có thể tạm bật `GEMINI_DIAGNOSTIC_PROBE_ENABLED=true`
và gọi `POST /api/translate/diagnostics/gemini-probe` với header
`X-Maintenance-Token`. Body chỉ nhận một trong hai model:

```json
{"model":"gemini-3.5-flash-lite"}
```

hoặc:

```json
{"model":"gemini-3.1-flash-lite"}
```

Probe dùng duy nhất key đầu tiên, gửi một PDF nhỏ tạo trong RAM và không ghi file,
MongoDB, R2 hay nội dung phản hồi. Endpoint mặc định tắt, giới hạn 4 request/giờ,
mỗi model có cooldown 5 phút và không bao giờ trả API key. Tắt lại biến môi trường
sau khi chẩn đoán xong.

## Thống kê và worker pool P008

- `GET /api/translate/jobs/stats` tổng hợp `pending`, `processing`, `completed`, `failed` trên toàn collection; phân trang `/jobs` không phải nguồn thống kê dashboard.
- `GET /api/translate/status` có thêm `worker.concurrency`, `worker.activeJobs`, `worker.activeSourceBytes` và `worker.parallelSourceBudgetBytes`; `GET /api/translate/jobs/active` trả tối đa ba file đang dịch với metadata progress an toàn cho dashboard local.
- Tối đa 3 lane có thể chạy đồng thời. Sau job đầu, lane tiếp theo chỉ nhận đúng job FIFO kế tiếp khi mọi job active có `sourceSize` hợp lệ và tổng không vượt `PARALLEL_SOURCE_BUDGET_MB`; job lớn hoặc thiếu size chạy một mình.
- Ngưỡng source bytes là proxy, không phải phép đo RAM thực. Nếu cần rollback tải xử lý, đặt rõ `TRANSLATION_WORKER_CONCURRENCY=2` và `PARALLEL_SOURCE_BUDGET_MB=10` (hoặc `1` / `10`), rồi restart Render.
- P008 không đổi schema và không cần migration.

## Kiểm tra và migration

```powershell
npm test
npm run test:coverage
npm audit
```

Sau khi đổi model hoặc SDK Gemini, chạy smoke khép kín sau. Script chỉ tạo PDF trong thư mục tạm, xóa Gemini File tạm trong `finally`, và không chạm MongoDB/R2/artifact lịch sử:

```powershell
npm run smoke:p010-gemini
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

Trước deploy chính sách lỗi nội dung theo chunk, dùng **“Tạm dừng để redeploy”** và chờ `worker.activeJobs=0`; migration thực thi sẽ từ chối chạy nếu MongoDB còn job `processing`. Sau đó chạy backup P003, dry-run và migration:

```powershell
$env:P003_BACKUP_DIR='D:\duong-dan-backup'
npm run backup:p003
npm run migrate:quality-content-failure:dry
npm run migrate:quality-content-failure
```

Migration này additive và idempotent: thêm `stageContentFailures`, đưa job quality đang chờ lỗi nội dung về cơ chế stage-deferred không tăng `attemptCount`, và đồng bộ `maxAttempts=7`. Với chunk cũ đang mắc lỗi nội dung, migration chỉ seed ở mức `2/3`; hệ thống vẫn yêu cầu thêm một lỗi thật sau deploy trước khi chuyển chunk sang `needs_review`. Migration không xóa hoặc reset draft, audit, revised content, report hay chunk đã terminal.

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
- Artifact mới dùng pipeline version `p010-v1`, prompt version `p003-prompts-v3` và context version `p003-context-v1`; đổi version sẽ reset riêng chunk dở, không rewrite chunk terminal. P010 dùng version mới để chunk dở của Gemini 3.1 không tiếp tục nửa chừng bằng Gemini 3.5.
- Context passport bị giới hạn kích thước, chỉ hỗ trợ nhất quán thuật ngữ; PDF chunk luôn là nguồn quyết định. Passport được persist một lần/job để resume không upload lại toàn PDF và không được trả qua API công khai.
- Audit/verify phải trả checklist coverage có trích đoạn nguồn–đích. Audit thiếu coverage sẽ xoay key; verify/reverify thiếu coverage kết thúc chunk ở `needs_review`, không được PASS.
- Mỗi `chunk + stage` có ngân sách riêng 3 lỗi nội dung đã thực sự phát request. Hai lỗi đầu backoff 5 và 15 phút; trong lúc chờ, dispatcher tiếp tục các chunk khác và có thể giải phóng source lane mà không tăng `attemptCount` của cả PDF. Lỗi 429/quota, suspension và lỗi trước khi phát request không tiêu ngân sách này.
- Khi stage chạm lỗi nội dung thứ ba, chunk chuyển `needs_review` với bản tốt nhất đã persist. Nếu ngay stage `translate` chưa có bản dịch nào, output chứa placeholder cảnh báo và page range rõ ràng thay vì âm thầm bỏ mất phần đó. Raw response, prompt và stack trace không được persist.
- Chỉ `content` cuối được trả qua result/download API. Draft, audit và verify report không public.
- Chỉ báo cáo cuối `PASS` với coverage đầy đủ mới được gắn `passed`. Mọi lỗi có bằng chứng, kể cả minor, đều kích hoạt repair; `repairCount <= 2`. Sau vòng hai vẫn FAIL thì chunk thành `needs_review` và UI cảnh báo page range.
- Revision/repair phải giữ tối thiểu 80% ký tự có nghĩa của bản trước. Output co rút bất thường bị xem là response lỗi để xoay project. Repair là bước cải thiện tùy chọn nên nếu toàn bộ rotation vẫn không tạo được output hợp lệ, pipeline giữ ngay bản revised đầy đủ và đặt `needs_review`; các stage bắt buộc khác áp dụng ngân sách 3 lỗi ở trên.
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
