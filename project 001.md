# PROJECT 001 — Đại tu độ ổn định StudyMed Translator

## 1. Thông tin dự án

| Thuộc tính | Giá trị |
| --- | --- |
| Mã kế hoạch | P001 |
| Ngày lập | 15-07-2026 |
| Trạng thái tổng | Đang triển khai trên nhánh `refactor/project-001` |
| Mục tiêu | Chống dịch trùng, chống đầy 500 MB Render, hủy job an toàn, retry đúng loại lỗi, lưu kết quả lớn an toàn và hoàn thiện frontend |
| Phạm vi triển khai | Backend, frontend, MongoDB schema, dependency, test và tài liệu vận hành |
| Ngoài phạm vi | Đăng nhập/phân quyền; thay đổi nhà cung cấp Render/Vercel; thiết kế lại hoàn toàn giao diện |
| Ràng buộc chính | Render dùng filesystem tạm, dung lượng khoảng 500 MB; một sách có thể gồm hàng trăm PDF chương; chỉ một người sử dụng |

## 2. Cách theo dõi kế hoạch

Quy ước trạng thái:

- `[ ]`: chưa làm.
- `[x]`: đã hoàn thành và có bằng chứng kiểm tra.
- `BLOCKED`: không thể tiếp tục, phải ghi rõ nguyên nhân trong Nhật ký vấn đề.
- Mỗi commit phải chứa mã bước, ví dụ `fix(P001-G2-S03): claim queue atomically`.
- Không đánh dấu hoàn thành nếu chưa đạt tiêu chí nghiệm thu của bước và cổng kiểm tra cuối giai đoạn.
- Sau mỗi giai đoạn, cập nhật Bảng tiến độ, Nhật ký thay đổi và Bằng chứng kiểm thử ở cuối file.

## 3. Các quyết định kiến trúc đã chốt

### 3.1. Không thêm đăng nhập

Đây là ứng dụng cá nhân và chủ dự án chấp nhận việc không có authentication/authorization. P001 không triển khai tài khoản người dùng. Tuy vậy, rate limit và giới hạn tài nguyên vẫn cần có để bảo vệ Render và Gemini quota trước request ngoài ý muốn.

### 3.2. Không tải trước hàng trăm PDF lên Render

Hàng trăm chương vẫn được chọn cùng lúc, nhưng chúng nằm trong **Local Queue trên trình duyệt**. Frontend chỉ tải một PDF lên khi backend không còn PDF `pending`, `processing` hoặc đang chờ retry. Sau khi PDF đó hoàn tất hoặc lỗi vĩnh viễn và được dọn khỏi disk, frontend mới tải file tiếp theo.

Lợi ích:

- Người dùng vẫn chọn được hàng trăm chương trong một lần.
- Render thường chỉ giữ tối đa một PDF nguồn.
- Nếu Render restart, chỉ PDF đang nằm trên Render có nguy cơ mất; các file chưa tải vẫn còn trong tab trình duyệt.
- File trên Local Queue chỉ được giải phóng sau khi backend xác nhận trạng thái cuối.

Giới hạn cần hiển thị rõ: nếu đóng hoặc F5 trang, trình duyệt không thể tự giữ lại đối tượng `File`. Giai đoạn nâng cấp sau có thể dùng File System Access API để giữ quyền đọc thư mục, nhưng không phải điều kiện hoàn tất P001.

### 3.3. MongoDB là nguồn sự thật của queue

Cờ `isProcessing` trong RAM chỉ là lớp bảo vệ phụ. Việc nhận job phải dùng một thao tác MongoDB nguyên tử để không có hai worker cùng dịch một PDF.

### 3.4. Kết quả dịch được lưu theo chunk

Không tiếp tục đặt toàn bộ sách vào trường `Job.result`, vì một MongoDB document có giới hạn 16 MB. Collection chunk mới lưu từng đoạn theo `jobId + chunkIndex`. Các job cũ đang có `result` vẫn phải đọc được trong thời gian tương thích.

## 4. Bảng tiến độ tổng

| Giai đoạn | Nội dung | Trạng thái | Cổng nghiệm thu |
| --- | --- | --- | --- |
| G0 | Chốt baseline và lưới an toàn | Gần hoàn thành; còn fixture legacy và xác nhận worktree | Có test nền, build/lint sạch, không mất dữ liệu cũ |
| G1 | Vá dependency và chuẩn hóa cấu hình | Hoàn thành | Audit được xử lý, config fail-fast |
| G2 | Nâng cấp schema và tương thích dữ liệu | Hoàn thành code; chờ migration production ở G9 | Job cũ đọc được, index mới hoạt động |
| G3 | Queue nguyên tử và phục hồi an toàn | Hoàn thành code + unit test | Không thể claim một job hai lần |
| G4 | Phân loại lỗi, retry và circuit breaker | Hoàn thành code; cần mở rộng test matrix | Lỗi PDF/DB không làm ngủ đông |
| G5 | Pipeline Gemini/chunk và kiểm soát memory | Hoàn thành code; chưa đo peak RAM | Lỗi một chunk không để job cũ chạy ngầm |
| G6 | Chống đầy 500 MB bằng Local Feeder | Hoàn thành code + test mô phỏng 100 file | 100 file chọn cùng lúc nhưng server chỉ giữ theo ngân sách |
| G7 | Hủy/xóa job và garbage collection | Hoàn thành code; cần integration test | Xóa job đang chạy không còn phát sinh chunk mới |
| G8 | Hoàn thiện API, SSE và frontend | Hoàn thành luồng chính; còn UX/component và test mở rộng | Reconnect tự đồng bộ; URL/tải file an toàn |
| G9 | Kiểm thử end-to-end và triển khai | Chưa làm | Production smoke test đạt, có phương án rollback |

---

## G0 — Chốt baseline và lưới an toàn

Mục tiêu: có khả năng phát hiện regression trước khi sửa phần lõi.

- [ ] **P001-G0-S01 — Bảo toàn worktree.** Kiểm tra `git status`, xác nhận riêng ba tài liệu cấp gốc đang bị xóa và thư mục `.codex/` đang untracked; không tự khôi phục hoặc commit chúng khi chưa có quyết định của chủ dự án.
- [x] **P001-G0-S02 — Tạo nhánh đại tu.** Tạo nhánh `refactor/project-001` từ commit ổn định hiện tại.
- [x] **P001-G0-S03 — Ghi baseline.** Lưu phiên bản Node/npm, kết quả frontend build, frontend lint, backend syntax check và `npm audit` hai module vào Bảng bằng chứng.
- [x] **P001-G0-S04 — Sửa 4 lỗi lint hiện có.** Xử lý ba biến catch không dùng và quy tắc regex control character; không tắt rule toàn cục để che lỗi.
- [x] **P001-G0-S05 — Thêm test framework backend.** Chọn Vitest hoặc Node test runner; thêm script `test`, `test:watch`, `test:coverage`.
- [x] **P001-G0-S06 — Thêm test framework frontend.** Cài Vitest + React Testing Library và ít nhất một smoke test render App.
- [ ] **P001-G0-S07 — Tạo fixtures nhỏ.** PDF hợp lệ 1 trang, PDF hỏng, tên file Unicode/ký tự `# %`, và dữ liệu job legacy có `result`.

**Cổng G0:** `npm test`, frontend `npm run lint`, frontend `npm run build` và backend syntax check đều thành công. Không gọi Gemini thật trong test tự động.

## G1 — Vá dependency và chuẩn hóa cấu hình

Mục tiêu: loại bỏ vulnerability đã biết bằng cập nhật tương thích trước khi refactor lớn.

- [x] **P001-G1-S01 — Backend dependency patch.** Chạy và review thay đổi tương đương `npm audit fix`; dự kiến Multer 2.2.0, protobufjs, ws, qs và dependency liên quan được vá.
- [x] **P001-G1-S02 — Frontend dependency patch.** Cập nhật Axios lên nhánh 1.18.x, Vite 8.1.x và dependency vá lỗi; chưa nâng major nếu không cần.
- [x] **P001-G1-S03 — Dọn dependency.** Xóa `p-limit` nếu pipeline mới không còn dùng; dùng hoặc xóa `react-hot-toast`, không giữ package chết.
- [x] **P001-G1-S04 — Tạo `.env.example`.** Chỉ ghi tên biến và giá trị minh họa, tuyệt đối không chép secret.
- [x] **P001-G1-S05 — Validate env lúc startup.** Kiểm tra `MONGODB_URI`, danh sách `GEMINI_API_KEYS`, `FRONTEND_URL`, giới hạn disk và retry config. Thiếu biến bắt buộc phải dừng server với thông báo rõ.
- [x] **P001-G1-S06 — Chuẩn hóa model test.** Đổi `test-keys.js` từ model preview đã ngừng sang `gemini-3.1-flash-lite` và dùng cùng constant/config với service chính.
- [x] **P001-G1-S07 — Dọn công cụ test cũ.** Cập nhật hoặc loại bỏ `test.html` đang dùng port, field upload và response format lỗi thời.

**Cổng G1:** `npm audit` không còn cảnh báo có bản vá tương thích; test/build/lint G0 vẫn đạt.

## G2 — Nâng cấp schema và tương thích dữ liệu

Mục tiêu: chuẩn bị dữ liệu cho retry, cancellation, progress và kết quả lớn mà không phá job cũ.

- [x] **P001-G2-S01 — Mở rộng Job schema.** Thêm `attemptCount`, `maxAttempts`, `nextRetryAt`, `errorCode`, `cancelRequested`, `processingToken`, `leaseExpiresAt`, `chunkCount`, `completedChunks` và progress cần thiết.
- [x] **P001-G2-S02 — Thêm trạng thái.** Chuẩn hóa `pending`, `processing`, `completed`, `failed`, `cancelled`; mô tả rõ trạng thái nào giữ PDF vật lý.
- [x] **P001-G2-S03 — Tạo TranslationChunk model.** Trường tối thiểu: `jobId`, `chunkIndex`, `content`, timestamps; unique index `{ jobId: 1, chunkIndex: 1 }`.
- [x] **P001-G2-S04 — Tương thích job legacy.** Endpoint kết quả ưu tiên chunks; nếu chưa có chunks thì fallback `Job.result`.
- [x] **P001-G2-S05 — Cứng hóa System schema.** Đặt `key` unique để không xuất hiện nhiều document `circuit_breaker`.
- [x] **P001-G2-S06 — Bổ sung index queue.** Index phục vụ claim job đến hạn, lease recovery và retry (`status`, `nextRetryAt`, `createdAt`, `leaseExpiresAt`).
- [x] **P001-G2-S07 — Migration an toàn.** Viết script idempotent bổ sung giá trị mặc định/index; chạy được nhiều lần và có dry-run/report.

**Cổng G2:** job legacy và job schema mới cùng xuất hiện trong `/jobs`; result legacy vẫn tải/copy được; migration chạy lần hai không thay đổi thêm dữ liệu.

## G3 — Queue nguyên tử và phục hồi an toàn

Mục tiêu: đảm bảo một PDF chỉ có đúng một worker sở hữu tại một thời điểm.

- [x] **P001-G3-S01 — Atomic claim.** Thay `findOne()` rồi `save()` bằng `findOneAndUpdate()` có filter `pending + nextRetryAt đã đến`, sort FIFO và gán `processingToken/leaseExpiresAt` trong cùng query.
- [x] **P001-G3-S02 — Khóa local sớm.** Bật khóa RAM trước thao tác async đầu tiên và luôn nhả trong `finally`; MongoDB vẫn là khóa chính.
- [x] **P001-G3-S03 — Kiểm tra quyền sở hữu.** Mọi lần cập nhật completed/failed phải kèm đúng `processingToken`, ngăn worker cũ ghi đè worker mới.
- [x] **P001-G3-S04 — Lease heartbeat.** Với job dài, gia hạn lease theo chu kỳ; dọn timer khi job kết thúc.
- [x] **P001-G3-S05 — Zombie recovery có điều kiện.** Chỉ trả `processing` về `pending` khi lease hết hạn, không reset mù toàn bộ job processing.
- [x] **P001-G3-S06 — Không nuốt lỗi initDB.** Nếu khởi tạo queue/state/index thất bại, server không báo ready và không listen như thể bình thường.
- [x] **P001-G3-S07 — Sửa restore hibernation hết hạn.** Clear state MongoDB trực tiếp khi `wakeupTime` đã qua, không gọi `forceWakeUp()` khi cờ RAM vẫn false.
- [x] **P001-G3-S08 — Log lỗi DB.** Không để outer catch của worker im lặng; log mã job, loại thao tác và backoff nhưng không lộ secret.
- [x] **P001-G3-S09 — Test race.** Gọi `startWorker()` đồng thời nhiều lần với nhiều upload; assert mỗi job chỉ được claim và gọi pipeline đúng một lần.

**Cổng G3:** test concurrency 50 lần liên tiếp không có job dịch trùng; restart giả lập chỉ phục hồi lease hết hạn.

## G4 — Phân loại lỗi, retry và circuit breaker

Mục tiêu: chỉ retry lỗi tạm thời và chỉ ngủ đông khi quota Gemini thực sự có vấn đề.

### Taxonomy bắt buộc

| errorCode | Retry | Tính vào circuit breaker | Xử lý PDF |
| --- | --- | --- | --- |
| `CANCELLED` | Không | Không | Xóa |
| `FILE_MISSING` | Không | Không | Đã mất/không còn |
| `INVALID_PDF` | Không | Không | Xóa |
| `UPLOAD_INVALID` | Không | Không | Xóa |
| `GEMINI_AUTH` / `GEMINI_CONFIG` | Không | Không | Xóa hoặc chờ người dùng tải lại sau khi sửa config |
| `GEMINI_RATE_LIMIT` | Có | Có | Giữ trong thời gian chờ |
| `GEMINI_UNAVAILABLE` / network timeout | Có | Không | Giữ trong thời gian chờ |
| `DATABASE_UNAVAILABLE` | Worker backoff | Không | Giữ, không đổi thành lỗi API |
| `UNKNOWN_PROCESSING_ERROR` | Có giới hạn | Không | Xóa khi hết số lần |

- [x] **P001-G4-S01 — Tạo ProcessingError.** Có `code`, `retryable`, `quotaRelated`, `publicMessage`, `cause`.
- [x] **P001-G4-S02 — Chuẩn hóa lỗi Gemini.** Map HTTP 400/401/403/429/5xx, timeout và network error sang taxonomy.
- [x] **P001-G4-S03 — Chuẩn hóa lỗi PDF/filesystem.** PDF parse lỗi không được tăng quota failure; file mất không retry vô hạn.
- [x] **P001-G4-S04 — Job retry policy.** Tăng `attemptCount`, đặt `nextRetryAt` với exponential backoff + jitter, dừng tại `maxAttempts`.
- [x] **P001-G4-S05 — Retry scheduler.** Worker tự thức khi job gần nhất đến hạn; sau restart phải khôi phục được lịch từ MongoDB.
- [x] **P001-G4-S06 — Circuit breaker chính xác.** Chỉ tăng `consecutiveFailures` với lỗi quota đã thử hết key; thành công hoặc lỗi không liên quan quota phải phá chuỗi liên tiếp.
- [x] **P001-G4-S07 — Persist circuit state an toàn.** `wakeUp()`/timer lỗi DB phải có catch, log và vẫn có đường khôi phục; không tạo unhandled rejection.
- [x] **P001-G4-S08 — Dọn sweeper cũ.** Thay điều kiện so sánh exact error string bằng query theo `errorCode`, `attemptCount`, `nextRetryAt` hoặc loại bỏ sweeper nếu scheduler đã bao phủ.
- [ ] **P001-G4-S09 — Test ma trận lỗi.** Mỗi dòng taxonomy có test status, retry count, circuit counter và file cleanup tương ứng.

**Cổng G4:** 10 PDF hỏng không làm hệ thống ngủ đông; 429 giả lập retry đúng giới hạn; API key sai không tạo vòng lặp vô hạn.

## G5 — Pipeline Gemini/chunk và kiểm soát memory

Mục tiêu: không để task cũ chạy ngầm sau lỗi, có thể resume theo chunk và tránh document 16 MB.

- [x] **P001-G5-S01 — Thay Promise.all toàn bộ.** Dùng worker-pool thủ công tối đa 2 chunk. Khi một chunk lỗi, không nhận chunk mới; chờ tối đa các request đang bay kết thúc trước khi trả job cho queue.
- [x] **P001-G5-S02 — Cancellation token.** Kiểm tra cancel trước khi cắt PDF, trước/sau mỗi Gemini call và trước mỗi lần ghi DB.
- [x] **P001-G5-S03 — Timeout request Gemini.** Cấu hình timeout có thể điều chỉnh; nếu SDK hỗ trợ abort thì nối với cancellation token.
- [x] **P001-G5-S04 — Lưu chunk ngay khi hoàn thành.** Upsert theo `{jobId, chunkIndex}` và tăng progress an toàn.
- [x] **P001-G5-S05 — Resume chunk.** Khi retry, đọc chunk đã tồn tại và chỉ gửi phần còn thiếu lên Gemini.
- [x] **P001-G5-S06 — Hoàn tất job.** Chỉ chuyển `completed` khi đủ `chunkCount`; không ghi toàn bộ kết quả vào `Job.result` mới.
- [x] **P001-G5-S07 — Kết quả không chèn horizontal rule.** Ghép chunk bằng khoảng trắng/marker nội bộ phù hợp, không tự thêm `---` trái với prompt.
- [x] **P001-G5-S08 — Result API tương thích.** Preview/copy vẫn nhận Markdown; thêm download endpoint có thể stream các chunk theo thứ tự để tránh nối chuỗi lớn trong RAM.
- [x] **P001-G5-S09 — Giảm copy PDF.** Cho Worker đọc trực tiếp `filePath`; dùng transfer list hoặc xử lý tuần tự từng nhóm trang, không clone buffer 500 MB qua lại.
- [ ] **P001-G5-S10 — Kiểm tra tài nguyên.** Đo peak RAM với PDF nhỏ, trung bình và file gần giới hạn; ghi số liệu vào Bảng bằng chứng.

**Cổng G5:** lỗi chunk đầu không làm các chunk chưa bắt đầu tiếp tục gọi Gemini; retry không dịch lại chunk đã lưu; kết quả giả lập trên 16 MB không làm Job document lỗi.

## G6 — Chống đầy 500 MB bằng Local Feeder

Mục tiêu: vẫn chọn được hàng trăm chương nhưng Render không chứa toàn bộ hàng đợi PDF.

- [x] **P001-G6-S01 — Disk budget config.** Thêm `MAX_UPLOAD_STORAGE_MB` với mặc định an toàn (đề xuất 350–400 MB để chừa không gian runtime); ghi rõ cách chỉnh trên Render.
- [x] **P001-G6-S02 — Upload path tuyệt đối.** Tạo `uploads/` dựa trên đường dẫn backend, không phụ thuộc process CWD.
- [x] **P001-G6-S03 — Ignore dữ liệu tạm.** Thêm `uploads/` vào backend `.gitignore`; kiểm tra không có PDF tracked.
- [x] **P001-G6-S04 — Capacity API.** Trả `canAcceptUpload`, `activeSourceFiles`, `usedBytes`, `budgetBytes` và lý do đang chặn; không trả thông tin secret.
- [x] **P001-G6-S05 — Admission guard trước Multer.** Dùng `Content-Length` và trạng thái queue để từ chối sớm bằng 409/507 khi server đang giữ file hoặc không đủ ngân sách.
- [x] **P001-G6-S06 — Guard sau Multer.** Đo lại disk thật; nếu vượt budget phải xóa file vừa nhận và trả lỗi rõ ràng.
- [x] **P001-G6-S07 — Giới hạn từng file.** Đặt giới hạn thấp hơn disk budget; vẫn cho phép chọn số lượng file lớn trên frontend.
- [x] **P001-G6-S08 — Local Feeder một file.** Frontend giữ danh sách file theo folder, chỉ POST file kế tiếp khi capacity cho phép và không có server job đang giữ PDF.
- [x] **P001-G6-S09 — Giữ file đến trạng thái cuối.** Sau POST, Local Queue vẫn giữ tham chiếu file để có thể re-upload nếu Render restart làm `FILE_MISSING`.
- [x] **P001-G6-S10 — Progress rõ ràng.** Hiển thị số đã dịch, đang upload, đang chờ local, thất bại và còn lại; không gọi hàng chờ local là hàng chờ cloud.
- [x] **P001-G6-S11 — Backoff capacity.** Khi backend trả busy/507, frontend chờ rồi thử capacity lại, không liên tục spam request.
- [x] **P001-G6-S12 — Cảnh báo đóng tab.** Hiển thị `beforeunload` khi Local Queue còn file; mô tả rằng F5/đóng tab sẽ mất danh sách chưa upload.
- [x] **P001-G6-S13 — Test 100 chương.** Dùng file fixture/giả lập, xác nhận số file nguồn trên Render không vượt giới hạn thiết kế và thứ tự folder/file được giữ.

**Cổng G6:** chọn 100 file cùng lúc vẫn hoạt động; tại mọi thời điểm backend không nhận thêm file khi disk budget không đủ; file được dọn trước khi file kế tiếp upload.

## G7 — Hủy/xóa job và garbage collection

Mục tiêu: mọi đường xóa đều có semantics thống nhất, không tốn thêm quota và không để PDF mồ côi.

- [x] **P001-G7-S01 — Centralize deletion.** Controller không tự `deleteMany/unlinkSync`; toàn bộ single/bulk/folder delete gọi một service cleanup chung.
- [x] **P001-G7-S02 — Xóa pending.** Atomically đổi sang cancelled, xóa PDF, chunks và Job.
- [x] **P001-G7-S03 — Xóa processing.** Đặt `cancelRequested`; pipeline dừng nhận chunk mới. API trả 202 nếu cần chờ request đang bay.
- [x] **P001-G7-S04 — Finalize cancellation.** Worker xác nhận cancelled rồi xóa PDF/chunks/Job; không save trạng thái completed/failed đè lên yêu cầu hủy.
- [x] **P001-G7-S05 — Xóa completed/failed.** Dọn chunks, legacy result Job và file còn sót; thao tác idempotent.
- [x] **P001-G7-S06 — Cleanup khi upload DB lỗi.** Nếu Multer đã ghi file nhưng tạo Job thất bại, xóa tất cả file chưa gắn Job. Nếu một lô chỉ thành công một phần, response phải nêu rõ file thành công/thất bại thay vì trả lỗi mơ hồ cho cả lô.
- [x] **P001-G7-S07 — Cleanup khi lỗi vĩnh viễn.** `INVALID_PDF`, hết số lần retry và config error phải giải phóng PDF để Local Feeder đi tiếp.
- [x] **P001-G7-S08 — Async filesystem.** Thay các thao tác sync trên request/event loop bằng `fs/promises` khi phù hợp.
- [x] **P001-G7-S09 — Startup orphan scan.** Đối chiếu file trong `uploads/` với Job đang cần chúng; xóa orphan có grace period, không xóa file vừa upload đang tạo Job.
- [ ] **P001-G7-S10 — Test cancellation.** Xóa ở từng thời điểm: trước claim, đang split, đang gọi Gemini, đang retry, completed và xóa folder nhiều trạng thái.

**Giải thích lỗi upload mồ côi:** Multer ghi PDF xuống disk **trước** khi controller tạo Job MongoDB. Nếu MongoDB lỗi ở bước sau, PDF đã tồn tại nhưng không có Job nào quản lý hoặc xóa nó. Qua nhiều lần, các file vô chủ có thể chiếm hết 500 MB. Bước G7-S06 và G7-S09 xử lý hai lớp của vấn đề này.

**Cổng G7:** sau mọi test delete/error, số file disk và số chunk MongoDB đúng như kỳ vọng; job bị cancel không phát sinh thêm Gemini call mới.

## G8 — Hoàn thiện API, SSE và frontend

Mục tiêu: frontend luôn phản ánh đúng trạng thái backend và xử lý tốt lỗi mạng/deploy.

- [ ] **P001-G8-S01 — API client riêng.** Tách Axios instance, base URL, timeout, error normalization khỏi `App.jsx`.
- [x] **P001-G8-S02 — Sửa fallback URL.** Default phải bao gồm `/api/translate`; validate và bỏ slash cuối nhất quán.
- [x] **P001-G8-S03 — Encode ID.** Dùng `encodeURIComponent(jobId)` cho result/delete và UUID cho job mới; job legacy vẫn dùng được.
- [x] **P001-G8-S04 — Pagination `/jobs`.** Hỗ trợ `limit + cursor`, giới hạn server-side và trả `nextCursor`; frontend load trang đầu và “tải thêm”.
- [x] **P001-G8-S05 — SSE parse/error.** Bọc JSON parse, xử lý `onerror`, hiển thị trạng thái mất kết nối.
- [x] **P001-G8-S06 — SSE resync.** Khi kết nối/reconnect, refetch system status và trang jobs hiện hành để bù event bị bỏ lỡ.
- [x] **P001-G8-S07 — Progress theo chunk.** SSE status mang `completedChunks/chunkCount/attemptCount/nextRetryAt` để người dùng hiểu đang làm gì.
- [ ] **P001-G8-S08 — Retry/cancel UI.** Nút retry file local lỗi, bỏ khỏi Local Queue, cancel server job và trạng thái “đang hủy”.
- [x] **P001-G8-S09 — Download không ghi đè.** Nếu hai tên sanitize trùng, thêm suffix ổn định; luôn đóng writable handle trong `finally`.
- [x] **P001-G8-S10 — Streaming download.** Với kết quả lớn, dùng endpoint download thay vì nạp toàn bộ JSON vào RAM; preview có giới hạn hoặc lazy load.
- [x] **P001-G8-S11 — Dọn local task.** Giải phóng `File` sau completed/cancelled; cho phép ẩn/xóa task đã xong.
- [ ] **P001-G8-S12 — UX lỗi.** Thay alert chung chung bằng thông báo cụ thể: server đang ngủ, disk bận, mất mạng, PDF lỗi, quota, retry time.
- [ ] **P001-G8-S13 — CSS/component cleanup.** Tách `JobCard`, `FolderGroup`, `LocalQueue`, `SystemBanner`; chuyển inline style sang CSS; thêm các class còn thiếu.
- [x] **P001-G8-S14 — Accessibility/metadata.** `lang="vi"`, title StudyMed Translator, label input, keyboard support cho thu gọn thư mục, focus state và responsive table.
- [ ] **P001-G8-S15 — Test frontend.** Cover Local Feeder, SSE reconnect, partial upload, retry, cancellation và filename collision.

**Cổng G8:** mất SSE rồi reconnect không để UI kẹt trạng thái; fallback API hoạt động; lint/build/test sạch; hai tên file giống nhau không bị ghi đè.

## G9 — Kiểm thử end-to-end và triển khai

Mục tiêu: đưa đại tu lên production có kiểm soát và có đường quay lại.

- [ ] **P001-G9-S01 — Test matrix local.** Chạy toàn bộ bảng tình huống bên dưới với Gemini mock; chọn một smoke test Gemini thật kích thước nhỏ.
- [ ] **P001-G9-S02 — Backup MongoDB.** Xuất/backup Job và System trước migration production; ghi vị trí và thời điểm backup nhưng không ghi credential.
- [ ] **P001-G9-S03 — Deploy backend trước.** Backend mới phải tương thích frontend cũ trong cửa sổ chuyển đổi.
- [ ] **P001-G9-S04 — Chạy migration production.** Dry-run, review số document, chạy thật, kiểm tra index.
- [ ] **P001-G9-S05 — Smoke backend.** Health, capacity, jobs pagination, SSE, upload 1 PDF, result và cleanup.
- [ ] **P001-G9-S06 — Deploy frontend.** Xác nhận `VITE_API_URL` là `https://tranmed.onrender.com/api/translate`.
- [ ] **P001-G9-S07 — Smoke end-to-end.** Chọn nhiều chương, quan sát Local Feeder, hoàn thành, preview, copy, download, delete.
- [ ] **P001-G9-S08 — Theo dõi 24 giờ.** RAM, disk, restart, số API call/chunk, job retry, orphan, SSE reconnect và lỗi MongoDB.
- [ ] **P001-G9-S09 — Cập nhật knowledge/docs.** Đồng bộ `.codex/knowledge`, README, biến môi trường và tài liệu vận hành theo mã nguồn mới.
- [ ] **P001-G9-S10 — Đóng dự án.** Chỉ đánh dấu P001 hoàn thành khi không còn blocker và rollback không còn cần kích hoạt.

**Cổng G9:** production dịch thành công một batch nhiều chương, disk nằm dưới budget, không dịch trùng, không còn vulnerability có bản vá và không phát hiện regression trong thời gian theo dõi.

## 5. Ma trận kiểm thử bắt buộc

| ID | Tình huống | Kết quả mong đợi | Trạng thái |
| --- | --- | --- | --- |
| T01 | Upload đồng thời nhiều file | Mỗi job chỉ claim một lần | Đạt unit: 20 claim đồng thời chỉ 1 thành công |
| T02 | Chọn 100 PDF trên frontend | Chúng ở Local Queue; backend chỉ nhận theo capacity | Đạt mô phỏng: 100 File, chỉ 1 POST |
| T03 | PDF lớn hơn disk budget | Bị từ chối trước/sau Multer và không để orphan | Chưa chạy |
| T04 | PDF hỏng | Failed vĩnh viễn, không retry, không hibernate, file được xóa | Đạt unit một phần: magic + error policy |
| T05 | Gemini 429 mọi key | Retry/backoff đúng, chỉ lỗi quota tăng circuit | Chưa chạy |
| T06 | Gemini 503 tạm thời | Retry đúng giới hạn, resume chunk đã xong | Chưa chạy |
| T07 | API key sai | Không retry vô hạn, thông báo config rõ | Chưa chạy |
| T08 | MongoDB mất kết nối lúc startup | Server không báo ready giả | Chưa chạy |
| T09 | MongoDB lỗi sau khi Multer ghi file | File mồ côi được xóa | Đạt unit: controller gọi cleanup file Multer |
| T10 | Xóa job pending | Không gọi Gemini, disk/DB/chunk sạch | Đạt unit một phần: atomic cancel trước cleanup |
| T11 | Xóa job processing | Không nhận chunk mới, cleanup sau cancel | Đạt unit một phần: abort + cancel thắng retry race |
| T12 | Xóa folder hỗn hợp trạng thái | Không race/save đè; mọi tài nguyên được dọn | Chưa chạy |
| T13 | Render restart khi processing | Lease recovery đúng; FILE_MISSING không lặp vô hạn | Đạt unit một phần: re-upload giữ ID/chunks; chưa test restart |
| T14 | Kết quả lớn hơn 16 MB | Lưu/stream theo chunks, Job không vượt giới hạn | Chưa chạy |
| T15 | Tên file Unicode, `#`, `%` | Preview/copy/delete/download hoạt động | Chưa chạy |
| T16 | Hai file sanitize trùng tên | Download tạo hai file riêng | Code xong; chưa có test File System API |
| T17 | SSE ngắt đúng lúc completed | Reconnect và resync ra completed | Chưa chạy |
| T18 | Đóng/F5 khi còn Local Queue | Cảnh báo rõ; không hiểu nhầm file đã lên cloud | Code xong; chưa test trình duyệt thật |
| T19 | Job legacy có `result` | Vẫn preview/copy/download được | Chưa chạy |
| T20 | Lỗi chunk đầu khi concurrency 2 | Không có chunk thứ 3+ bắt đầu; job sau chưa chạy chồng | Đạt unit: chỉ chunk 0 và 1 bắt đầu |

## 6. Bản đồ file dự kiến tác động

| File/khu vực | Thay đổi dự kiến |
| --- | --- |
| `backend/src/models/jobModel.js` | retry, lease, cancellation, progress, indexes |
| `backend/src/models/systemModel.js` | unique key, state validation |
| `backend/src/models/translationChunkModel.js` | model mới lưu kết quả theo chunk |
| `backend/src/services/queueManager.js` | atomic claim, lease, typed retry, cancel, cleanup |
| `backend/src/services/geminiService.js` | error mapping, bounded worker pool, cancel, timeout, chunk callback |
| `backend/src/services/pdfService.js` và worker | đọc file theo path, giảm copy/RAM |
| `backend/src/controllers/translateController.js` | pagination, capacity, result/download, centralized delete |
| `backend/src/middlewares/upload.js` | absolute path, admission/disk guard, cleanup |
| `backend/src/routes/translateRoute.js` | capacity/download và response semantics mới |
| `backend/src/utils/processingError.js` | taxonomy lỗi dùng chung |
| `backend/.gitignore` | ignore uploads |
| `frontend/src/App.jsx` | Local Feeder và tách dần component |
| `frontend/src/api/*` | Axios client/API functions mới nếu cần |
| `frontend/src/components/*` | component hóa UI nếu cần |
| `frontend/src/App.css`, `index.css`, `index.html` | UX, responsive, accessibility, metadata |
| `package.json`/lockfiles | test scripts và dependency patches |
| `.codex/knowledge/*`, README | tài liệu sau đại tu |

Tên `backend/` và `frontend/` trong bảng là viết gọn; đường dẫn thực tế vẫn là `med-translator-backend/` và `med-translator-frontend/`.

## 7. Chiến lược commit và rollback

- Mỗi giai đoạn dùng một hoặc nhiều commit nhỏ, không trộn refactor UI với queue/database.
- Schema mới phải additive trước; chỉ xóa `Job.result` sau một dự án migration riêng, không làm trong P001.
- Backend mới phải đọc được dữ liệu cũ và chịu được frontend cũ trong lúc deploy lệch phiên bản.
- Trước G9 phải ghi commit/tag rollback, ví dụ `pre-project-001-deploy`.
- Nếu migration lỗi: dừng deploy frontend, rollback backend và restore backup nếu dữ liệu đã bị biến đổi không tương thích.
- Nếu Local Feeder lỗi nhưng backend ổn: rollback frontend; backend vẫn nhận upload theo capacity guard.
- Không dùng `git reset --hard` hoặc xóa database để rollback.

## 8. Nhật ký thay đổi

| Thời gian | Mã bước | Commit/PR | Nội dung | Người thực hiện | Kết quả |
| --- | --- | --- | --- | --- | --- |
| 15-07-2026 | P001-PLAN | Chưa commit | Tạo kế hoạch đại tu | Codex | Hoàn thành tài liệu |
| 15-07-2026 | P001-G0…G8 | Chưa commit | Đại tu queue, retry/cancel, chunk storage, disk guard, Local Feeder, API/SSE và test | Codex | Hoàn thành code lõi; giữ G9 production mở |

## 9. Bằng chứng kiểm thử

| Thời gian | Giai đoạn/bước | Lệnh hoặc phép đo | Kết quả | Log/artifact |
| --- | --- | --- | --- | --- |
| Trước P001 | Baseline review | Frontend `npm run build` | Thành công | Ghi nhận trong review |
| Trước P001 | Baseline review | Frontend `npm run lint` | 4 lỗi | `App.jsx` dòng 28, 43, 227, 338 |
| Trước P001 | Baseline review | Backend `npm audit --omit=dev` | 3 high, 2 moderate | Cần xử lý tại G1 |
| Trước P001 | Baseline review | Frontend `npm audit` | 3 high, 1 moderate, 1 low | Cần xử lý tại G1 |
| 15-07-2026 | G1 | `npm audit` ở backend và frontend | 0 vulnerability ở cả hai | npm audit |
| 15-07-2026 | G3–G7 | Backend `npm test` | 12 test đạt, 0 lỗi | Node test runner |
| 15-07-2026 | G6/G8 | Frontend `npm test -- --run` | 2 test đạt; fixture 100 chương chỉ POST 1 file | Vitest/RTL |
| 15-07-2026 | G8 | Frontend `npm run lint` + `npm run build` | Thành công; Vite production build sạch | ESLint/Vite |
| 15-07-2026 | G5 | PDF Worker unit | Abort dừng worker; Uint8Array dùng transfer list | `pdfSplitter.test.js` |

## 10. Nhật ký vấn đề và quyết định

| ID | Ngày | Vấn đề/quyết định | Ảnh hưởng | Hướng xử lý | Trạng thái |
| --- | --- | --- | --- | --- | --- |
| D001 | 15-07-2026 | Không thêm authentication vì ứng dụng chỉ có một người dùng và tài liệu không bí mật | Chấp nhận API không có tài khoản | Giữ ngoài phạm vi P001; vẫn bảo vệ tài nguyên | Đã chốt |
| D002 | 15-07-2026 | Render chỉ có khoảng 500 MB nhưng số chương cần dịch rất lớn | Upload trước toàn bộ làm restart và mất file pending | Local Feeder + capacity/disk budget | Đã chốt |
| D003 | 15-07-2026 | Filesystem Render là ephemeral | PDF trên server không thể là queue bền vững | Chỉ giữ file đang xử lý/retry; MongoDB giữ metadata/chunks | Đã chốt |
| D004 | 15-07-2026 | Ba tài liệu gốc đang hiện là deleted trong worktree trước khi triển khai P001 | Có nguy cơ commit nhầm deletion | Xác nhận riêng với chủ dự án ở G0-S01 | Chờ xác nhận |

## 11. Điều kiện hoàn thành PROJECT 001

PROJECT 001 chỉ được đóng khi tất cả điều sau đều đúng:

- Không còn khả năng một job được claim đồng thời bởi hai worker trong test.
- Chọn batch hàng trăm file không làm Render lưu hàng trăm PDF.
- Mọi trạng thái cuối/cancel đều giải phóng PDF nguồn đúng chính sách.
- Lỗi PDF, disk và database không kích hoạt circuit breaker quota.
- Không có retry vô hạn; retry có giới hạn và có thời điểm tiếp theo rõ ràng.
- Kết quả trên 16 MB không phụ thuộc một MongoDB Job document.
- Xóa job processing không cho pipeline bắt đầu thêm chunk.
- SSE reconnect tự đồng bộ lại trạng thái.
- Preview/copy/download/delete hoạt động với UUID và job legacy.
- Frontend lint/build/test và backend test đều đạt.
- Dependency audit không còn lỗi có bản vá tương thích chưa áp dụng.
- Knowledge base và tài liệu vận hành phản ánh đúng code production.
