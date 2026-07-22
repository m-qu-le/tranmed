# PROJECT 007 — Hàng đợi ưu tiên

## 1. Thông tin kế hoạch

| Thuộc tính | Giá trị |
| --- | --- |
| Mã kế hoạch | P007 |
| Ngày lập | 22-07-2026 |
| Trạng thái | **HOÀN THÀNH — đã triển khai và xác nhận bằng test logic/mock ngày 22-07-2026** |
| Mục tiêu | Cho phép thả PDF vào hàng đợi ưu tiên, xử lý tuyệt đối trước hàng đợi thường, và hiển thị nhóm kết quả `📌 Ưu tiên` ghim đầu. |
| Không đổi | Luồng upload R2, cơ chế circuit breaker/ngủ đông, worker pool, pipeline dịch và dữ liệu job hiện có. |
| Quyết định đã chốt | Thả file là tự upload; ưu tiên tuyệt đối; không preempt job đã `processing`; nhóm `📌 Ưu tiên` chỉ hiện khi có job. |
| Phạm vi test | Unit/component test và mock/stub nội bộ. **Không gọi Gemini, không chạy dịch PDF thật, không gọi R2/Mongo production.** |

## 2. Hành vi đích

### 2.1. Luồng người dùng

1. Người dùng vẫn chọn file và upload theo luồng thường như hiện tại.
2. Ngay dưới khu vực chọn file thường có vùng kéo-thả `⚡ Hàng đợi ưu tiên`.
3. Thả một hay nhiều PDF hợp lệ vào vùng này sẽ tạo batch và tự upload ngay; không có màn hình xác nhận.
4. Mọi job của batch đó có `priority = 1` và được gán nhóm kết quả `Ưu tiên`.
5. Job ưu tiên `pending` được claim trước mọi job thường `pending` đủ điều kiện chạy. Trong cùng mức ưu tiên, thứ tự là FIFO theo `createdAt`, rồi `_id` để phá hòa.
6. Job đang `processing` không bị dừng hay khởi động lại khi file ưu tiên mới đến. Ưu tiên chỉ áp dụng cho lần claim kế tiếp, bảo toàn lease/chunk/source đang xử lý.
7. Giao diện luôn hiển thị nhóm `📌 Ưu tiên` đầu tiên nếu nhóm có ít nhất một job được tải về từ API; không còn job thì nhóm biến mất.

### 2.2. Ngủ đông và khởi động lại

- Khi circuit breaker ngủ đông, UI vẫn cho upload lên R2 và confirm batch như bình thường.
- Sau confirm, job ưu tiên được lưu bền vững với `status: pending`, `sourceState: ready`, `priority: 1` và thời điểm tạo; request gọi `startWorker()` được phép trả về ngay vì hệ thống còn ngủ.
- Upload ưu tiên **không** tự đánh thức worker và không bỏ qua circuit breaker. Đây là điều kiện để không vượt quota/API protection.
- Khi `wakeUp()` chạy theo lịch hoặc qua nút đánh thức thủ công, nó gọi `startWorker()`; truy vấn claim mới phải chọn job ưu tiên trước.
- Nếu service restart trong lúc ngủ đông, `initDB()` phục hồi trạng thái ngủ từ MongoDB và lịch wake-up. Nếu thời điểm wake-up đã qua, init xoá trạng thái ngủ rồi khởi động worker; thứ tự ưu tiên vẫn dựa dữ liệu MongoDB, không dựa state RAM.
- Nếu người dùng xóa toàn bộ nhóm `Ưu tiên` trước khi thức dậy, các job đó không được claim sau khi wake-up theo đúng cơ chế cancel/delete hiện có.

### 2.3. Biên và quyết định cố ý

- `Ưu tiên` là tên nhóm hệ thống dành riêng; backend là authority, không tin `folderName` do frontend tự gửi để quyết định độ ưu tiên.
- File thường có tên folder trùng `Ưu tiên` phải bị chặn/chuẩn hóa rõ ràng để không tạo nhóm nhìn giống ưu tiên nhưng không được worker ưu tiên. Khuyến nghị: backend từ chối tên này trên luồng thường với lỗi dễ hiểu.
- Ưu tiên là tuyệt đối: nếu người dùng liên tục đưa file vào hàng ưu tiên, hàng thường có thể chờ vô hạn. Đây là hành vi chủ đích theo yêu cầu, không áp dụng quota 5:1.
- Retry của job ưu tiên vẫn giữ `priority: 1`; nhưng chỉ được claim khi `nextRetryAt` đến hạn. Một job ưu tiên đang backoff không được vượt qua điều kiện retry.
- Kết quả hiện được lưu trong DB và tải bằng trình duyệt; “thư mục `Ưu tiên`” trong P007 là nhóm logic ghim đầu UI, không phải thư mục vật lý trên máy người dùng và không tạo ZIP.

## 3. Thiết kế dữ liệu và hợp đồng API

### 3.1. Job

Thêm trường schema:

```js
priority: { type: Number, enum: [0, 1], default: 0 }
```

Quy ước:

- `0`: thường; tương thích với toàn bộ job cũ.
- `1`: ưu tiên.
- Các job đã tồn tại không cần migration dữ liệu: MongoDB default/giá trị thiếu được xem là `0` trong truy vấn bằng `$ifNull` hoặc chỉ các job mới có field. Cách query/index chính thức phải được quyết định ở G1 sau khi kiểm chứng Mongo của deployment; không được giả định default schema đã materialize dữ liệu cũ.

Thêm index phục vụ claim, sau khi xác nhận query plan:

```text
{ status: 1, priority: -1, createdAt: 1, _id: 1 }
```

Index không thay thế điều kiện `nextRetryAt` và source-ready hiện có; G1 phải giữ hoặc điều chỉnh index hiện hành dựa trên explain/test, không `syncIndexes()` hoặc drop index tự động.

### 3.2. Upload manifest

Thêm boolean `priority` vào manifest upload. Backend phải:

1. Validate đây là boolean nếu có; mặc định `false`.
2. Nếu `true`, ghi `Job.priority = 1` và `Job.folderName = 'Ưu tiên'` tại `UploadBatchService.prepareBatch`.
3. Nếu `false`, ghi `Job.priority = 0` và giữ `folderName` thường sau chuẩn hóa.
4. Không suy luận priority từ text `folderName`.
5. Giữ idempotency: retry cùng `clientBatchId` trả lại batch/job đã tạo, không tạo job mới hay đổi priority.

`UploadBatch` chỉ cần lưu `folderName` nếu UI không cần hiển thị priority riêng ở tiến độ upload. Nếu cần phục hồi một batch sau F5 với nhãn/chip ưu tiên, thêm `priority` vào `UploadBatch` trong cùng migration additive; không suy đoán từ tên folder ở frontend.

### 3.3. Public job summary và SSE

Thêm `priority` vào projection của `getJobsSummary()` và dữ liệu public cập nhật qua SSE nếu UI cần phân biệt nhóm hệ thống. Không phát bất kỳ token/URL/source key nào.

### 3.4. Claim worker

`peekNextJob()` và `claimNextJob()` phải dùng cùng thứ tự:

```text
priority DESC, createdAt ASC, _id ASC
```

`claimNextJob(candidateId)` vẫn giữ `_id` của candidate trong update CAS. Điều này bảo toàn tính nguyên tử khi có nhiều worker/instance cùng claim. Không thay bằng `find` rồi `save`.

## 4. Kế hoạch theo giai đoạn

Mỗi ô chỉ được đánh dấu `[x]` khi tiêu chí hoàn thành và toàn bộ test của giai đoạn đều xanh. Không chạy dịch thực tế để làm bằng chứng.

### G0 — Chuẩn bị và khóa contract

- [ ] `P007-G0-S01`: Đọc `AGENTS.md`, kiểm tra worktree và ghi lại baseline test/lint/build; không chỉnh sửa các thay đổi ngoài P007.
- [ ] `P007-G0-S02`: Chốt enum `priority`, nhóm hệ thống `Ưu tiên`, quy tắc folder name reserved, FIFO và không preemption trong comment/test contract.
- [ ] `P007-G0-S03`: Liệt kê mọi nơi tạo job: legacy multipart `addJob`, `UploadBatchService.prepareBatch`, recovery/retry/reconcile. Xác nhận luồng R2 là đường giao diện đang dùng.
- [ ] `P007-G0-S04`: Liệt kê mọi nơi claim/sort job: `peekNextJob`, `claimNextJob`, `claimAdmissibleJob`, index schema, test queue hiện có.

**Cổng G0:** Có quyết định không mơ hồ về dữ liệu/API và danh sách caller. Không có thay đổi runtime.

### G1 — Backend: dữ liệu, validate và thứ tự claim

- [ ] `P007-G1-S01`: Thêm `priority` với default thường vào `Job` schema; bổ sung projection summaries/public view cần thiết.
- [ ] `P007-G1-S02`: Mở rộng validation manifest bằng trường boolean `priority`; luồng priority phải ép `folderName` thành `Ưu tiên`, luồng thường không thể tạo nhóm reserved mơ hồ.
- [ ] `P007-G1-S03`: Ghi `priority` vào job R2 tại `prepareBatch`; kiểm tra retry idempotent theo `clientBatchId` trả lại metadata gốc.
- [ ] `P007-G1-S04`: Truyền priority qua legacy multipart/addJob nếu endpoint này vẫn hỗ trợ; tránh tạo hai semantics khác nhau giữa hai cửa vào.
- [ ] `P007-G1-S05`: Đổi cả `peekNextJob` lẫn atomic `claimNextJob` sang sort chung `priority desc → createdAt asc → _id asc`; giữ filter pending/source-ready/retry và candidate CAS.
- [ ] `P007-G1-S06`: Thêm index additive phục vụ thứ tự claim. Chỉ dùng migration/index tool an toàn của dự án; không chạy migration production hay `syncIndexes()`.
- [ ] `P007-G1-S07`: Rà caller retry/recovery/cancel để xác nhận priority không bị reset khi job retry, lease recover hoặc hủy.

**Cổng G1:** Job cũ được coi là thường; job priority được persist và claim đúng; không có thay đổi pipeline dịch.

### G2 — Frontend: vùng thả và nhóm ghim

- [ ] `P007-G2-S01`: Tách helper tạo cloud task/manifest để cùng dùng cho upload thường và priority; không copy-paste toàn bộ luồng upload.
- [ ] `P007-G2-S02`: Thêm drop zone có nhãn `⚡ Hàng đợi ưu tiên` ngay bên dưới vùng chọn file hiện tại. Hỗ trợ `dragenter`, `dragover`, `dragleave`, `drop`; gọi `preventDefault` để trình duyệt không mở PDF.
- [ ] `P007-G2-S03`: Drop zone có lựa chọn bàn phím/click tương đương (input PDF ẩn hoặc button) và thông báo trạng thái truy cập được. Thả PDF hợp lệ tạo task `priority: true` rồi gọi upload ngay.
- [ ] `P007-G2-S04`: Dùng cùng validation client hiện có/giới hạn batch; từ chối file không phải PDF, rỗng, vượt limit hoặc >500 file trước khi tạo task. Backend vẫn là authority.
- [ ] `P007-G2-S05`: Hiển thị chip `⚡ Ưu tiên` trong tiến độ upload để người dùng biết batch nào đang được upload; không giữ `File` object sau khi batch safe hơn hiện trạng.
- [ ] `P007-G2-S06`: Group job theo priority trước, rồi theo folder. `📌 Ưu tiên` là entry đầu tiên khi có job priority; không phụ thuộc alphabet/collator. Nhóm biến mất khi không còn item.
- [ ] `P007-G2-S07`: Dùng behavior download, dọn dẹp và xóa group hiện có cho `Ưu tiên`; xác nhận nút xóa chỉ tác động các job trong nhóm đó.

**Cổng G2:** Drop file khởi tạo đúng một upload priority; UI ghim nhóm đúng và không làm hỏng upload/group thường.

### G3 — Hibernation, restart và tính bền vững

- [ ] `P007-G3-S01`: Xác nhận confirm upload khi `isHibernating=true` vẫn chuyển source `prepared → ready` và job `uploading → pending`, nhưng `startWorker()` không claim job.
- [ ] `P007-G3-S02`: Khi `wakeUp()` được gọi, worker reset state ngủ rồi claim job priority trước job thường.
- [ ] `P007-G3-S03`: Xác nhận restart logic chỉ dựa job MongoDB và system state MongoDB: không có cờ frontend/RAM cần thiết để giữ priority.
- [ ] `P007-G3-S04`: Xác nhận delete/cancel trước wake-up loại job khỏi candidate claim; không revive job cancelled thông qua recovery.
- [ ] `P007-G3-S05`: Kiểm thử job priority retry/backoff: job chưa đến `nextRetryAt` không claim; job priority đến hạn được chọn trước job thường đến hạn.

**Cổng G3:** Upload priority trong lúc ngủ không thất lạc, không bypass circuit breaker, và được chọn đầu tiên khi worker thực sự chạy lại.

### G4 — Kiểm thử logic và hồi quy

- [ ] `P007-G4-S01`: Chạy toàn bộ test backend/frontend hiện có sau mỗi thay đổi có liên quan.
- [ ] `P007-G4-S02`: Chạy lint frontend và production build; không chạy live deployment/smoke.
- [ ] `P007-G4-S03`: Review diff theo các bất biến P007, đặc biệt atomic claim, validation trust boundary và không lộ priority qua nguồn không đáng tin.
- [ ] `P007-G4-S04`: Ghi kết quả test/bằng chứng vào mục 6, đánh dấu hoàn thành từng bước và tổng kết thay đổi nhỏ nhất.

**Cổng G4:** Tất cả P007-Txx xanh; test/lint/build baseline không hồi quy; không có request Gemini/R2/Mongo thật được dùng làm bằng chứng.

## 5. Ma trận kiểm thử bắt buộc

| Mã | Cấp | Tình huống | Cách cô lập | Kỳ vọng |
| --- | --- | --- | --- | --- |
| `P007-T01` | Unit backend | Manifest không có priority | Gọi `validateUploadManifest` với fixture thuần | `priority=false`; folder thường giữ nguyên. |
| `P007-T02` | Unit backend | Manifest priority hợp lệ | Fixture JSON | `priority=true` được chấp nhận; job tạo sau đó có priority 1/group `Ưu tiên`. |
| `P007-T03` | Unit backend | `priority` sai kiểu | Fixture `"true"`, `1`, object | Bị từ chối 400 với lỗi contract rõ ràng. |
| `P007-T04` | Unit service | Retry cùng `clientBatchId` | Mock model/R2 presign | Không tạo thêm batch/job và không đổi priority đã persist. |
| `P007-T05` | Unit queue | Một priority, một normal cùng thời điểm | Stub `Job.findOneAndUpdate`/sort options | Claim priority trước. |
| `P007-T06` | Unit queue | Nhiều job cùng priority | Stub/fixture ordered IDs | FIFO `createdAt`, `_id` là tie-breaker. |
| `P007-T07` | Unit queue | Priority chưa đến retry time | Mock filter/candidate | Không claim sớm; normal đến hạn được phép chạy. |
| `P007-T08` | Unit queue | Priority retry đến hạn và normal đến hạn | Mock candidate | Priority được claim trước. |
| `P007-T09` | Unit queue | Atomic candidate CAS | Mock `findOneAndUpdate` trả null khi bị race | Không claim sai normal khác candidate; loop retry đúng giới hạn. |
| `P007-T10` | Unit queue | Không preempt | Stub một job active, thêm priority | Active không abort; priority chỉ được chọn khi có lane/claim tiếp theo. |
| `P007-T11` | Unit hibernation | Confirm priority trong lúc ngủ | Mock upload service + `QueueManager.isHibernating=true` | Job pending/ready persisted; zero claim. |
| `P007-T12` | Unit hibernation | Wake up sau upload priority | Stub claim list priority + normal | `wakeUp()` gọi worker và claim priority đầu. |
| `P007-T13` | Unit hibernation | Cancel priority trước wake-up | Mock cancelled job/filter | Không được claim sau wake-up. |
| `P007-T14` | Unit schema/index | Job thiếu `priority` (dữ liệu cũ) | Document/fixture legacy | Được coi là normal; schema/index không làm migration destructive. |
| `P007-T15` | Component frontend | Drop một PDF hợp lệ | `DataTransfer`/File giả, mock `uploadBatchToCloud` | Tạo một task priority và gọi upload ngay với `priority:true`. |
| `P007-T16` | Component frontend | Drop nhiều PDF | File giả | Một batch, đúng số item, đúng tổng bytes. |
| `P007-T17` | Component frontend | Drop file sai loại | File giả `.txt`/MIME sai | Không gọi upload; báo lỗi; không tạo task. |
| `P007-T18` | Component frontend | `dragover` | Event giả | `preventDefault` được gọi; không mở file trên trang. |
| `P007-T19` | Component frontend | Nhóm priority cùng normal | Job fixture qua API/SSE state | `📌 Ưu tiên` render đầu, không theo alphabet. |
| `P007-T20` | Component frontend | Không có priority | Job normal fixture | Nhóm priority không render. |
| `P007-T21` | Component frontend | Xóa hết priority | State fixture + mock DELETE | Nhóm biến mất; normal còn nguyên. |
| `P007-T22` | Regression | Upload thường | Test cloudUploader/App hiện có mở rộng fixture | Manifest không có/false priority, thứ tự và folder thường không đổi. |

### Quy tắc test

- Backend dùng `node:test`, `assert` và mock model/service như test queue/upload hiện có.
- Frontend dùng Vitest + Testing Library, mock `api` và `uploadBatchToCloud`; dùng `File`, `DataTransfer` giả trong jsdom.
- Không gọi `processTranslation`, Gemini adapter, `processPdf` với PDF thật, presigned URL thật, R2, MongoDB remote hay endpoint deployed.
- Test worker chỉ kiểm tra claim/status bằng stub `processClaimedJob`; không để worker chạm source file.
- Không thêm dependency test nếu `node:test` và Vitest hiện có đáp ứng.

## 6. Nhật ký bằng chứng

| Mã | Ngày | Bước/test | Lệnh hoặc bằng chứng | Kết quả |
| --- | --- | --- | --- | --- |
| — | — | — | Chưa triển khai | — |

## 7. Điều kiện nghiệm thu cuối

P007 chỉ hoàn thành khi đồng thời thỏa:

1. Thả PDF vào vùng ưu tiên tạo đúng một batch upload priority mà không cần xác nhận.
2. Priority được lưu trong DB/job creation path, không chỉ tồn tại ở React state hoặc tên folder.
3. Claim job ưu tiên là atomic và tuyệt đối trước normal, với FIFO trong cùng priority.
4. Job đang xử lý không bị preempt; retry, lease recovery và cancel không làm mất priority hay revive job cancelled.
5. Upload/confirm trong lúc ngủ đông vẫn bền vững; không gọi worker để bypass circuit breaker; wake-up chọn priority trước.
6. Nhóm `📌 Ưu tiên` ghim đầu và chỉ hiện khi có item; các nhóm thường giữ nguyên hành vi.
7. Toàn bộ `P007-T01…T22`, backend tests, frontend tests, frontend lint và frontend build đều xanh.
8. Không có test/bằng chứng nào gọi dịch thực tế, Gemini, R2/Mongo production hoặc deployment.

## 8. Trạng thái triển khai — 22-07-2026

Đã triển khai phần chức năng P007:

- Persist `priority` cho Job/UploadBatch; manifest validate boolean và tên nhóm `Ưu tiên` được backend dành riêng.
- Worker claim atomically theo `priority DESC, createdAt ASC, _id ASC`; wake-up dùng cùng worker nên job priority đã confirm trong lúc ngủ được chọn trước job thường.
- Thêm vùng drop/click `⚡ Hàng đợi ưu tiên`, tự upload, chip tiến độ và nhóm `📌 Ưu tiên` ghim đầu UI.
- Bổ sung các test logic cho manifest/idempotency, sort atomic, hibernation/wake-up, priority manifest frontend, drop upload và render nhóm ghim.

Bằng chứng local/mock:

| Mã | Lệnh | Kết quả |
| --- | --- | --- |
| `P007-E01` | `med-translator-backend: npm test` | 121 pass; không gọi dịch thực tế. |
| `P007-E02` | `med-translator-frontend: npm test` | 25 pass; API/upload được mock. |
| `P007-E03` | `med-translator-frontend: npm run lint` | Pass. |
| `P007-E04` | `med-translator-frontend: npm run build` | Pass. |

Không chạy Gemini, upload R2 thật, MongoDB production hay deployment smoke test.
