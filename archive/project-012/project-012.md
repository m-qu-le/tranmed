# PROJECT 012 — Đưa MongoDB Atlas về US East gần Render Ohio

| Thuộc tính | Giá trị |
| --- | --- |
| Mã dự án | `P012` |
| Ngày mở | 24-07-2026 |
| Trạng thái | **ĐÃ ĐÓNG — controlled cold start, cutover và canary PASS; rollback window Hong Kong còn hiệu lực** |
| Nhánh | `main` |
| Production backend | `https://tranmed.onrender.com` — Render Ohio (US East) |
| MongoDB nguồn | Atlas Free, AWS Hong Kong `ap-east-1` |
| MongoDB đích | Project `TranMed-US`, Free cluster `tranmed-us-prod`, AWS Northern Virginia `us-east-1` / `US_EAST_1` |
| Dự án tiền nhiệm đang mở lại | `../../project-011/project-011.md` |
| Mục tiêu | Giữ backend ở Ohio để gọi Google API như hiện tại, đồng thời đưa MongoDB về gần backend để giảm Mongo p95 và tăng throughput |
| Phạm vi | Controlled cold start trên DB trắng, bootstrap, cutover và rollback URI; không restore lịch sử, không chuyển R2 và không thay đổi quality pipeline |

> P012 đã được thực thi ngày 24-07-2026 bằng controlled cold start. Các phần
> `mongodump → mongorestore` phía dưới được giữ làm lịch sử thiết kế, không phải runbook
> đã dùng. Việc giữ cluster Hong Kong trong rollback window và thiết lập backup định kỳ
> là công việc vận hành sau khi đóng dự án.

## 0. Quyết định cập nhật — controlled cold start

Phần này thay thế phương án `mongodump → mongorestore` được mô tả trong các phần cũ của
hồ sơ:

- Chủ hệ thống chấp nhận lịch sử folder/job cũ biến mất khỏi giao diện.
- Các bản dịch cần giữ sẽ được tải xuống dưới dạng `.md` trước cutover.
- Hàng đợi cũ phải chạy xong và được xóa qua ứng dụng để luồng cleanup R2 hoàn tất.
- Target `studymed_translator` được bootstrap như một database trắng; không restore dữ
  liệu Hong Kong.
- Cluster Hong Kong vẫn được giữ 7–14 ngày làm rollback safety net.
- Target dùng database user `tranmed_app`. Tại thời điểm cutover, tài khoản đang có
  role rộng `readWriteAnyDatabase@admin`; thu hẹp về `readWrite` chỉ trên
  `studymed_translator` là khoản hardening sau đóng dự án.

### Ngoại lệ Network Access đã được chấp nhận

Chủ hệ thống quyết định giữ Atlas IP Access List `0.0.0.0/0` vì đây là hệ thống cá nhân
nhỏ. Đây là ngoại lệ bảo mật được chấp nhận, không phải cấu hình khuyến nghị. Các kiểm
soát tối thiểu còn lại là:

- password mạnh do Atlas tạo;
- không commit, gửi qua chat, chụp ảnh hoặc ghi log connection URI;
- không dùng `tranmed_app` cho tác vụ quản trị và cần thu hẹp role khi thực hiện
  hardening;
- thay password ngay nếu URI có khả năng đã bị lộ.

### Công cụ P012

- `npm run bootstrap:p012`: nhận password qua `P012_TARGET_PASSWORD`, tự tạo URI target,
  kiểm tra đúng database
  và target cluster, từ chối chạy nếu đã có job/chunk/upload batch, sau đó tạo index và
  state khởi đầu.
- `npm run verify:p012`: kiểm tra read-only DB trắng, quota/scheduler/system state và
  index.

Các bước backup/restore/digest chi tiết ở phần cũ được giữ làm lịch sử thiết kế nhưng
không còn là runbook đang được chọn.

### Kết quả bootstrap target

Thời điểm xác nhận: 24-07-2026.

- Atlas project: `TranMed-US`.
- Cluster: `tranmed-us-prod`.
- Tier/provider/region: Free / AWS / Northern Virginia `us-east-1`.
- Database: `studymed_translator`.
- Bootstrap: **PASS**.
- Verify read-only sau bootstrap: **PASS**.
- Operational data: `jobs=0`, `translationchunks=0`, `uploadbatches=0`.
- Initial state: `geminiquotastates=50`, `geminischedulerstates=1`, `systems=1`.
- Index: không thiếu index trên cả 6 collection.
- Kết quả này được ghi trước cutover; phần “Kết quả cutover Render” bên dưới là trạng
  thái cuối của dự án.

### Kết quả drain và cleanup source

Thời điểm xác nhận: 24-07-2026.

- `pending=0`, `processing=0`, `completed=0`, `failed=0`.
- Không còn folder/job trên production.
- `worker.activeJobs=0`, `dispatcher.activeStages=0`, stage queue bằng 0.
- `uploadBacklog=0`, `cleanupBacklog=0`.
- Không còn terminal failure.
- Source đã đạt gate để suspend Render và cutover URI.

### Kết quả cutover Render

Thời điểm backend mới khởi động: `2026-07-24T08:32:48.238Z`.

- Render đã dùng target MongoDB US.
- `/api/health`: PASS.
- `/api/readiness`: PASS; database và storage đều available.
- Job stats trên target: toàn bộ bằng 0, không có folder.
- Scheduler hydrate đúng state `p012_empty_bootstrap`, group 1/10 và đủ 50 project.
- Worker/stage/upload/cleanup backlog đều bằng 0.
- Chưa mở production batch; đang chờ canary.

### Kết quả canary

Canary: `study-med-project-001-smoke.pdf`, folder `P012 Canary`.

- Trạng thái: completed ngay lần đầu, không retry và không lỗi.
- Thời gian xử lý khoảng 21 giây.
- Quality: 1/1 chunk passed, không có needs-review warning.
- Gemini: 5 logical / 5 physical, amplification `1.0`, không 429.
- Mongo operation: average 20 ms, p95 31 ms.
- Quota reserve: p95 21 ms; quota release: p95 31 ms.
- Chunk transition: p95 26 ms; job progress: 36 ms.
- Worker/stage/upload/cleanup backlog sau canary đều bằng 0.

So với Hong Kong, Mongo operation p95 đã giảm từ khoảng 598–757 ms xuống 31 ms trên
canary. Functional và performance gate ban đầu đều PASS.

## 1. Quyết định kiến trúc

Giữ backend tại Render Ohio và chuyển MongoDB tới AWS Ohio là hướng hợp lý cho hệ thống
hiện tại:

- Vị trí backend quyết định nơi phát sinh request tới Google/Gemini API. Chuyển riêng
  MongoDB không làm thay đổi vị trí địa lý của request Google.
- Backend và MongoDB hiện nằm ở hai phía Thái Bình Dương. Mỗi lượt Mongo tuần tự phải
  trả thêm độ trễ mạng liên vùng.
- Người dùng truy cập frontend không kết nối trực tiếp MongoDB; Mongo latency quan trọng
  nhất là đường `Render → Atlas → Render`.

### Phương án được khuyến nghị

Tạo một **Atlas project mới**, tạo một Free cluster mới tại AWS Ohio, sau đó dùng
`mongodump → mongorestore`.

Lý do:

- Atlas Free không cho đổi cloud provider/region trực tiếp khi vẫn giữ nguyên Free tier.
- Mỗi Atlas project thông thường chỉ có một Free cluster; project mới cho phép giữ cluster
  Hong Kong nguyên vẹn làm nguồn rollback.
- Atlas Free không có Cloud Backup. Không được xóa cluster nguồn trước khi restore và
  đối soát hoàn tất.
- Dữ liệu hiện tại khoảng 60,7 MB, còn cách xa giới hạn 0,5 GB của Free cluster.

### Phương án thay thế có phí

Nâng cluster hiện tại lên tier lớn hơn và chọn lại region trong lúc nâng cấp. Atlas sẽ
migrate dữ liệu trong quy trình thay đổi cluster. Phương án này ít thao tác dữ liệu hơn
nhưng phát sinh phí, vẫn cần backup độc lập và maintenance/cutover gate. Không chọn phương
án này mặc định nếu mục tiêu là tiếp tục vận hành miễn phí.

## 2. Nhận xét về quy trình ban đầu

Ý tưởng “chờ hàng đợi chạy hết rồi mới chuyển DB” là đúng. Các phần cần sửa:

1. **Không cần tải toàn bộ file R2 để chuyển MongoDB.**
   MongoDB lưu queue, metadata, quota/scheduler state và nội dung dịch theo chunk. PDF
   nguồn nằm ở R2; chuyển DB không đổi bucket hay object R2.
2. **Có thể tải toàn bộ bản dịch hoàn tất về máy như một lớp bảo hiểm độc lập.**
   Việc này nên làm, nhưng là recovery copy cho con người, không thay thế backup MongoDB.
3. **Không được xóa cluster Hong Kong ngay sau cutover.**
   Giữ tối thiểu 7 ngày, khuyến nghị 14 ngày, đồng thời phải đạt toàn bộ acceptance gate.
4. **Không chỉ dùng script `backup:p003`.**
   Script này bỏ sót `geminiquotastates` và `geminischedulerstates` được P011 bổ sung.
   Mất hai collection này có thể làm sai quota, group cursor và gây request amplification/
   429 sau khi khởi động lại.
5. **Phải chặn ghi, không chỉ nhìn thấy `activeJobs=0`.**
   Dump cuối chỉ nhất quán khi không có upload mới, không còn stage/Gemini in-flight,
   cleanup/reconcile backlog bằng 0 và Render đã được suspend trước khi dump.

## 3. Bằng chứng production ngày 24-07-2026

| Mã | Bằng chứng | Kết quả |
| --- | --- | --- |
| `P012-E001` | Vị trí dịch vụ | Render: Ohio (US East); Atlas: AWS Hong Kong `ap-east-1` |
| `P012-E002` | `/api/translate/metrics` | `mongodb.operation.latency`: count 1.975, average 260 ms, p95 **578 ms**, max 990 ms |
| `P012-E003` | Mongo operation con | quota reserve p95 205 ms; quota release 206 ms; lease 203 ms; job progress 465 ms; chunk transition **762 ms** |
| `P012-E004` | Resource Render | RSS khoảng 42%; event-loop p95 21 ms; không có dấu hiệu CPU/event-loop là nguyên nhân chính tại thời điểm đo |
| `P012-E005` | Limiter | Concurrency tự giảm 5 → 4 với lý do `resource_pressure`, trong khi rate-limit ratio bằng 0; Mongo p95 là resource gate vi phạm |
| `P012-E006` | 20 request không chạm DB | HTTP p50 257 ms, p95 292 ms |
| `P012-E007` | 20 request cùng đường đi có `admin().ping()` | HTTP p50 428 ms, p95 473 ms; phần tăng thêm khoảng **171–181 ms** |
| `P012-E008` | 50 ping Việt Nam → Atlas Hong Kong | p50 35 ms, p95 62 ms, max 67 ms |
| `P012-E009` | Kết luận network | Render Ohio → Atlas Hong Kong tạo mặt sàn xấp xỉ 170–200 ms cho mỗi Mongo round trip |
| `P012-E010` | Kích thước chunk trong backup | 2.227 chunk: p50 khoảng 23 KB, p95 khoảng 54 KB, lớn nhất khoảng 118 KB |
| `P012-E011` | Trạng thái P011 | 482 logical-issued, 507 physical, amplification 1,052; 79 chunk terminal; Mongo latency vẫn chặn tăng concurrency |

Khoảng cách vùng là nguyên nhân đã được thực nghiệm xác nhận, nhưng không phải nguyên
nhân duy nhất của p95 tổng:

- Quota/lease khoảng 203–206 ms phản ánh rõ mặt sàn network.
- `job_progress` gồm một nhóm read rồi một write tuần tự, nên 465 ms phù hợp với nhiều
  round trip liên vùng.
- `chunk_transition` trả lại document sau `findOneAndUpdate`; document lớn cộng với
  Atlas Free shared compute/storage tạo thêm tail latency. Sau khi đồng vùng vẫn phải đo
  lại trước khi kết luận đã hết bottleneck.

## 4. Kiểm kê MongoDB nguồn

Kiểm kê read-only production tại thời điểm mở P012:

| Collection | Documents | Indexes kể cả `_id_` |
| --- | ---: | ---: |
| `geminiquotastates` | 50 | 3 |
| `geminischedulerstates` | 1 | 2 |
| `jobs` | 286 | 16 |
| `systems` | 1 | 2 |
| `translationchunks` | 2.368 | 5 |
| `uploadbatches` | 6 | 5 |
| **Tổng** | **2.712** | **33** |

Dung lượng:

- Logical data: `60.683.519` byte.
- Storage: `62.300.160` byte.
- Index: `1.581.056` byte.

Trạng thái hàng đợi tại thời điểm kiểm kê:

- `completed`: 196 job.
- `failed`: 8 job.
- `pending`: 79 job.
- `processing`: 3 job.

P012 **chưa sẵn sàng cutover** vì còn 82 job pending/processing.

## 5. Bất biến an toàn

- Không ghi Mongo URI, username, password, Atlas project ID hoặc API key vào repository,
  ticket, ảnh chụp hay log.
- Không xóa, pause vĩnh viễn hoặc sửa cluster Hong Kong trong giai đoạn chuẩn bị.
- Không cho source và target cùng nhận production write.
- Không chạy hai Render service cùng xử lý một queue.
- Không dùng `mongoexport/mongoimport` làm bản chuyển chính vì BSON type và index cần
  được giữ nguyên.
- Bản chuyển chính phải là `mongodump --archive --gzip`; EJSON chỉ là bản dự phòng.
- Dump cuối chỉ được tạo sau write freeze.
- Target phải trống trước final restore; không dùng `--drop` nếu chưa xác nhận chính xác
  target.
- Không tiếp tục nếu bất kỳ collection, document count, index hoặc digest nào lệch.
- Cluster Hong Kong chỉ được xóa sau rollback window và acceptance gate.

## 6. Công cụ phải chuẩn bị trước maintenance

### 6.1 MongoDB Database Tools

Tại thời điểm mở P012, `mongodump` và `mongorestore` chưa có trong `PATH` của máy thao
tác. Cài bản stable mới nhất tương thích MongoDB 8.0 và xác nhận:

```powershell
mongodump --version
mongorestore --version
```

Không bắt đầu maintenance nếu một trong hai lệnh không chạy được.

### 6.2 Script P012 cần bổ sung trước khi thực thi

Không dùng thủ công các con số trong tài liệu này làm verification cuối. Cần tạo:

- `scripts/backup-project-012.js` hoặc wrapper gọi `mongodump`, tạo SHA-256 và manifest.
- `scripts/verify-project-012-migration.js`, nhận source/target URI qua environment:
  - so collection set;
  - so document count;
  - so toàn bộ index key/options;
  - tính canonical EJSON digest theo `_id` nhưng không in nội dung document;
  - kiểm tra mọi `translationchunks.jobId` có job cha;
  - kiểm tra `geminiquotastates=50` và `geminischedulerstates=1`;
  - kiểm tra job status distribution;
  - không sửa dữ liệu.
- Unit test cho parser manifest và failure khi lệch collection/index/digest.

### 6.3 Atlas target

1. Tạo Atlas project mới, ví dụ `TranMed-Ohio`.
2. Tạo Free cluster mới:
   - Provider: AWS.
   - Region: Ohio `us-east-2` / `US_EAST_2` nếu Atlas UI cho chọn.
   - MongoDB major version phải tương thích nguồn.
3. Tạo database user riêng cho target, chỉ cấp `readWrite` trên
   `studymed_translator`; không tái sử dụng password nguồn.
4. Cấu hình Network Access hẹp nhất mà Render cho phép. Nếu buộc phải mở public access,
   phải dùng password mạnh, TLS và không cấp quyền ngoài database ứng dụng.
5. Không đưa target URI lên Render ở bước này.

## 7. Runbook migration

### Phase A — rehearsal khi production vẫn chạy

1. Tạo target cluster và xác nhận `admin().ping()` thành công.
2. Tạo một dump rehearsal từ nguồn.
3. Restore vào namespace tạm trên target:

```powershell
$env:P012_SOURCE_URI = "<source-uri-khong-commit>"
$env:P012_TARGET_URI = "<target-uri-khong-commit>"
$p012BackupRoot = Join-Path (Get-Location) "archive\project-012\backups"
New-Item -ItemType Directory -Force -Path $p012BackupRoot | Out-Null
$p012RehearsalArchive = Join-Path $p012BackupRoot "p012-rehearsal.archive.gz"

mongodump `
  --uri $env:P012_SOURCE_URI `
  --db studymed_translator `
  --archive $p012RehearsalArchive `
  --gzip

if ($LASTEXITCODE -ne 0) { throw "P012 rehearsal mongodump thất bại." }

mongorestore `
  --uri $env:P012_TARGET_URI `
  --archive $p012RehearsalArchive `
  --gzip `
  --stopOnError `
  --nsFrom "studymed_translator.*" `
  --nsTo "studymed_translator_p012_rehearsal.*"

if ($LASTEXITCODE -ne 0) { throw "P012 rehearsal mongorestore thất bại." }
```

4. Chạy verifier giữa nguồn và namespace rehearsal.
5. Chỉ xóa database rehearsal sau khi verifier pass và đã ghi manifest.
6. Xóa URI khỏi phiên shell sau khi hoàn tất:

```powershell
Remove-Item Env:P012_SOURCE_URI -ErrorAction SilentlyContinue
Remove-Item Env:P012_TARGET_URI -ErrorAction SilentlyContinue
```

Rehearsal không phải final backup vì production vẫn phát sinh write.

### Phase B — drain hàng đợi

1. Dừng tạo upload mới. Không chỉ pause dispatcher trong khi vẫn cho upload.
2. Cho 79 pending và 3 processing hiện tại chạy tới terminal.
3. Tải toàn bộ kết quả hoàn tất về storage riêng nếu muốn có recovery copy ngoài hệ
   thống.
4. Gate bắt buộc trước write freeze:
   - `pending=0`;
   - `processing=0`;
   - `worker.activeJobs=0`;
   - `dispatcher.activeStages=0`;
   - `gemini.activeLogicalRequests=0`;
   - mọi project `inFlightRequests=0`;
   - `uploadBacklog=0`;
   - `cleanupBacklog=0`.
5. Ghi lại counts, status distribution, collection/index inventory và telemetry cuối.

Không được hiểu “hàng đợi đã hết” chỉ từ giao diện không còn thanh tiến trình.

### Phase C — write freeze và final dump

1. Tạm dừng upload/frontend.
2. Suspend Render service để không còn process nào có thể ghi vào MongoDB nguồn.
   `isMaintenancePaused` hiện chỉ nằm trong memory và sẽ mất sau redeploy, vì vậy không
   được dùng riêng cờ này làm write lock xuyên suốt cutover.
3. Chờ toàn bộ connection từ Render đóng; xác nhận không còn active application session
   nếu Atlas UI cung cấp số liệu.
4. Tạo final dump:

```powershell
$env:P012_SOURCE_URI = "<source-uri-khong-commit>"
$p012BackupRoot = Join-Path (Get-Location) "archive\project-012\backups"
New-Item -ItemType Directory -Force -Path $p012BackupRoot | Out-Null
$p012Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$p012FinalArchive = Join-Path $p012BackupRoot "p012-final-$p012Timestamp.archive.gz"

mongodump `
  --uri $env:P012_SOURCE_URI `
  --db studymed_translator `
  --archive $p012FinalArchive `
  --gzip

if ($LASTEXITCODE -ne 0) { throw "P012 final mongodump thất bại." }

$p012FinalHash = Get-FileHash -Algorithm SHA256 -LiteralPath $p012FinalArchive
$p012FinalHash
```

5. Lưu archive, SHA-256, kích thước, timestamp, counts và tool versions trong manifest.
6. Sao chép archive đã mã hóa tới một vị trí ngoài máy đang thao tác.
7. Không resume source sau final dump.

### Phase D — final restore và đối soát

1. Xác nhận database production trên target đang trống.
2. Restore final archive:

```powershell
$env:P012_TARGET_URI = "<target-uri-khong-commit>"

mongorestore `
  --uri $env:P012_TARGET_URI `
  --archive $p012FinalArchive `
  --gzip `
  --stopOnError

if ($LASTEXITCODE -ne 0) { throw "P012 final mongorestore thất bại." }
```

3. Chạy verifier P012 source snapshot ↔ target.
4. Kiểm tra tối thiểu:
   - đúng 6 collection ứng dụng;
   - counts khớp manifest final;
   - đủ 33 index hoặc đúng inventory final nếu schema đã đổi trước maintenance;
   - quota state và scheduler state tồn tại;
   - job/chunk references hợp lệ;
   - download một số kết quả lịch sử từ target bằng script read-only.
5. Nếu lệch một mục, dừng. Không sửa tay vài document để “cho bằng”.

### Phase E — cutover Render

1. Lưu URI Hong Kong ở secret manager phục vụ rollback; không xóa.
2. Thay duy nhất `MONGODB_URI` trên Render bằng target Ohio URI.
3. Deploy/resume đúng một Render service.
4. Chưa mở upload cho người dùng.
5. Xác nhận:
   - `/api/health` HTTP 200;
   - `/api/readiness` HTTP 200 và database/storage available;
   - `/api/translate/status` không có active/pending job ngoài canary;
   - lịch sử folder/job và kết quả cũ đọc được;
   - key pool/scheduler state không bị reset bất thường.
6. Chạy một canary PDF có thể bỏ, không dùng tài liệu quan trọng.
7. Nếu phải rollback trong canary, canary được phép bỏ; không có production write mới
   nào cần merge về Hong Kong.

### Phase F — performance acceptance

So cùng loại workload với baseline P012:

- Render→Mongo ping tăng thêm: mục tiêu p50 ≤50 ms, p95 ≤100 ms.
- `mongodb.quota_reserve.latency` p95 <100 ms sau tối thiểu 100 mẫu.
- `mongodb.quota_release.latency` p95 <100 ms sau tối thiểu 100 mẫu.
- `mongodb.operation.latency` p95 <200 ms sau tối thiểu 200 mẫu.
- Không có persist/lease error.
- Event-loop p95 <200 ms và RSS <80%.
- Physical/logical-issued ≤1,15.
- Không duplicate/mất stage; kết quả canary tải được.

Nếu overall Mongo p95 vẫn cao nhưng quota/lease đã giảm, điều tra riêng
`mongodb.chunk_transition.latency`; không kết luận migration thất bại chỉ vì operation
document lớn vẫn chậm.

### Phase G — mở lại production

Chỉ mở upload sau khi Phase D–F pass. Ghi rõ thời điểm bắt đầu production write trên
Ohio.

Từ thời điểm này, rollback không còn là đổi URI đơn giản vì Ohio sẽ có dữ liệu mới mà
Hong Kong không có. Nếu cần rollback sau khi đã mở production, phải:

1. đóng băng write Ohio;
2. dump Ohio;
3. lập kế hoạch forward-copy phần dữ liệu mới về Hong Kong hoặc chấp nhận RPO được phê
   duyệt;
4. verify lại trước khi đổi URI.

## 8. Rollback trước khi mở production write

Rollback ngay nếu:

- restore/verifier lệch collection, count, index hoặc digest;
- readiness không xanh;
- mất folder/job/result lịch sử;
- quota/scheduler state bị reset;
- có lỗi persist, lease, duplicate hoặc mất stage;
- Mongo p95 không cải thiện và có regression chức năng.

Quy trình:

1. Suspend Render đang trỏ Ohio.
2. Không xóa hoặc sửa target; giữ để forensic.
3. Đổi `MONGODB_URI` về Hong Kong.
4. Resume/deploy Render.
5. Xác nhận health/readiness/history.
6. Chỉ mở upload lại khi source cũ hoạt động bình thường.

Rollback này an toàn vì chưa cho production write mới vào Ohio.

## 9. Retention và xóa cluster nguồn

Không xóa Hong Kong chỉ vì canary đầu tiên pass.

Điều kiện tối thiểu để cân nhắc xóa:

- ít nhất 7 ngày ổn định; khuyến nghị 14 ngày;
- ít nhất hai batch production thực tế hoàn tất;
- không có mất job/chunk/result và không có lỗi persist/lease;
- performance gate đạt trên cửa sổ tải tương đương;
- final archive đã restore thử thành công và có bản mã hóa ngoài máy thao tác;
- manifest, hash, counts, indexes và timestamp đã ghi vào hồ sơ P012;
- phương án backup định kỳ cho Free cluster Ohio đã hoạt động.

Trước khi xóa:

1. tạo thêm một dump cuối của cluster Hong Kong;
2. kiểm tra SHA-256 và khả năng restore;
3. xác nhận Render không còn dùng source URI;
4. thu hồi database user nguồn;
5. chỉ sau đó mới xóa cluster/project Hong Kong.

Xóa cluster là thao tác không thể hoàn tác bằng Atlas Cloud Backup vì Free tier không
có tính năng này.

## 10. Backup sau migration

Free cluster không phù hợp với production nếu không có backup ngoài Atlas. Sau P012 cần:

- `mongodump --archive --gzip` định kỳ;
- mã hóa archive trước khi đưa lên storage ngoài máy;
- retention nhiều thế hệ, không chỉ giữ bản mới nhất;
- restore drill định kỳ vào namespace/cluster tạm;
- cảnh báo khi backup, hash hoặc restore verification thất bại.

Nếu dữ liệu trở nên quan trọng hơn chi phí Free tier, cân nhắc Flex/M10 có backup phù hợp
thay vì tiếp tục dựa hoàn toàn vào backup thủ công.

## 11. Checklist đóng P012

- [x] Xác nhận network Ohio–Hong Kong là nguyên nhân lớn của Mongo latency.
- [x] Tạo Atlas project `TranMed-US` và cluster `tranmed-us-prod` tại N. Virginia.
- [x] Bootstrap và verify database trắng, đủ state cùng index bắt buộc.
- [x] Tải kết quả cần giữ, drain và xóa sạch queue/folder cũ.
- [x] Suspend Render, đổi `MONGODB_URI` và khởi động lại trên target.
- [x] Readiness, scheduler hydrate và backlog sau cutover đều đạt.
- [x] Canary hoàn tất; 1/1 chunk pass, không retry/429.
- [x] Performance gate ban đầu pass: Mongo p95 từ khoảng 598–757 ms xuống 31 ms.
- [x] Mở lại production write.
- [x] Không thực hiện dump/restore vì owner chọn controlled cold start và chấp nhận
  bỏ lịch sử giao diện.
- [ ] Giữ cluster Hong Kong đủ 7–14 ngày và qua ít nhất hai batch thật trước khi xóa.
- [ ] Thiết lập backup định kỳ vì Atlas Free không có managed backup phù hợp.
- [ ] Thu hẹp role `tranmed_app` về đúng database khi thực hiện hardening.

## 12. Nguồn kỹ thuật

- MongoDB Atlas — Modify a Cluster:
  <https://www.mongodb.com/docs/atlas/scale-cluster/>
- MongoDB Atlas — Free Cluster Limits:
  <https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/>
- MongoDB Atlas — Back Up Your Cluster:
  <https://www.mongodb.com/docs/atlas/backup/cloud-backup/overview/>
- MongoDB Atlas — Seed with `mongorestore`:
  <https://www.mongodb.com/docs/atlas/import/mongorestore/>
- MongoDB Database Tools — `mongorestore`:
  <https://www.mongodb.com/docs/database-tools/mongorestore/>
- MongoDB Atlas — AWS regions:
  <https://www.mongodb.com/docs/atlas/reference/amazon-aws/>
