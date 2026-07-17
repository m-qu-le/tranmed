# PROJECT 005 — Thống kê vận hành chính xác, quản lý batch gọn và worker hai lane an toàn

## 1. Thông tin dự án

| Thuộc tính | Giá trị |
| --- | --- |
| Mã kế hoạch | P005 |
| Ngày lập | 17-07-2026 |
| Trạng thái tổng | **ĐANG TRIỂN KHAI — G0–G6 đã đạt cục bộ; chờ deploy/canary G7** |
| Nguồn yêu cầu | Các mục 1–4 trong `log_vận_hành.md`, được làm rõ qua trao đổi với chủ dự án |
| Mục tiêu chính | Hiển thị đúng số file đã hoàn thành trên toàn bộ dữ liệu, làm gọn lịch sử upload Cloud và tăng tốc hàng đợi bằng tối đa hai worker mà không vượt giới hạn tài nguyên Render |
| Phương án concurrency đã chốt | Tối đa 2 job; chỉ dùng lane thứ hai khi tổng `sourceSize` của các job đang chạy không quá 10 MiB; job lớn hoặc thiếu kích thước chạy đơn |
| Phương án ẩn batch đã chốt | Chỉ ẩn batch đã an toàn; ghi nhớ trong trình duyệt; không xóa `UploadBatch`, `Job` hoặc object R2 |
| Phương án rollout đã chốt | Thêm cấu hình với mặc định 1, canary hai PDF nhỏ, chỉ đặt production = 2 sau khi cổng tài nguyên/quota/cleanup đạt |
| Hạ tầng giữ nguyên | React/Vite, Express, MongoDB, Cloudflare R2, Render, SSE và Gemini quality pipeline hiện tại |
| Thay đổi schema | Không dự kiến migration; tái sử dụng `Job.status`, `Job.sourceSize` và các index hiện có |

## 2. Cách theo dõi kế hoạch

Quy ước:

- `[ ]`: chưa thực hiện.
- `[x]`: đã hoàn thành và có bằng chứng trong Nhật ký bằng chứng.
- `BLOCKED`: không thể tiếp tục do thiếu điều kiện bên ngoài hoặc phát hiện rủi ro chưa được giải quyết.
- Mỗi bước có mã `P005-Gx-Syy`; dùng mã này trong commit, pull request, log test và phiên review.
- Chỉ đánh dấu hoàn thành khi tiêu chí của bước và cổng giai đoạn đều đạt.
- Mọi thay đổi ngưỡng 10 MiB, concurrency tối đa, API công khai hoặc semantics “Ẩn” phải được ghi vào Nhật ký quyết định trước khi triển khai.
- Không dùng `git add -A`; không stage/xóa các thay đổi ngoài P005 trong worktree hiện đang có nhiều file sửa, xóa và untracked.
- Không commit `.env`, API key, Mongo URI, presigned URL, PDF/bản dịch người dùng hoặc log chứa dữ liệu nhạy cảm.
- Canary production là bước có chủ đích, giới hạn ở hai PDF fixture nhỏ; không mở lại benchmark P003 hoặc chạy batch thật lớn.

## 3. Yêu cầu vận hành và ánh xạ phạm vi

| Mục trong log | Yêu cầu | Cách xử lý trong P005 |
| --- | --- | --- |
| 1 | Số lớn ở card thứ ba phải là số file đã xong | Đổi card thành `N File đã xong`; dòng phụ chỉ còn chờ, xử lý và lỗi |
| 2 | Nếu hệ thống chịu được thì xử lý hai file cùng lúc | Refactor singleton thành pool tối đa hai lane, có admission 10 MiB, FIFO, cancellation và rollback |
| 3 | Nút Ẩn đẹp hơn và có Ẩn tất cả | Tạo style dùng chung; chỉ ẩn batch an toàn; lưu danh sách ID đã ẩn trong trình duyệt |
| 4 | Số liệu không được phụ thuộc nút Tải thêm lịch sử | Tạo thống kê tổng hợp từ MongoDB; phân trang chỉ còn phục vụ danh sách job |

Mục 1 và 4 là cùng một lỗi gốc nên phải sửa tại nguồn thống kê, không vá riêng nội dung card.

## 4. Hiện trạng kỹ thuật và nguyên nhân gốc

### 4.1. Dashboard đang dùng dữ liệu phân trang

- Frontend gọi `GET /jobs`, mặc định nhận 100 job mới nhất và lưu vào state `jobs`.
- Card dashboard dùng `jobs.filter(...)` để đếm `pending`, `processing`, `completed` và `failed`.
- Mỗi lần “Tải thêm lịch sử”, state có thêm tối đa 100 job nên số dashboard thay đổi dù dữ liệu MongoDB không đổi.
- Chỉ sau khi tải hết lịch sử, phép đếm phía trình duyệt mới tình cờ khớp dữ liệu thật.

Kết luận: pagination đang bị dùng nhầm làm nguồn sự thật cho thống kê tổng. Nguồn đúng phải là phép tổng hợp trên toàn bộ collection `Job` ở backend.

### 4.2. Worker hiện là singleton

`QueueManager` hiện giữ một bộ trạng thái dùng cho đúng một job:

- `isProcessing`.
- `currentJobId`.
- `currentAbortController`.
- Một vòng `startWorker()` claim và xử lý một job, sau đó tự gọi lại để lấy job kế tiếp.

MongoDB đã dùng `findOneAndUpdate` nguyên tử nên có nền tảng chống claim trùng. Tuy nhiên chỉ đổi một hằng số thành 2 sẽ làm hỏng cancellation, heartbeat và trạng thái active trong RAM.

### 4.3. Giới hạn disk/RAM khi chạy hai file

- Render hiện dùng ngân sách disk tạm 400 MiB và cho phép file đơn tới 350 MiB.
- `SourceService` kiểm dung lượng trước khi tải R2, nhưng hai lượt kiểm đồng thời có thể cùng thấy đủ chỗ rồi cùng download; đây là race condition kiểu check-then-act.
- PDF worker đọc toàn file và trả toàn bộ chunk buffer về main process. Benchmark P003 cho thấy PDF 5,18 MiB từng làm RSS tăng khoảng 53,87 MiB khi split.
- Workload P002 ghi nhận phần lớn file 1–3 MiB, đôi khi khoảng 30 MiB. Không có bằng chứng an toàn để luôn chạy song song hai file lớn.

Kết luận: concurrency 2 phải là giới hạn tối đa có admission theo tổng kích thước, không phải cam kết luôn có hai job bất kể kích thước.

### 4.4. “Ẩn” batch hiện chỉ là state tạm thời

- Nút “Ẩn” chỉ lọc item khỏi `localQueue`.
- Khi F5 hoặc SSE kết nối lại, frontend đọc các batch gần đây từ MongoDB và có thể đưa batch đã ẩn trở lại.
- Nút hiện chỉ xuất hiện ở batch `safe`, đây là ranh giới an toàn cần giữ.

Kết luận: danh sách batch đã ẩn phải được lưu cục bộ và áp dụng cả khi merge dữ liệu từ server.

## 5. Mục tiêu và chỉ tiêu thành công

P005 hoàn thành khi đạt đồng thời:

1. Card thứ ba hiển thị số lớn là tổng job `completed` thực trong MongoDB, không thay đổi chỉ vì người dùng tải thêm lịch sử.
2. Dòng phụ hiển thị chính xác `Chờ N · xử lý N · lỗi N`; không lặp số “xong”.
3. Thống kê cập nhật sau upload/claim/complete/fail/cancel/delete và tự đồng bộ lại sau SSE reconnect.
4. Nút “Ẩn” và “Ẩn tất cả” chỉ tác động batch đã an toàn, có giao diện nhất quán và không xóa dữ liệu backend.
5. Batch đã ẩn không xuất hiện lại sau F5 hoặc SSE reconnect trên cùng trình duyệt.
6. Khi concurrency = 2 và hai job đầu hàng đợi có tổng source không quá 10 MiB, cả hai có thể ở trạng thái `processing` đồng thời.
7. Nếu job kế tiếp làm tổng vượt 10 MiB, hoặc không có `sourceSize` hợp lệ, job đó chờ đến khi chạy một mình; không bỏ qua FIFO để lấy job nhỏ hơn phía sau.
8. Hủy một job đang chạy chỉ abort đúng job đó; job còn lại tiếp tục và lease/các artifact của nó không bị ảnh hưởng.
9. Không claim trùng, không vượt hai active job, không nhận job mới khi hibernating và không tạo vòng polling rỗng.
10. Canary hai PDF nhỏ hoàn thành, không có 429/5xx/retry/lease expiry, cleanup R2/local đạt và peak RAM Render dưới 80% giới hạn instance.

## 6. Phạm vi

### 6.1. Trong phạm vi

- API backend trả số lượng job toàn cục theo bốn trạng thái vận hành cần hiển thị.
- Frontend tách state thống kê khỏi danh sách job phân trang.
- Card dashboard, hành vi “Ẩn”, “Ẩn tất cả” và CSS/accessibility liên quan.
- Cấu hình concurrency worker, pool active job, admission theo kích thước, FIFO, cancellation, retry, lease và hibernation.
- Unit/integration test dùng mock/fixture, regression, lint/build, tài liệu cấu hình và canary production giới hạn.
- Bổ sung trạng thái worker vào API `/status` để quan sát canary và rollback.

### 6.2. Ngoài phạm vi

- Không thay đổi prompt, model, quality gate, số vòng repair, chunk concurrency hoặc nội dung bản dịch.
- Không tăng upload concurrency của trình duyệt; giá trị upload R2 hiện tại vẫn là 4.
- Không xóa lịch sử batch/job chỉ vì người dùng bấm “Ẩn”.
- Không thêm tài khoản, phân quyền hoặc đồng bộ danh sách batch ẩn giữa nhiều trình duyệt/thiết bị.
- Không tăng ngưỡng song song trên 10 MiB trong P005.
- Không bảo đảm hai file lớn chạy đồng thời; ưu tiên an toàn RAM/disk.
- Không benchmark batch hàng chục/hàng trăm PDF hoặc theo dõi 24 giờ để đóng P005.

## 7. Hành vi giao diện mục tiêu

### 7.1. Card dashboard thứ ba

Ví dụ khi MongoDB có 473 pending, 1 processing, 32 completed và 0 failed:

```text
32
File đã xong
Chờ 473 · xử lý 1 · lỗi 0
```

Quy tắc:

- Không cộng `pending + processing` vào số lớn.
- `uploading` đã có card upload riêng; `cancelled` không đưa vào dòng phụ.
- Khi chưa tải được thống kê lần đầu, hiển thị dấu `—`, không dùng 100 job phân trang làm fallback sai.
- Nếu lần refresh sau thất bại, giữ snapshot thành công gần nhất và ghi lỗi vào console; reconnect sẽ thử đồng bộ lại.

### 7.2. Nút ẩn batch Cloud

- Nút mỗi dòng giữ nhãn `Ẩn`, dùng class CSS thay cho inline style mới.
- Header khung có nút `Ẩn tất cả` khi tồn tại ít nhất một batch `safe` đang hiển thị.
- “Ẩn tất cả” chỉ loại các batch `safe`; batch preparing/uploading/error/chưa `canCloseClient` vẫn hiển thị.
- Không cần confirm vì đây là thao tác UI có thể khôi phục bằng cách xóa local storage; không gọi API delete.
- Nút có focus ring, trạng thái hover và nhãn accessible rõ ràng.

### 7.3. Ghi nhớ batch đã ẩn

- Dùng key local storage có version: `studymed.hiddenUploadBatchIds.v1`.
- Chỉ lưu `batchId`; task chưa có `batchId` không được coi là đã ẩn bền vững.
- Parser phải chịu được JSON hỏng, kiểu dữ liệu sai hoặc local storage bị chặn; khi đó fallback về danh sách rỗng trong bộ nhớ.
- Khi merge `/upload-batches`, lọc ID đã ẩn trước khi cập nhật `localQueue` để F5/SSE reconnect không khôi phục chúng.
- Dữ liệu cục bộ không phải lệnh xóa server và không ảnh hưởng cleanup/lifecycle R2.

## 8. Thiết kế API và luồng dữ liệu

### 8.1. API thống kê job

Thêm endpoint:

```http
GET /api/translate/jobs/stats
```

Response 200:

```json
{
  "pending": 473,
  "processing": 1,
  "completed": 32,
  "failed": 0
}
```

Quy tắc:

- Backend tổng hợp trên toàn bộ collection `Job`; trạng thái không có bản ghi trả `0`.
- Chỉ nhận bốn key trên; không trả danh sách job, result, error text hoặc metadata nhạy cảm.
- Dùng một aggregation `$match` + `$group`, tận dụng index `status`; không tải toàn bộ document vào Node.js.
- Route phải được khai báo rõ trước các route job động trong tương lai để `stats` không bị hiểu là `jobId`.
- Lỗi database trả 500 với thông báo công khai ngắn, không lộ Mongo URI hoặc raw stack.

### 8.2. Đồng bộ thống kê ở frontend

- Tạo state `jobStats`, khởi tạo `null`.
- Gọi `/jobs/stats` cùng đợt initial load và mỗi lần SSE `onopen` resync.
- Giữ `Map<jobId, status>` trong `useRef`, được seed từ các trang job đã tải.
- Khi nhận SSE `type=status`, chỉ yêu cầu refresh nếu `(jobId, status)` là chuyển trạng thái mới hoặc job chưa biết; các event tiến độ vẫn giữ `processing` không được tạo một query thống kê cho mỗi stage/chunk.
- Gộp nhiều chuyển trạng thái gần nhau bằng trailing debounce 500 ms; cleanup timer khi component unmount.
- Sau delete đơn, bulk delete hoặc xóa folder thành công, refresh ngay một lần.
- “Tải thêm lịch sử” chỉ cập nhật `jobs`/cursor và map trạng thái; tuyệt đối không tính lại dashboard từ mảng trang.

### 8.3. API trạng thái worker

Mở rộng response hiện có của `GET /status` bằng object additive:

```json
{
  "worker": {
    "concurrency": 2,
    "activeJobs": 2,
    "activeSourceBytes": 6291456,
    "parallelSourceBudgetBytes": 10485760
  }
}
```

Field mới chỉ phục vụ quan sát; frontend cũ bỏ qua được. Không đưa `jobId`, tên file hoặc đường dẫn source vào status công khai.

## 9. Thiết kế worker hai lane

### 9.1. Cấu hình

- Thêm `TRANSLATION_WORKER_CONCURRENCY` vào env parser và `.env.example`.
- Giá trị hợp lệ là số nguyên `1` hoặc `2`; mặc định `1` để deploy code không tự tăng tải.
- Giới hạn song song cố định trong P005: `10 * 1024 * 1024` byte.
- Production chỉ chuyển biến môi trường sang `2` sau cổng canary; rollback là đặt lại `1` và restart Render.

### 9.2. Trạng thái runtime

Thay trạng thái singleton bằng:

- `activeJobs`: `Map` từ `jobId` tới `{ abortController, sourceSize }`.
- `pumpPromise` hoặc cờ pump tương đương để nhiều lời gọi `startWorker()` không cùng lấp slot vượt giới hạn.
- `activeSourceBytes`: tổng `sourceSize` đã admission của các job active; cập nhật cùng lúc thêm/xóa entry trong `activeJobs`.
- Heartbeat vẫn thuộc từng lượt xử lý và luôn được clear trong `finally`.

Không tạo hai `QueueManager` độc lập vì cách đó nhân đôi sweeper, circuit breaker, retry timer và làm cancellation khó định tuyến.

### 9.3. Pump và claim

Luồng mục tiêu:

1. `startWorker()` no-op nếu hibernating hoặc một pump khác đang lấp slot.
2. Pump tính số slot còn trống từ concurrency cấu hình và `activeJobs.size`.
3. Nếu chưa có active job, claim nguyên tử job pending lâu nhất đủ điều kiện như hiện tại; job lớn vẫn được chạy đơn.
4. Nếu đã có một active job, đọc job pending lâu nhất kế tiếp để kiểm admission.
5. Chỉ claim chính job đó khi `sourceSize` là số nguyên dương và `activeSourceBytes + sourceSize <= 10 MiB`.
6. Nếu job đầu hàng đợi không fit hoặc thiếu size, không bỏ qua nó để lấy job nhỏ hơn phía sau; pump dừng lane thứ hai để giữ FIFO và tránh starvation.
7. Claim cuối cùng vẫn dùng `findOneAndUpdate` với `_id/status/cancelRequested/due/source-ready` để hai request/process không cùng nhận một job.
8. Nếu candidate bị process khác claim giữa peek và update, pump đọc lại và thử hữu hạn; không chạy job nếu atomic update trả null.
9. Mỗi lượt xử lý kết thúc sẽ xóa active entry trong `finally` rồi kick pump để lấp slot trống.
10. Khi không có job đến hạn, dùng retry timer hiện có; không microtask-poll liên tục.

`sourceSize` chỉ là proxy bảo thủ cho áp lực RAM. Đặt comment `ponytail:` tại admission nêu rõ trần 10 MiB và hướng nâng cấp là đo/adaptive memory admission nếu sau này cần chạy song song PDF lớn.

### 9.4. Cancellation và cleanup

- `cancelAndDeleteJob()` vẫn ghi `cancelRequested` vào MongoDB trước.
- Nếu job đang active trong process hiện tại, lấy đúng controller từ `activeJobs.get(jobId)` và abort controller đó.
- Abort job A không được clear heartbeat, controller, source reservation hoặc active entry của job B.
- Cleanup source/chunk/job giữ semantics hiện tại; active entry chỉ được release một lần trong `finally` kể cả success, failure hay cancel.
- Job processing trên instance khác vẫn dựa vào `cancelRequested` + lease như trước.

### 9.5. Retry, lease và hibernation

- Mỗi job có processing token và heartbeat riêng.
- Retryable failure trả đúng job về pending, release slot rồi để scheduler xét `nextRetryAt`.
- Circuit breaker vẫn dùng chuỗi kết quả job hoàn tất theo thứ tự thực tế; success hoặc lỗi không quota phá chuỗi như hiện tại.
- Khi chuyển hibernating, không claim/refill job mới. Job đang bay được phép kết thúc request hiện tại; không abort bằng nhánh cancellation vì điều đó có thể xóa job sai semantics.
- `wakeUp()` reset failure state và kick pump để lấp tối đa số slot cấu hình.
- Recovery chỉ trả lease hết hạn về pending; không đụng hai job đang có heartbeat hợp lệ.

## 10. Kế hoạch triển khai theo giai đoạn

### G0 — Baseline, bảo toàn worktree và chốt contract

Mục tiêu: có mốc so sánh đáng tin cậy trước khi sửa.

- [x] **P005-G0-S01 — Ghi trạng thái repository.** Lưu commit/branch, `git status` và xác nhận các thay đổi ngoài P005 thuộc người dùng.
- [x] **P005-G0-S02 — Chạy baseline backend.** `npm test`; ghi số pass/fail và mọi lỗi có sẵn.
- [x] **P005-G0-S03 — Chạy baseline frontend.** `npm test`, `npm run lint`, `npm run build`.
- [x] **P005-G0-S04 — Trace caller.** Rà mọi caller của `startWorker`, `claimNextJob`, cancellation, `/jobs`, SSE resync và merge upload batch.
- [x] **P005-G0-S05 — Khóa API contract.** Xác nhận `/jobs/stats`, bốn key response và object `worker` additive trong `/status`.
- [x] **P005-G0-S06 — Khóa giới hạn.** Xác nhận concurrency `1|2`, budget 10 MiB, FIFO và unknown-size chạy đơn.

**Cổng G0:** baseline được ghi; không có thay đổi ngoài P005 bị ghi đè; contract và acceptance criteria không còn mơ hồ.

### G1 — Backend thống kê toàn cục

Mục tiêu: tạo nguồn sự thật không phụ thuộc pagination.

- [x] **P005-G1-S01 — Tạo hàm aggregate.** Tổng hợp bốn trạng thái và điền `0` cho trạng thái không xuất hiện.
- [x] **P005-G1-S02 — Tạo controller.** Trả đúng JSON công khai; xử lý lỗi database an toàn.
- [x] **P005-G1-S03 — Khai báo route.** Thêm `GET /jobs/stats` ở vị trí không xung đột.
- [x] **P005-G1-S04 — Unit test đầy đủ.** Kiểm dữ liệu hỗn hợp, collection rỗng, trạng thái ngoài dashboard và lỗi DB.
- [x] **P005-G1-S05 — Kiểm hiệu năng query.** Xác nhận aggregation không hydrate/load document và dùng `status` filter/index phù hợp.

**Cổng G1:** endpoint trả số toàn collection đúng với fixture và không thay đổi response phân trang `/jobs`.

### G2 — Dashboard frontend chính xác và realtime

Mục tiêu: UI chỉ dùng thống kê backend cho card thứ ba.

- [x] **P005-G2-S01 — Tạo state/fetch stats.** Initial load và SSE resync cùng đọc `/jobs/stats`.
- [x] **P005-G2-S02 — Tách pagination.** Loại toàn bộ phép đếm dashboard từ state `jobs`.
- [x] **P005-G2-S03 — Đổi nội dung card.** Số lớn = completed; label và dòng phụ đúng wording đã chốt.
- [x] **P005-G2-S04 — Theo dõi status transition.** Seed/update map trạng thái job để bỏ qua event tiến độ cùng trạng thái.
- [x] **P005-G2-S05 — Debounce refresh.** Gộp transition 500 ms và cleanup timer khi unmount.
- [x] **P005-G2-S06 — Đồng bộ sau delete.** Delete đơn, bulk và folder đều refresh thống kê sau response thành công.
- [x] **P005-G2-S07 — Test pagination bug.** Tải 100 rồi 200 item nhưng card vẫn giữ tổng backend; chỉ response stats mới đổi số.
- [x] **P005-G2-S08 — Test SSE.** Processing stage lặp không spam API; pending→processing→completed cập nhật đúng.
- [x] **P005-G2-S09 — Test lỗi stats.** Initial failure hiện `—`; failure sau snapshot giữ số gần nhất.

**Cổng G2:** lỗi được mô tả ở mục 4 của log không còn tái hiện; “Tải thêm lịch sử” không ảnh hưởng dashboard.

### G3 — UX Ẩn và Ẩn tất cả

Mục tiêu: làm gọn khung Cloud mà không che cảnh báo chưa an toàn hoặc xóa server data.

- [x] **P005-G3-S01 — Helper local storage nhỏ.** Parse/serialize ID an toàn, không thêm dependency.
- [x] **P005-G3-S02 — Lọc khi restore/merge.** Batch bị ẩn không trở lại sau initial load hoặc SSE reconnect.
- [x] **P005-G3-S03 — Nâng nút Ẩn.** Dùng class CSS, focus/hover và accessible name.
- [x] **P005-G3-S04 — Thêm Ẩn tất cả.** Chỉ ghi/lọc batch `safe`; giữ nguyên mọi batch chưa an toàn.
- [x] **P005-G3-S05 — Test persistence.** Remount app với cùng local storage không hiện lại batch đã ẩn.
- [x] **P005-G3-S06 — Test dữ liệu hỏng.** JSON sai/local storage lỗi không làm crash app.
- [x] **P005-G3-S07 — Test không có mutation server.** Click Ẩn/Ẩn tất cả không gọi DELETE/POST backend.
- [x] **P005-G3-S08 — Test responsive/accessibility.** Header/nút không vỡ layout nhỏ; thao tác được bằng bàn phím.

**Cổng G3:** batch safe ẩn bền vững trên cùng trình duyệt; batch chưa an toàn luôn còn nhìn thấy.

### G4 — Cấu hình và lõi worker pool

Mục tiêu: thay singleton bằng pool nhỏ, không đổi pipeline dịch.

- [x] **P005-G4-S01 — Parse env.** Thêm biến concurrency với validation chỉ nhận 1 hoặc 2; cập nhật `.env.example`.
- [x] **P005-G4-S02 — Active map.** Thay current job/controller bằng map per-job và tổng source active.
- [x] **P005-G4-S03 — Serialized pump.** Nhiều caller cùng kick không tạo quá số slot cấu hình.
- [x] **P005-G4-S04 — Tách run-one-job.** Claim, heartbeat, process, failure và cleanup nằm trong một lifecycle có `finally`.
- [x] **P005-G4-S05 — Refill slot.** Hoàn tất một job kick pump; idle không busy-loop.
- [x] **P005-G4-S06 — Status quan sát.** Bổ sung object `worker` vào `/status` và unit test backward compatibility.
- [x] **P005-G4-S07 — Test giới hạn pool.** Với nhiều job nhỏ, peak active đúng 1 hoặc 2 theo cấu hình và không bao giờ là 3.

**Cổng G4:** pool chạy được hai lifecycle độc lập trong mock, nhưng production vẫn mặc định 1.

### G5 — Admission 10 MiB, FIFO và an toàn lifecycle

Mục tiêu: bật lane thứ hai chỉ trong miền tài nguyên đã chốt.

- [x] **P005-G5-S01 — Peek FIFO.** Đọc đúng job pending đến hạn lâu nhất mà không đổi trạng thái.
- [x] **P005-G5-S02 — Admission.** Lane đầu nhận job bất kỳ kích thước hợp lệ; lane hai chỉ nhận khi tổng không quá 10 MiB.
- [x] **P005-G5-S03 — Unknown size.** Job thiếu/sai `sourceSize` chỉ chạy khi không có active job.
- [x] **P005-G5-S04 — Atomic claim candidate.** Claim theo `_id` với đầy đủ guard; race trả null thì retry hữu hạn.
- [x] **P005-G5-S05 — Không bỏ qua FIFO.** Job lớn đứng đầu chặn lane hai; job nhỏ phía sau không được vượt hàng.
- [x] **P005-G5-S06 — Release reservation.** Success/fail/retry/cancel đều trả active byte về đúng một lần.
- [x] **P005-G5-S07 — Cancellation per-job.** Abort A không ảnh hưởng B; test cả hai thứ tự hoàn tất.
- [x] **P005-G5-S08 — Lease/recovery.** Hai heartbeat độc lập; chỉ lease hết hạn được recovery.
- [x] **P005-G5-S09 — Retry scheduling.** Một job chờ retry không tạo polling và không chặn job đến hạn hợp lệ sai chính sách FIFO.
- [x] **P005-G5-S10 — Hibernation.** Không refill khi ngủ; wake-up lấp lại pool; in-flight không bị xóa như user cancellation.
- [x] **P005-G5-S11 — Failure/circuit regression.** Chỉ quota-related failure tăng chuỗi; success/non-quota reset đúng trong thứ tự completion thực.
- [x] **P005-G5-S12 — Disk defense-in-depth.** Giữ capacity check hiện tại; test tổng admitted source không vượt 10 MiB khi hai download bắt đầu đồng thời.

**Cổng G5:** mọi test race/cancel/retry/lease đạt; không có đường chạy hai PDF lớn hoặc claim trùng.

### G6 — Regression, review và tài liệu vận hành

Mục tiêu: chứng minh thay đổi tối thiểu, tương thích và có thể rollback.

- [x] **P005-G6-S01 — Backend regression.** Chạy toàn bộ `npm test`.
- [x] **P005-G6-S02 — Frontend regression.** Chạy `npm test`, `npm run lint`, `npm run build`.
- [x] **P005-G6-S03 — Diff hygiene.** Chạy `git diff --check`; rà không có secret/PDF/artifact build bị stage.
- [x] **P005-G6-S04 — Review caller.** Xác nhận mọi đường add/confirm/retry/wakeup đều kick pump và mọi đường delete refresh stats.
- [x] **P005-G6-S05 — Review YAGNI.** Không dependency/abstraction/schema mới ngoài nhu cầu đã chốt; dùng helper/pattern sẵn có.
- [x] **P005-G6-S06 — Cập nhật README/env.** Mô tả concurrency, 10 MiB, status fields, cách rollback và ý nghĩa Ẩn.
- [x] **P005-G6-S07 — Ghi giới hạn.** Nêu rõ source bytes là proxy RAM và file lớn chạy đơn.

**Cổng G6:** test/lint/build sạch, diff đúng phạm vi và tài liệu đủ để vận hành concurrency 1 hoặc 2.

### G7 — Deploy additive và canary production

Mục tiêu: xác nhận hai lane trên Render trước khi bật cho hàng đợi thật.

- [ ] **P005-G7-S01 — Deploy code với concurrency 1.** Backend trước; xác nhận health/readiness/status/jobs/stats đạt.
- [ ] **P005-G7-S02 — Deploy frontend.** Xác nhận card, pagination và nút Ẩn trên production.
- [ ] **P005-G7-S03 — Kiểm hàng đợi sạch.** Trước canary, ghi pending/processing và không chen canary vào batch người dùng đang chạy.
- [ ] **P005-G7-S04 — Chuẩn bị fixture.** Tạo hai PDF một trang, tổng dưới 10 MiB, tên/ID riêng; không dùng tài liệu người dùng.
- [ ] **P005-G7-S05 — Bật concurrency 2.** Đặt Render env và restart; `/status.worker.concurrency` phải là 2.
- [ ] **P005-G7-S06 — Chạy canary.** Upload/confirm hai fixture đủ gần nhau để quan sát `processing=2` và `activeJobs=2`.
- [ ] **P005-G7-S07 — Cổng tài nguyên.** Peak RAM <80% instance; disk trong budget; không crash/restart/OOM.
- [ ] **P005-G7-S08 — Cổng quota/lifecycle.** Cả hai completed; 0 failed/retry/429/5xx/lease expiry; source R2/local và cleanup backlog trở về 0.
- [ ] **P005-G7-S09 — Kiểm output.** Result/download của hai job vẫn đúng contract P004; không trộn chunk/job.
- [ ] **P005-G7-S10 — Dọn canary.** Xóa job/batch fixture, xác nhận không object/chunk/source mồ côi.
- [ ] **P005-G7-S11 — Quyết định giữ hoặc rollback.** Nếu mọi cổng đạt, giữ 2; nếu bất kỳ cổng nào trượt, đặt env = 1, restart và ghi nguyên nhân.

**Cổng G7:** production chỉ được coi là concurrency 2 đạt khi có bằng chứng đồng thời, tài nguyên, quota, output và cleanup; không suy luận từ unit test.

### G8 — Đóng dự án và bàn giao theo dõi

Mục tiêu: hồ sơ phản ánh đúng thứ đã thực hiện, không phóng đại bằng chứng.

- [ ] **P005-G8-S01 — Cập nhật bảng tiến độ.** Đánh dấu từng bước theo bằng chứng thật.
- [ ] **P005-G8-S02 — Ghi commit/deploy.** Ghi hash, thời điểm Render/Vercel và giá trị concurrency không chứa secret.
- [ ] **P005-G8-S03 — Ghi kết quả canary.** Job count, kích thước fixture, peak active/RAM, lỗi và cleanup.
- [ ] **P005-G8-S04 — Chốt known gaps.** Nếu không theo dõi 24 giờ hoặc chưa thử file lớn, ghi rõ chưa làm.
- [ ] **P005-G8-S05 — Xác nhận không còn runner.** Không còn script/canary nền và bucket/queue trở về trạng thái mong đợi.
- [ ] **P005-G8-S06 — Đóng checklist.** Chỉ chuyển trạng thái tổng thành hoàn thành khi G0–G7 đạt hoặc có waiver rõ từ chủ dự án.

**Cổng G8:** tài liệu là nguồn theo dấu đầy đủ cho yêu cầu, quyết định, code, test, deploy, canary và rollback.

## 11. Bảng tiến độ tổng

| Giai đoạn | Nội dung | Trạng thái | Cổng nghiệm thu |
| --- | --- | --- | --- |
| G0 | Baseline và khóa contract | Hoàn thành | Baseline/test/worktree được ghi |
| G1 | Backend job stats | Hoàn thành cục bộ | Tổng MongoDB đúng, độc lập pagination |
| G2 | Dashboard realtime | Hoàn thành cục bộ | Tải thêm lịch sử không đổi số |
| G3 | Ẩn batch bền vững | Hoàn thành cục bộ | Safe-only, F5/SSE không phục hồi |
| G4 | Lõi worker pool | Hoàn thành cục bộ | Pool tối đa 2, default 1 |
| G5 | Admission/FIFO/lifecycle | Hoàn thành cục bộ | Tổng ≤10 MiB, cancel/lease/retry an toàn |
| G6 | Regression và tài liệu | Hoàn thành cục bộ | Backend/frontend/diff đạt |
| G7 | Deploy và canary | Chưa bắt đầu | Hai job thật đồng thời, tài nguyên/cleanup đạt |
| G8 | Bàn giao và đóng | Chưa bắt đầu | Bằng chứng và giới hạn được ghi đầy đủ |

## 12. Ma trận test bắt buộc

| Mã | Tình huống | Kết quả mong đợi |
| --- | --- | --- |
| T01 | Mongo có hơn 200 job, frontend mới tải 100 | Card dùng tổng MongoDB, không phải 100 |
| T02 | Bấm Tải thêm một hoặc nhiều lần | Dashboard không đổi nếu DB không đổi |
| T03 | Status pending→processing→completed qua SSE | Stats refresh theo transition và hiển thị đúng |
| T04 | Nhiều event stage cùng status processing | Không gọi `/jobs/stats` cho từng stage |
| T05 | Stats endpoint lỗi lần đầu | Hiện `—`, app/list job vẫn dùng được |
| T06 | Stats endpoint lỗi sau snapshot | Giữ snapshot cuối, reconnect thử lại |
| T07 | Ẩn một batch safe rồi F5 | Batch không xuất hiện lại |
| T08 | Ẩn tất cả khi có safe + unsafe | Chỉ safe biến mất; unsafe còn nguyên |
| T09 | Local storage JSON hỏng/bị chặn | App không crash, fallback memory |
| T10 | Concurrency = 1 | Peak active = 1, hành vi tương thích cũ |
| T11 | Hai job 3 MiB + 4 MiB | Cả hai được processing, tổng active 7 MiB |
| T12 | Hai job 6 MiB + 5 MiB | Job thứ hai chờ, không vượt 10 MiB |
| T13 | Job 30 MiB đứng đầu, job 1 MiB phía sau | Job 30 MiB chạy đơn; job nhỏ không vượt FIFO |
| T14 | Job legacy/thiếu sourceSize | Chỉ chạy đơn |
| T15 | 20 lời gọi startWorker đồng thời | Không quá 2 active, không claim trùng |
| T16 | Hủy job A khi A và B đang chạy | A abort/cleanup đúng; B tiếp tục |
| T17 | Một job quota retry, một job thành công | Trạng thái/failure counter/retry không trộn job |
| T18 | Một lease hết hạn, một lease còn heartbeat | Chỉ job hết hạn được recovery |
| T19 | Hibernation khi còn job in-flight | Không claim mới; không xóa in-flight như user cancel |
| T20 | Wake-up với nhiều pending nhỏ | Pump lấp tối đa 2 slot |
| T21 | Canary hai PDF nhỏ | active=2, completed=2, output không trộn |
| T22 | Canary cleanup | R2/local/chunk/job fixture được dọn, backlog 0 |

## 13. Rollout và rollback

### 13.1. Thứ tự rollout

1. Hoàn thành G0–G6 cục bộ.
2. Deploy backend với `TRANSLATION_WORKER_CONCURRENCY=1`.
3. Xác nhận endpoint additive và worker đơn ổn định.
4. Deploy frontend và kiểm dashboard/ẩn batch.
5. Khi queue người dùng không có job active, đặt concurrency = 2 và restart.
6. Chạy đúng hai fixture nhỏ, thu bằng chứng rồi dọn sạch.
7. Giữ 2 chỉ khi toàn bộ cổng G7 đạt.

### 13.2. Điều kiện rollback ngay

- Render OOM, restart bất thường hoặc RAM đạt từ 80% giới hạn.
- Active job vượt 2 hoặc active source vượt 10 MiB.
- Claim/process trùng job, chunk/result bị trộn hoặc cancellation ảnh hưởng job khác.
- 429/5xx/retry/lease expiry xuất hiện do canary concurrency.
- Disk/R2/local cleanup không trở về trạng thái sạch.

### 13.3. Cách rollback

- Đặt `TRANSLATION_WORKER_CONCURRENCY=1` trên Render và restart.
- Không migration ngược vì P005 không đổi schema.
- Job processing có lease/chunk hiện tại tiếp tục dùng recovery/resume sẵn có.
- Frontend và `/jobs/stats` có thể giữ nguyên vì không phụ thuộc concurrency 2.

## 14. Rủi ro và biện pháp kiểm soát

| Rủi ro | Biện pháp |
| --- | --- |
| Dashboard lại phụ thuộc pagination | Một endpoint aggregate riêng; test T01/T02 |
| SSE tạo quá nhiều query stats | Map trạng thái + debounce 500 ms |
| Batch an toàn hiện lại sau reconnect | Lọc hidden IDs ngay trong merge server batches |
| Người dùng vô tình che batch chưa upload đủ | Không cung cấp Ẩn cho unsafe; Ẩn tất cả chỉ chọn safe |
| Hai worker claim cùng job | Atomic `findOneAndUpdate` theo candidate + processing token |
| Hai file lớn vượt RAM/disk | Lane hai chỉ khi tổng source ≤10 MiB; unknown/large chạy đơn |
| Job lớn bị starvation | Không skip job FIFO đầu hàng để lấy file nhỏ hơn |
| Cancel nhầm job | Controller/heartbeat/active state lưu per-job trong Map |
| Hibernation abort làm mất job | Dừng refill, không dùng cancellation để dừng in-flight |
| Deploy tự tăng tải | Default env = 1; chỉ đổi 2 trong cửa sổ canary |
| Source bytes không phản ánh hoàn toàn RAM | Ngưỡng bảo thủ + canary Render; ghi rõ proxy và trần thiết kế |
| Worktree bẩn bị ghi đè | Chỉ sửa file P005 và file implementation đúng phạm vi; review status trước stage |

## 15. Nhật ký quyết định

| Ngày | Mã | Quyết định | Trạng thái |
| --- | --- | --- | --- |
| 17-07-2026 | D001 | Số lớn card thứ ba là tổng `completed`; dòng phụ là pending/processing/failed | Đã chốt |
| 17-07-2026 | D002 | Thống kê phải lấy từ toàn bộ MongoDB, không từ danh sách phân trang | Đã chốt |
| 17-07-2026 | D003 | Thêm “Ẩn tất cả” nhưng chỉ áp dụng batch đã an toàn | Đã chốt |
| 17-07-2026 | D004 | Ghi nhớ batch ẩn trong trình duyệt để F5/SSE không làm hiện lại | Đã chốt |
| 17-07-2026 | D005 | Thao tác Ẩn không xóa batch/job/object server | Đã chốt |
| 17-07-2026 | D006 | Worker tối đa hai lane, tổng source active không quá 10 MiB | Đã chốt |
| 17-07-2026 | D007 | File lớn hoặc không có size chạy đơn; không bỏ qua FIFO | Đã chốt |
| 17-07-2026 | D008 | Concurrency mặc định 1; canary đạt mới đặt production = 2 | Đã chốt |
| 17-07-2026 | D009 | Canary dùng hai PDF fixture nhỏ, không dùng tài liệu người dùng | Đã chốt |

## 16. Nhật ký bằng chứng

Chỉ thêm dòng khi bằng chứng đã thực sự được tạo hoặc quan sát.

| Ngày | Mã bước | Bằng chứng | Kết quả |
| --- | --- | --- | --- |
| 17-07-2026 | P005-PLAN | Đọc `log_vận_hành.md`; trace `App.jsx`, controller/routes, `QueueManager`, env, source/storage service và test hiện có | Xác định lỗi pagination, singleton worker, race disk admission và semantics Ẩn hiện tại; chưa sửa code ứng dụng |
| 17-07-2026 | P005-G0 | Branch `feature/project-003-translation-quality`, HEAD `5edce7aa58f067d3685a51b9eda23db43a25317a`; ghi nhận worktree bẩn và đọc diff các file giao nhau trước khi sửa | Baseline backend 104/104 test; frontend 13/13 test; lint/build đạt; không ghi đè thay đổi ngoài P005 |
| 17-07-2026 | P005-G1 | `jobStats.test.js`; aggregation `$match` bốn status + `$group`, fixture hỗn hợp/rỗng và controller lỗi DB | `/jobs/stats` trả đúng bốn key, điền 0 và không hydrate document |
| 17-07-2026 | P005-G2-G3 | `App.test.jsx` kiểm pagination, SSE debounce, lỗi stats, safe-only, remount, local storage bị chặn/JSON hỏng và không mutation server | Dashboard tách khỏi `/jobs`; batch ẩn không phục hồi qua remount/merge; frontend 20/20 test đạt |
| 17-07-2026 | P005-G4-G5 | `workerPool.test.js`, `queueClaim.test.js`, `cancellation.test.js`, `queueLeaseRecovery.test.js`, `env.test.js` | Default 1; pool 2 lane; 3+4 MiB chạy đôi, 6+5 MiB bị chặn; unknown/large chạy đơn; 20 kick không vượt 2/claim trùng; cancel/lease/hibernate/wake-up độc lập |
| 17-07-2026 | P005-G6 | Backend `npm test`: 116/116; frontend `npm test`: 20/20; `npm run lint`; `npm run build`; `git diff --check` | Toàn bộ regression/lint/build/diff hygiene đạt; README và `.env.example` đã cập nhật |
| 17-07-2026 | P005-QA-UI | Đã khởi động Vite local và thử kết nối Browser skill; môi trường trả danh sách browser rỗng; sau đó dừng đúng tiến trình Vite | DOM/accessibility test, lint và build đạt; visual browser QA chưa có bằng chứng và không được dùng thay cho canary G7 |

## 17. Tiêu chí đóng dự án

- [ ] Mọi bước G0–G8 hoàn thành hoặc có waiver rõ ràng từ chủ dự án.
- [ ] Dashboard đúng trên toàn bộ MongoDB và độc lập hoàn toàn với “Tải thêm lịch sử”.
- [ ] UX Ẩn/Ẩn tất cả safe-only, bền vững qua F5/SSE và không mutation server.
- [ ] Worker concurrency 1 tương thích cũ; concurrency 2 tuân thủ tổng 10 MiB và FIFO.
- [ ] Cancellation, retry, lease, hibernation, cleanup và circuit breaker không trộn trạng thái giữa hai job.
- [ ] Backend test và frontend test/lint/build đạt.
- [ ] Deploy additive, canary và rollback gate được ghi bằng bằng chứng thật.
- [ ] Không còn runner canary, file fixture hoặc object/job/chunk mồ côi khi đóng.
- [ ] Tài liệu ghi trung thực những phép đo chưa thực hiện; không gọi unit test là bằng chứng production.
