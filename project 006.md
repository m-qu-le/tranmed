# PROJECT 006 — Hardening toàn dự án: bảo toàn dữ liệu, bảo mật và vận hành có thể theo dấu

## 1. Thông tin dự án

| Thuộc tính | Giá trị |
| --- | --- |
| Mã kế hoạch | P006 |
| Ngày lập | 19-07-2026 |
| Trạng thái tổng | **KẾ HOẠCH — chưa triển khai sửa lỗi; baseline audit đã hoàn tất** |
| Baseline mã nguồn | Nhánh `main`, commit `3926a63bb7e4` |
| Nguồn yêu cầu | Rà soát toàn dự án, mô tả lỗi, lập lộ trình sửa toàn bộ và bổ sung khả năng theo dấu khi hệ thống thực thi |
| Tài liệu tham chiếu | `archive/README.md`, `archive/project-001` đến `archive/project-005`, ưu tiên quy ước theo dõi và nghiệm thu của P005 |
| Phạm vi chính | Backend Express/MongoDB/R2/Gemini, frontend React/Vite, upload/download, queue/lease, quality pipeline, migration, launcher, observability và vận hành |
| Nguyên tắc sửa | Sửa nguyên nhân gốc tại điểm dùng chung; thay đổi nhỏ nhất đủ đúng; không thêm dependency nếu Node.js hoặc hạ tầng hiện có đã đáp ứng |
| Vị trí tài liệu khi đang mở | `project 006.md` tại thư mục gốc dự án |
| Vị trí sau khi đóng | `archive/project-006/project-006.md`, chỉ chuyển khi mọi cổng đóng dự án đạt |

> Tài liệu này là nguồn sự thật vận hành của P006. Các số dòng bên dưới được chụp tại baseline và có thể dịch chuyển sau khi sửa; mã lỗi, mã bước, test và bằng chứng mới là định danh bền vững.

## 2. Cách theo dõi kế hoạch

Quy ước:

- `[ ]`: chưa thực hiện hoặc chưa có đủ bằng chứng.
- `[x]`: đã hoàn thành và có mục tương ứng trong **Nhật ký bằng chứng**.
- `BLOCKED`: chỉ dùng khi điều kiện bên ngoài lặp lại và thực sự ngăn không cho tiếp tục; phải ghi nguyên nhân, owner và điều kiện gỡ chặn.
- Mỗi lỗi có mã `P006-BUG-nn`; mỗi rủi ro hardening có mã `P006-RISK-nn`.
- Mỗi bước triển khai có mã `P006-Gx-Syy`; dùng mã trong branch, commit, pull request, log test, báo cáo canary và phiên review.
- Mỗi test có mã `P006-Tnn`; mỗi quyết định có mã `P006-Dnnn`; mỗi bằng chứng có mã `P006-Ennn`.
- Chỉ đánh dấu bước hoàn thành khi tiêu chí riêng của bước **và** cổng của giai đoạn đều đạt.
- Một lỗi chỉ được đóng khi có: test tái hiện đỏ trước sửa, bản sửa tại nguyên nhân gốc, test hồi quy xanh, và bằng chứng liên kết lỗi → bước → test → commit.
- Bằng chứng local/mock không được gọi là bằng chứng production. Waiver phải ghi rõ phạm vi, rủi ro còn lại, người chấp thuận và ngày hết hạn.
- Không log hoặc lưu artifact chứa PDF, bản dịch, prompt, phản hồi model, tên file/thư mục, presigned URL, credential, cookie, token, Mongo URI hoặc dữ liệu y khoa.
- Không dùng `git add -A`; không sửa/xóa thay đổi ngoài P006 nếu worktree phát sinh thay đổi không liên quan.
- Không chạy migration thật, R2 thật, Gemini thật hoặc fault injection trên production trước khi các cổng local/unit/integration tương ứng đã xanh và có approval.

Mẫu liên kết truy vết bắt buộc:

```text
P006-BUG-01
  -> P006-G2-S01..S05
  -> P006-T01..T04
  -> commit fix(P006-G2-S03): ...
  -> P006-E0xx
  -> Cổng G2
```

## 3. Baseline audit và giới hạn bằng chứng

### 3.1. Kiểm tra đã chạy tại thời điểm lập kế hoạch

| Hạng mục | Kết quả baseline | Phạm vi bằng chứng |
| --- | --- | --- |
| Backend test | **118/118 pass** | Unit/integration hiện có; chưa bao phủ đầy đủ race condition và phân quyền |
| Frontend test | **22/22 pass** | Test hiện có; chưa bao phủ download streaming, phân trang thư mục và SSE race |
| Backend JavaScript syntax | **Pass** | Tất cả file JS được kiểm tra cú pháp |
| Frontend lint | **Pass** | Theo cấu hình lint hiện tại |
| Frontend production build | **Pass** | Vite build thành công |
| `npm audit` backend | **0 vulnerability** | Snapshot registry tại lúc chạy |
| `npm audit` frontend | **0 vulnerability** | Snapshot registry tại lúc chạy |
| Dependency tree | **Sạch** | Không thấy dependency invalid/extraneous trong cây đã cài |
| Backend coverage | **84,69% statements** | Coverage tổng; tỷ lệ cao không phủ định các race/invariant bị thiếu |
| Frontend coverage | **66,5% statements** | `App.jsx` 62,42%; nhánh tải thư mục gần như chưa có test |
| Runtime environment validation | **Pass** | Chỉ xác nhận parser/config hiện tại chấp nhận `.env`; không xác nhận môi trường an toàn |

### 3.2. Kiểm tra cố ý chưa chạy

- Không chạy live smoke vào MongoDB, Cloudflare R2 hoặc Gemini vì `.env` backend hiện trỏ tới tài nguyên từ xa và có credential thật.
- Không chạy migration thật, `syncIndexes`, cleanup hoặc reconcile có khả năng ghi/xóa dữ liệu.
- Không chạy launcher bằng double-click vì có nguy cơ trộn frontend production với worker local dùng backend từ xa.
- Không fault-inject lease, upload hoặc cleanup trên production.

Vì vậy, từ “đã xác nhận” trong tài liệu có nghĩa là đã truy vết luồng mã và/hoặc tái hiện thuần local; không đồng nghĩa sự cố đã xảy ra trên production.

## 4. Hành động cô lập trước khi sửa

Các hành động sau là khuyến nghị vận hành; chưa được thực hiện khi lập tài liệu:

1. Không dùng `Dichtailieu.bat` cho tới khi hoàn thành `P006-G0-S04` và `P006-G8-S01`.
2. Không gọi `GET /capacity` khi có job R2 `pending`/`processing` cho tới khi hoàn thành `P006-G2-S06`.
3. Không tăng worker concurrency và không chạy nhiều instance worker trước khi fence ở G2 đạt.
4. Không dùng “Tải toàn bộ thư mục” làm bằng chứng đã sao lưu đủ nếu thư mục có thể vượt trang đang tải.
5. Không xóa folder/job trong lúc batch còn upload; chờ confirm/abandon rõ ràng.
6. Đặt API sau lớp truy cập riêng hiện có nếu hạ tầng hỗ trợ; nếu chưa có, coi endpoint là nhạy cảm và không công bố URL.
7. Sao lưu theo quy trình hiện hành trước mọi migration; không dùng script có `syncIndexes()` cho production.

## 5. Danh mục lỗi đã xác nhận

Mức độ:

- **S0**: có thể mất/sai dữ liệu, lộ dữ liệu hoặc thao tác đặc quyền không được kiểm soát.
- **S1**: lỗi nghiêm trọng về toàn vẹn, độ tin cậy, chi phí hoặc luồng chính.
- **S2**: lỗi chức năng/vận hành có đường tránh nhưng cần sửa.
- **S3**: sai tài liệu, UX, accessibility hoặc chất lượng công cụ.

### 5.1. S0 — phải chặn trước rollout

| Mã | Lỗi và nguyên nhân gốc | Tác động | Vị trí baseline | Hướng sửa tối thiểu | Test chính |
| --- | --- | --- | --- | --- | --- |
| `P006-BUG-01` | Worker cũ mất lease nhưng lỗi `CANCELLED` bị hiểu như user cancel; terminal update và cleanup không được fence bằng `processingToken`/`matchedCount`. | Worker cũ có thể xóa Job, chunk và source R2 của attempt mới hoặc ghi đè output mới. | `queueManager.js:509-561, 811-820, 856-874, 988-1004` | Tách `OWNERSHIP_LOST`; mọi ghi/terminal transition dùng CAS theo `{jobId,status,processingToken}`; chỉ cleanup nếu attempt còn sở hữu; chunk có attempt fence. | `T01–T04` |
| `P006-BUG-02` | API không có authentication/authorization; CORS không phải auth và request thiếu `Origin` vẫn được phép. | Người biết URL có thể xem/tải/xóa tài liệu, cấp presigned PUT, mở SSE/metrics hoặc đánh thức worker/tiêu quota. | `server.js:23-38,82`; `translateRoute.js:27-68` | Chốt mô hình chủ sở hữu; bảo vệ mọi route nhạy cảm, SSE và download; health công khai chỉ tối giản; rate limit theo principal. | `T05–T08` |
| `P006-BUG-03` | `GET /capacity` gọi cleanup với grace `0`; cleanup chỉ bảo vệ `Job.filePath`, trong khi job R2 có `filePath=null` và dùng file tạm xác định theo job ID. | Một GET đọc trạng thái có thể xóa `.part`/`.pdf` đang download/split và làm job lỗi. | `storageService.js:36-39,60-84`; `sourceService.js:66-94`; `capacity.js:9-18` | Capacity thuần read-only; GC riêng có grace an toàn và bảo vệ local path lẫn temp/part của mọi job đang hoạt động. | `T09–T10` |
| `P006-BUG-04` | Quality contract chấp nhận `PASS`, `errors=[]`, `COMPLETE` dù coverage item có `result:error`; completeness chỉ đếm item. | Bản dịch thiếu/sai có thể bị đánh dấu passed/completed. | `translationQuality.js:81-113`; `qualityPipelineState.js:69-88,112-131` | Một shared validator fail-closed: PASS chỉ khi mọi coverage item `match`; dùng chung cho verify và reverify. | `T11–T12` |
| `P006-BUG-07` | Confirm và abandon upload không cùng một state machine/CAS; HEAD, delete và update có thể xen kẽ. | Batch có thể báo `pending` nhưng object đã mất, hoặc confirm xong rồi bị abandon xóa source. | `uploadBatchService.js:159-190,285-315` | CAS trạng thái rõ `confirming`/`abandoning` hoặc giao thức tương đương; response lấy trạng thái DB thật; bên thắng duy nhất được ready/delete. | `T18–T19` |
| `P006-BUG-14` | “Tải toàn bộ thư mục” chỉ dùng jobs đã nạp ở client (API mặc định 100), trong khi xóa folder tác động toàn bộ DB. | Export thiếu nhưng UI báo toàn bộ; người dùng có thể xóa luôn các bản dịch chưa tải. | `App.jsx:716-787,794-804,996,1012-1018`; `translateController.js:141-151` | Enumerate server-side hoặc phân trang tới EOF theo folder/status; đối chiếu tổng server; lỗi bất kỳ trang nào phải fail toàn export. | `T29–T30` |
| `P006-BUG-15` | Download tạo writable trước fetch và luôn `close()` trong `finally`. | HTTP/network/stream lỗi vẫn commit file rỗng hoặc một phần, có thể đè file tốt. | `App.jsx:751-769` | Chỉ close sau EOF thành công; lỗi thì `abort()`; dùng temp/rename nếu nền tảng cho phép. | `T31–T32` |
| `P006-BUG-16` | Đã xác nhận bộ cấp tên chỉ theo base name, không reserve final name: `A.pdf, A.pdf, A_2.pdf` đụng `A_2_vi.md`. | File export có thể bị ghi đè âm thầm. Case/Unicode/file đã tồn tại là edge case hardening bắt buộc khóa thêm trong `T33`, chưa được gọi là repro baseline. | `App.jsx:733-750` | Chuẩn hóa và reserve chính final filename; lặp suffix đến khi unique với cả danh sách và directory hiện hữu. | `T33` |
| `P006-BUG-21` | Launcher khởi backend+Vite local nhưng frontend thiếu `.env.local` nên fallback Render; backend `.env` lại dùng tài nguyên từ xa và tự start worker. | Một lần double-click có thể upload qua production đồng thời worker local claim Mongo/R2 production, gây race/chi phí. | `Dichtailieu.bat:14-28`; `frontend/src/api/client.js:3-5`; `server.js:97-106` | Ưu tiên launcher người dùng chỉ mở deployed app; nếu giữ dev launcher thì fail-fast khi target/namespace không hoàn toàn local và không tự mở worker production. | `T40–T41` |

### 5.2. S1 — toàn vẹn và độ tin cậy cao

| Mã | Lỗi và nguyên nhân gốc | Tác động | Vị trí baseline | Hướng sửa tối thiểu | Test chính |
| --- | --- | --- | --- | --- | --- |
| `P006-BUG-05` | Cleanup intent có thể mất nếu lần ghi marker đầu tiên lỗi; queue nuốt lỗi và sweeper chỉ quét `pending/retry`. | Source R2 terminal có thể tồn tại vô hạn nếu lifecycle ngoài ứng dụng không cứu được. | `sourceCleanupService.js:18-38,76-84`; `queueManager.js:979-985` | Ghi intent cùng terminal transition hoặc recovery quét terminal source chưa deleted/không marker; retry idempotent. | `T13–T14` |
| `P006-BUG-06` | Presigned PUT vẫn ghi được sau confirm; `sourceEtag` được lưu nhưng worker không dùng để ràng buộc object. | Object có thể bị thay bằng PDF khác cùng size trước expiry; worker dịch nguồn khác nguồn đã confirm. | `uploadBatchService.js:77-98,159-190`; `r2Service.js:109-122`; `sourceService.js:89-94` | Seal bằng copy sang key không presign hoặc mọi GET dùng `If-Match: sourceEtag`; mismatch fail-closed. | `T15–T17` |
| `P006-BUG-08` | Xóa folder/job vẫn được phép khi upload còn chạy; manifest bị xóa nhưng PUT ký sẵn có thể hoàn tất muộn. | Batch kẹt `INCOMPLETE_PREPARE`, source mồ côi hoặc mất job/source. | `App.jsx:659-677,1012-1018`; `queueManager.js:988-1004,1034-1083`; `uploadBatchService.js:77-106` | Backend trả 409 khi upload chưa terminal; frontend abort/abandon trước delete; giữ tombstone đủ TTL để reconcile PUT muộn. | `T20–T21` |
| `P006-BUG-10` | Async callback trong `setInterval` chỉ có `try/finally`, không có `catch`. | Mongo reject tạo unhandled rejection; Node 22 có thể thoát process và reconciler không tự hồi phục. | `uploadBatchService.js:318-320,368-376` | Callback sync phát promise có `.catch(...).finally(...)`; log/metric bounded, tick sau vẫn chạy. | `T24` |
| `P006-BUG-13` | Cùng limiter 120/h cho prepare/confirm/abandon; batch 500 file cần 51 request và retry client bỏ qua `Retry-After`. | Workload hợp lệ tự bị 429 từ batch thứ ba; retry nóng làm tình trạng nặng hơn. | `translateRoute.js:27-40`; `cloudUploader.js:13-31,113-143` | Limiter tách theo action/principal với budget đúng contract; client tôn trọng `Retry-After`; giữ idempotency. | `T27–T28` |
| `P006-BUG-17` | Group folder bằng object `{}` rồi `.push`; key `constructor`, `toString`, `__proto__` trỏ vào prototype. | Tên folder hợp lệ có thể crash render hoặc làm sai cấu trúc state. | `App.jsx:794-802` | Dùng `Map` hoặc `Object.create(null)` tại trust boundary; rà các dictionary động liên quan. | `T34` |
| `P006-BUG-19` | HTTP resync SSE cũ có thể resolve sau event mới và replace state bằng snapshot cũ; summary thiếu revision đáng tin. | UI completed có thể quay về processing/pending và hành động theo trạng thái sai. | `App.jsx:352-383,402-414`; `queueManager.js:285-300` | Merge theo `updatedAt`/revision hoặc event generation; hủy/bỏ response stale; không replace mù. | `T36` |
| `P006-BUG-20` | Phân trang job dùng `_id > cursor`, sort tăng dần nên trang đầu là job cũ nhất, trái contract “100 mới nhất”. | Sau khi có hơn 100 job, reload không thấy job mới; SSE chỉ cập nhật item đã hiện diện. | `queueManager.js:285-300`; contract P005 | Sort `_id:-1`, cursor `$lt`; định nghĩa ổn định khi có insert đồng thời. | `T37` |
| `P006-BUG-22` | Script dry-run/reconcile kết nối Mongoose với `autoIndex` mặc định; migration dùng `syncIndexes()`. | Lệnh được hiểu là read-only vẫn có thể tạo index; migration có thể drop index thủ công ngoài schema. | scripts migration P001/P002/P003; `reconcile-r2.js:25` | `autoIndex:false` cho tool; migration additive bằng index khai báo rõ; drop cần diff, backup và approval riêng. | `T42–T43` |

### 5.3. S2/S3 — chức năng, phục hồi và chất lượng vận hành

| Mã | Mức | Lỗi và nguyên nhân gốc | Hướng sửa tối thiểu | Test chính |
| --- | --- | --- | --- | --- |
| `P006-BUG-09` | S2 | `refreshBatch` đếm mọi `Job.status=failed` là upload failed, kể cả job đã upload an toàn nhưng dịch lỗi. | Tách upload state khỏi translation state; confirmed dựa `uploadConfirmedAt/sourceState`, không dựa kết quả dịch. | `T22–T23` |
| `P006-BUG-11` | S2 | Batch unsafe phục hồi sau F5 chỉ có `entries=[]`; UI không cho resume, abandon toàn batch hoặc dismiss. | API trả manifest thiếu an toàn; reattach/match file; có abandon toàn batch; mismatch bị chặn. | `T25` |
| `P006-BUG-12` | S2 | Banner “có thể tắt máy” dùng `some`, nên một task safe che task khác unsafe. | Chỉ báo an toàn khi queue hữu hình không rỗng và `every(canCloseClient)`; mixed phải cảnh báo. | `T26` |
| `P006-BUG-18` | S2 | SSE reconnect dùng `setJobs(firstPage)` và reset cursor, làm mất các trang đã “Tải thêm”. | Merge page đầu theo job ID, giữ history/cursor; chỉ loại qua delete/reconcile rõ ràng. | `T35` |
| `P006-BUG-23` | S2 | Parser integer dùng `parseInt`, chấp nhận `8080junk`, `12.5` và giá trị không canonical. | Một strict integer helper dùng chung, kiểm positive/safe/canonical sau trim. | `T44` |
| `P006-BUG-24` | S2 | Mode rollback `legacy` vẫn bị validation các biến chỉ dùng cho quality chặn khởi động. | Chỉ validate quality-only config khi mode `quality`; legacy chỉ đọc cấu hình nó dùng. | `T45` |
| `P006-BUG-25` | S3 | README gọi benchmark scripts đã bị xóa khỏi `package.json`. | Xóa/đánh dấu archived và thay bằng lệnh thật; thêm check mapping script tài liệu → package scripts. | `T46` |
| `P006-BUG-26` | S2 | `npm run test:keys` exit 0 khi không có key hoặc mọi key lỗi; còn log raw error. | Tổng hợp kết quả, exit 1 khi zero tested/zero valid theo policy; redact lỗi. | `T47` |
| `P006-BUG-27` | S2 | Frontend giữ folder raw >120 ký tự trong state, backend truncate; xóa theo tên raw có thể trả 0 nhưng UI vẫn bỏ state. | Backend trả canonical folder; client chỉ dùng canonical ID/name và chỉ mutate UI sau response xác thực. | `T48` |
| `P006-BUG-28` | S2 | Client nhận file 0 byte, quá giới hạn hoặc quá 2 GiB vào task rồi mới để backend từ chối; task không có remove rõ ràng. | Mirror validation ở UI để phản hồi sớm, giữ backend là authority; cho remove/reselect file lỗi. | `T49` |
| `P006-BUG-29` | S3 | Dashboard trộn count uploading toàn cục từ server với byte progress cục bộ, kể cả task đã safe. | Đặt nhãn/phạm vi rõ; tách global server counts và local active bytes. | `T50` |
| `P006-BUG-30` | S3 | Smoke R2 dùng TTL config khi tạo URL nhưng assert cứng `1800`. | Assert theo config thực hoặc cố định cả input lẫn expectation tại fixture. | `T51` |
| `P006-BUG-31` | S2 | Launcher ngủ cố định 5 giây, giả định port 5173 trong khi Vite có thể đổi port và vẫn báo sẵn sàng khi tiến trình lỗi. | Dùng readiness probe có timeout/exit; `strictPort`; fail-fast và propagate exit code. | `T52` |
| `P006-BUG-32` | S3 | `R2_ACCOUNT_ID`/`R2_SOURCE_RETENTION_DAYS` bị bắt buộc nhưng luồng chính hầu như không dùng; reconcile hard-code 3 ngày. | Xóa config chết hoặc nối đúng một nguồn cấu hình; test config contract. | `T53` |
| `P006-BUG-33` | S3 | Task cloud thành công chỉ xóa `files:[]`; object `File` thực vẫn nằm trong `entries`, giữ RAM. | Xóa reference khỏi entries sau khi terminal/safe nhưng giữ metadata thuần cần hiển thị. | `T54` |
| `P006-BUG-34` | S3 | Preview lỗi vẫn bật `showPreview`, khiến lần retry cần chuỗi click dư. | Chỉ mở preview khi fetch/parse thành công; lỗi giữ trạng thái đóng và retry một bước. | `T55` |
| `P006-BUG-35` | S3 | Một số tương tác thiếu accessibility: input mất outline, realtime không `aria-live`, Space trên folder không `preventDefault`. | Khôi phục focus-visible, live region phù hợp, keyboard semantics và test a11y tối thiểu. | `T56` |

### 5.4. Lỗi chuẩn bị batch bổ sung

| Mã | Mức | Lỗi và nguyên nhân gốc | Hướng sửa tối thiểu | Test chính |
| --- | --- | --- | --- | --- |
| `P006-BUG-36` | S1 | Crash giữa `UploadBatch.create` và `Job.insertMany` để lại `clientBatchId` tồn tại vĩnh viễn nhưng thiếu manifest; retry chỉ trả `INCOMPLETE_PREPARE`. | Dùng transaction nếu deployment hỗ trợ; nếu không, state `preparing` + idempotent reconcile/repair để hoàn tất hoặc abandon an toàn. | `T57–T58` |

## 6. Rủi ro hardening cần xác minh

Các mục dưới đây có đường gây hại hợp lý nhưng chưa được gọi là incident đã tái hiện. G0 phải biến từng mục thành: lỗi có test đỏ, kiểm soát đã đủ, hoặc waiver có owner.

| Mã | Rủi ro | Hành động xác minh/giảm thiểu | Bước / test / cổng |
| --- | --- | --- | --- |
| `P006-RISK-01` | Backup P002/P003 dùng `toArray` + EJSON string + `gzipSync`, có thể OOM với DB lớn; artifact không mã hóa và có thể rơi trong repo. | Đo memory bằng synthetic data; chuyển sang cursor/stream nếu cần; lưu ngoài repo, mã hóa/ACL, checksum và restore drill. | `G8-S08` / `T59` / G8 |
| `P006-RISK-02` | Script dựa trực tiếp package `bson` nhưng có thể chỉ đang nhận dependency bắc cầu. | Khẳng định import contract; dùng export của dependency trực tiếp hoặc khai báo dependency thực sự cần. | `G8-S07` / `T61` / G8 |
| `P006-RISK-03` | `reconcile-r2` phát hiện anomaly nhưng vẫn exit 0, nên deployment gate có thể false-green. | Chuẩn hóa exit code theo số anomaly/error và chế độ report-only rõ ràng. | `G4-S10`, `G8-S06` / `T60` / G8 |
| `P006-RISK-04` | Hai `package.json` thiếu `engines`/`packageManager`; Node 22 hiện chạy được nhưng deployment có thể drift. | Chốt runtime đã kiểm chứng, pin major/package manager và test CI trên đúng version. | `G8-S07` / `T61` / G8 |
| `P006-RISK-05` | Server chưa có graceful `SIGTERM`/`SIGINT`; worker có thể mất lease giữa xử lý và chỉ được recover sau timeout. | Drain HTTP, ngừng claim mới, heartbeat/lease đúng hạn, timeout rồi thoát; test kill/restart. | `G2-S08` / `T38` / G2 |
| `P006-RISK-06` | File `.lnk` tracked chứa đường dẫn tuyệt đối máy cá nhân; tài liệu chứa email/path/private-key location. | Xóa artifact không portable khỏi tracking và redact metadata hạ tầng/PII; không xóa hướng dẫn cần thiết. | `G8-S07` / `T62` / G8 |
| `P006-RISK-07` | SSE dùng emitter giới hạn listener tăng lên 100 nhưng chưa có auth/connection cap. | Auth trước subscribe, cap theo principal/IP, cleanup listener và metric active connections. | `G3-S04` / `T63` / G3 |
| `P006-RISK-08` | Log tự do có thể chứa `storageKey`, `originalName`, raw error; redaction không đồng nhất. | Chuyển sang schema allowlist JSONL; cấm nội dung/tên/path/key, test redaction bằng sentinel. | `G1-S02`, `G9-S04` / `T39` / G1 |
| `P006-RISK-09` | `/health` chạm DB nên không phải liveness; readiness chưa phản ánh worker/reconciler/sweeper. | Tách liveness thuần process và readiness read-only theo dependency/component. | `G1-S07` / `T64` / G1 |
| `P006-RISK-10` | Metrics reset khi restart, public và có `keyIndex`; cardinality/metadata có thể lộ cấu hình nội bộ. | Bảo vệ endpoint, bỏ định danh không cần thiết, metric bounded-cardinality và gắn `bootId/release`. | `G1-S06`, `G3-S05` / `T65` / G1/G3 |

## 7. Mục tiêu và chỉ tiêu thành công

P006 chỉ hoàn thành khi đạt đồng thời:

1. Worker mất ownership không thể ghi chunk, chuyển terminal, emit terminal hay cleanup attempt mới.
2. Anonymous không thể đọc, tải, upload, xóa, subscribe SSE, xem metrics hoặc điều khiển worker; principal A không thể tác động dữ liệu của B nếu chọn multi-user.
3. Không GET/readiness/capacity nào xóa file; mọi source đã confirm được ràng buộc với đúng object/ETag và cleanup eventual có thể chứng minh.
4. Quality chỉ PASS khi toàn bộ coverage match; dữ liệu mâu thuẫn luôn fail-closed ở verify và reverify.
5. Export thư mục lớn tải đúng đủ một snapshot logic, không overwrite và không commit file partial.
6. Upload state machine chịu được refresh, retry, confirm/abandon/delete race và crash giữa các bước.
7. SSE + HTTP resync hội tụ về trạng thái mới nhất mà không mất history đã tải.
8. Launcher không bao giờ trộn local/production; tool read-only không ghi index; migration không drop index ngoài kế hoạch.
9. Mỗi request/job/attempt/cleanup có thể lần theo bằng ID an toàn mà không ghi dữ liệu y khoa hoặc secret.
10. Toàn bộ `P006-T01…T66` áp dụng cho implementation cuối cùng đều xanh; test/lint/build/audit baseline không hồi quy.
11. Rollout theo canary synthetic đạt, rollback được diễn tập và không cần xóa dữ liệu để quay lại.
12. Mọi bước được đánh dấu `[x]` có bằng chứng; không còn S0/S1 mở, không còn decision blocker và waiver còn hiệu lực.

## 8. Phạm vi và ngoài phạm vi

### 8.1. Trong phạm vi

- Fix 36 lỗi và xác minh 10 rủi ro trong danh mục trên.
- Thêm authentication/authorization tối thiểu phù hợp mô hình sử dụng đã được owner chốt.
- Thêm correlation, structured logging, audit trail, metrics và health/readiness đủ để điều tra sự cố.
- Bổ sung test race/fault/stream/pagination/config và công cụ runner có checkpoint.
- Cập nhật tài liệu, launcher, migration/reconcile/backup safety và quy trình rollout/rollback.

### 8.2. Ngoài phạm vi mặc định

- Viết lại framework frontend/backend hoặc thay MongoDB/R2/Gemini.
- Xây hệ thống IAM đa tenant đầy đủ nếu owner chỉ cần single-owner; nếu chọn multi-user, schema ownership trở thành thay đổi phạm vi phải ghi `P006-D001`.
- Lưu full distributed trace hoặc đưa thêm SaaS observability trước khi chứng minh structured log + audit hiện tại không đủ.
- Chạy lại benchmark lớn P003, load test production hoặc dùng tài liệu y khoa thật làm fixture.
- Thay đổi chất lượng bản dịch ngoài invariant strict-PASS đã nêu.

## 9. Thiết kế đích và các bất biến an toàn

### 9.1. Worker ownership và destructive action

Các bất biến bắt buộc:

1. `processingToken` chỉ là secret fence nội bộ, không phải correlation ID và **không bao giờ** xuất hiện trong log, SSE, metric, audit event, error response hay artifact test.
2. Mọi write theo attempt phải match `{ jobId, status: 'processing', processingToken }` hoặc một attempt/version tương đương.
3. `matchedCount=0` nghĩa là mất ownership; worker cũ chỉ dừng, không đổi status, không emit terminal và không cleanup.
4. User cancel, shutdown/drain, timeout, model failure và ownership lost là các outcome khác nhau; không tái dùng một mã `CANCELLED` cho nhiều nghĩa.
5. Cleanup destructive phải gắn precondition rõ: cleanup theo user delete/cancel có authority riêng; cleanup theo attempt chỉ được chạy sau terminal CAS thành công của chính attempt đó.
6. Retry/restart phải idempotent: chạy cleanup, reconcile hoặc terminal transition nhiều lần cho cùng operation không tạo thêm tác dụng phụ.

### 9.2. Source R2 và upload state machine

Mô hình ưu tiên, cần chốt ở `P006-D003`:

- Presigned PUT chỉ ghi vào **staging key**.
- Confirm HEAD lấy size/ETag, sau đó server seal object sang key không còn được presign bằng conditional copy hoặc cơ chế immutable tương đương.
- Job chỉ chuyển ready khi sealed source đã tồn tại và khớp metadata; worker chỉ đọc sealed key.
- Nếu deployment không hỗ trợ copy/conditional semantics phù hợp, mọi GET bắt buộc `If-Match: sourceEtag` và mismatch là integrity failure, không retry mù.
- URL cũ có thể ghi đè staging key nhưng không đổi sealed source; lifecycle/reconciler dọn staging object.

State machine phải có transition đơn điệu và CAS:

```text
preparing -> uploading -> confirming -> ready
                     \-> abandoning -> abandoned
                     \-> expired -> cleanup_pending -> cleaned
```

- Không được trả trạng thái fallback nếu update không match.
- Upload state độc lập với translation status.
- Delete khi upload chưa terminal phải bị chặn hoặc được chuyển thành abandon có thể resume; không xóa manifest trước PUT TTL.
- Crash giữa các bước phải có recovery scan từ trạng thái bền vững, không dựa cờ RAM.

### 9.3. Authentication và authorization

`P006-D001` phải chọn một trong hai phạm vi trước khi sửa schema:

- **Khuyến nghị cho hiện trạng single-owner:** dùng access gateway hiện có nếu gateway bảo vệ được cả HTTP, streaming SSE và download. Nếu không có, dùng credential ngẫu nhiên do owner bootstrap qua kênh riêng; không nhúng vào `VITE_*`, source, localStorage dài hạn hay URL.
- **Multi-user:** thêm owner/principal vào `UploadBatch`, `Job`, artifact và audit; mọi query/update/delete phải scope theo owner; migration/backfill và test user A/B là bắt buộc.

Ranh giới chung:

- Chỉ liveness tối giản có thể public; readiness chi tiết, metrics, force-wakeup và mọi dữ liệu đều protected.
- Authorization thực hiện ở backend tại query boundary, không dựa vào nút bị ẩn ở frontend.
- Nếu dùng cookie/session: cookie phải `HttpOnly`, `Secure`, `SameSite` phù hợp; mọi mutation có CSRF defense và kiểm `Origin`/token theo threat model. Nếu dùng bearer: giữ token trong memory ngắn hạn; native `EventSource` không gắn Authorization nên phải dùng authenticated fetch-stream hoặc gateway hỗ trợ SSE.
- D001 phải mô tả bootstrap/login, expiry, logout, rotation và revocation. Credential đã revoke không được giữ stream/download đang mở ngoài policy.
- SSE phải authenticate trước subscribe; download phải authorize trước khi tạo/stream nội dung.
- Rate limiter dùng principal ổn định; IP chỉ là lớp bổ sung, không phải identity.
- Destructive/admin request phải có audit event bền vững; nếu policy yêu cầu audit mà không ghi được, request fail-closed.

### 9.4. Quality contract

Một validator dùng chung quyết định strict PASS:

```text
status === PASS
AND errors.length === 0
AND coverage.status === COMPLETE
AND coverage.items IDs are unique
AND set(coverage.items IDs) === expectedCoverageIds
AND every coverage item result === match
```

`expectedCoverageIds` phải lấy từ manifest source/chunk bền vững được tạo trước lần gọi model, không lấy từ count/danh sách do model tự báo. Không được thiếu, trùng hoặc có ID lạ. Verify, reverify, parser, state transition và test đều gọi cùng validator. Không tạo thêm bản sao logic ở controller/UI.

### 9.5. Export/download như một transaction phía client

Một lượt export chỉ được báo thành công khi:

1. Chụp được tổng/snapshot logic từ server và phân trang tới EOF.
2. Mọi job mục tiêu đều được authorize và tải đủ bytes.
3. Tên cuối cùng unique sau normalize/case-fold theo filesystem đích.
4. Writable chỉ `close()` sau EOF; mọi lỗi gọi `abort()` và ghi failure marker.
5. Summary nêu rõ requested/succeeded/failed/skipped; “toàn bộ” chỉ khi succeeded đúng tập mục tiêu.

Nếu File System Access API không có atomic rename đáng tin, ghi rõ giới hạn và ưu tiên không đè file hiện hữu.

### 9.6. UI state và hội tụ SSE/HTTP

- DB là nguồn resume; SSE chỉ là tín hiệu best-effort, không phải event log có replay.
- Page đầu mới nhất, cursor tải lịch sử cũ hơn; reconnect merge, không replace toàn state.
- Mỗi job có `updatedAt`/revision đơn điệu; response HTTP cũ không được thắng event mới.
- Delete event hoặc explicit reconciliation mới được loại item; “không có trong page đầu” không có nghĩa đã bị xóa.
- Canonical folder/batch identity do backend trả về được dùng cho mọi action tiếp theo.

## 10. Thiết kế theo dấu khi hệ thống thực thi

### 10.1. Correlation contract

| Trường | Nguồn | Mục đích | Quy tắc an toàn |
| --- | --- | --- | --- |
| `eventId` | UUID tạo cho từng event | Khử trùng lặp/đối chiếu event | Không tái dùng |
| `requestId` | Server tạo; trả `X-Request-Id` | Theo một HTTP/SSE handshake | Không tin giá trị tùy ý từ client; chỉ nhận dạng hợp lệ hoặc tạo mới |
| `operationId` | Server tạo/xác thực UUID | Nối nhiều request của upload/export/delete | Không chứa tên file/user data |
| `batchId` | Mongo/public opaque ID | Theo một upload batch | Chỉ log sau auth; không đưa vào metric label |
| `jobId` | Mongo/public opaque ID | Theo một job | Chỉ log/audit; không đưa vào metric label |
| `jobAttempt` | `attemptCount` hoặc attempt version | Phân biệt các lần claim | Tuyệt đối không thay bằng/hash từ `processingToken` |
| `chunkIndex` | Số nguyên | Theo chunk trong một attempt | Chỉ log khi cần; metric chỉ aggregate |
| `stage` | Enum allowlist | Theo state machine | Không nhận text tự do |
| `bootId` | UUID lúc process start | Phân biệt restart | Không dùng làm identity người dùng |
| `release` | Commit/build ID | Gắn lỗi với bản triển khai | Không chứa secret |
| `actorRef` | ID nội bộ/pseudonymous | Audit ai làm hành động | Không log email/tên hiển thị nếu không cần |

Node `AsyncLocalStorage` của standard library là lựa chọn mặc định cho request context. Background claim phải tạo context mới từ `jobId`, `jobAttempt`, `bootId`; không kéo nguyên HTTP context sống lâu vào worker.

### 10.2. Structured event schema

Log stdout dùng JSONL allowlist, timestamp UTC:

```json
{
  "ts": "2026-07-19T04:30:00.000Z",
  "level": "info",
  "event": "quality.stage.persisted",
  "eventId": "uuid",
  "requestId": "uuid",
  "operationId": "uuid",
  "jobId": "opaque-id",
  "jobAttempt": 2,
  "stage": "verify",
  "fromState": "verifying",
  "toState": "passed",
  "outcome": "success",
  "durationMs": 418,
  "bootId": "uuid",
  "release": "3926a63bb7e4"
}
```

Event tối thiểu:

- HTTP: `http.request.started`, `http.request.completed`, `http.request.rejected`.
- Upload: `upload.batch.prepared`, `upload.item.confirm.requested`, `upload.item.sealed`, `upload.batch.abandon.requested`, `upload.batch.terminal`.
- Queue/lease: `queue.job.claimed`, `queue.heartbeat.persisted`, `queue.ownership.lost`, `queue.job.terminal.persisted`.
- Source: `source.download.started`, `source.download.completed`, `source.integrity.rejected`, `source.cleanup.requested`, `source.cleanup.completed`, `source.cleanup.retry_scheduled`.
- Quality: `quality.stage.started`, `quality.stage.persisted`, `quality.contract.rejected`.
- Delete/export: `delete.requested`, `delete.completed`, `delete.rejected`, `export.started`, `export.item.completed`, `export.terminal`.
- Component: `component.ready`, `component.degraded`, `component.stopped`.

Chỉ event sau khi DB CAS/write thành công mới được đặt hậu tố `persisted`/`completed`. Event `started` không được dùng làm checkpoint.

### 10.3. Dữ liệu tuyệt đối không ghi

- `processingToken`, API key, Authorization, cookie, session, Mongo URI, private key, presigned URL hoặc query string có chữ ký.
- `originalName`, `folderName`, `filePath`, `storageKey`; không hash tên/nội dung vì hash vẫn có thể là định danh và không cần cho vận hành.
- PDF/source excerpt, prompt, raw model response, bản dịch, context, audit report chất lượng hoặc nội dung lỗi từ dịch vụ ngoài.
- Request body/query tự do, production stack trace trả cho client, raw credential-validation error.

Test redaction phải cấy sentinel cho từng loại cấm và assert sentinel không xuất hiện trong stdout, stderr, audit collection hay artifact.

### 10.4. Audit event bền vững

Thiết kế đề xuất `AuditEvent` append-only hoặc sink tương đương, chỉ chứa allowlist:

- identity: `eventId`, `requestId`, `operationId`, `actorRef`.
- target: `targetType`, opaque `targetId`, không có tên/nội dung.
- action/outcome: login/auth reject, read result, download, upload prepare/confirm, delete, abandon, admin/wakeup, auth/config change.
- timing/build: `occurredAt`, `durationMs`, `bootId`, `release`, `environment`.

Retention đề xuất ban đầu: 90 ngày, phải chốt ở `P006-D005`. Tạo index bằng migration additive (`createIndex`/khai báo rõ), không `syncIndexes()`. Destructive flow ghi `requested` rồi terminal outcome; retry dùng cùng `operationId` để điều tra mà không double-count.

### 10.5. Metrics và health

- Counter: HTTP outcome, auth reject, queue claim/terminal/ownership lost, upload seal/integrity fail, R2 operation outcome, quality result, cleanup retry/terminal.
- Gauge: pending/processing jobs, active leases, active SSE, reconciler/sweeper last-success age.
- Histogram: HTTP, queue wait, source download, model stage, cleanup latency.
- Không dùng `jobId`, `batchId`, `requestId`, file/folder, key index hoặc error text làm label.
- Gắn metadata `bootId`, `release`, `environment` ngoài label cardinality cao.
- `/health`: liveness thuần process/event loop, không query DB/R2/Gemini.
- `/readiness`: read-only kiểm init, Mongo, R2 config/permission tối thiểu, worker drain/claim capability, reconciler/sweeper freshness; không gọi Gemini billable, cleanup hoặc tạo index.

## 11. Các giai đoạn triển khai

### G0 — Neo baseline, tái hiện và chốt quyết định

- [ ] `P006-G0-S01` Tạo branch P006; ghi commit/runtime/package-lock hash, Node/npm version và worktree state vào `P006-E002`.
- [ ] `P006-G0-S02` Viết test tái hiện tối thiểu cho mọi S0/S1; test phải đỏ đúng nguyên nhân trước khi sửa, không phụ thuộc production.
- [ ] `P006-G0-S03` Chốt `P006-D001`: single-owner qua gateway/session hay multi-user có ownership; kèm bootstrap, transport HTTP/SSE, CSRF, expiry, logout, rotation và revocation. Ghi rõ quyết định mới **thay thế cho phạm vi no-auth của P002**, không sửa ngược hồ sơ archive.
- [ ] `P006-G0-S04` Chốt `P006-D002` về launcher; trong thời gian chờ, gắn cảnh báo/fail-fast để không trộn local và production.
- [ ] `P006-G0-S05` Chốt `P006-D003` về sealed-copy hay ETag conditional read; xác nhận Cloudflare R2 semantics bằng tài liệu/fixture không nhạy cảm.
- [ ] `P006-G0-S06` Chốt `P006-D004` về transaction support cho prepare batch và phương án state-machine fallback.
- [ ] `P006-G0-S07` Chốt `P006-D005` về audit sink, retention, quyền xem và fail-open/fail-closed theo action.
- [ ] `P006-G0-S08` Lập data-flow/threat model: trust boundary, route matrix, source lifetime, destructive actions và dữ liệu cấm log.
- [ ] `P006-G0-S09` Thêm `.p006-local/` vào `.gitignore`; tạo runner/checkpoint schema nhưng chưa chạy production.
- [ ] `P006-G0-S10` Phân loại từng `P006-RISK-*` thành confirmed bug, controlled hoặc waiver; không để trạng thái mơ hồ.

**Cổng G0:** tất cả S0/S1 có test tái hiện hoặc invariant test; D001–D005 có owner/date; launcher không thể vô tình chạy mixed target; không có live write nào được thực hiện.

### G1 — Nền tảng observability và truy vết an toàn

- [ ] `P006-G1-S01` Thêm `AsyncLocalStorage` request context và `X-Request-Id`; validate ID client gửi, tạo mới khi thiếu/sai.
- [ ] `P006-G1-S02` Tạo logger JSONL allowlist dùng chung; map raw external error sang code an toàn; test sentinel redaction.
- [ ] `P006-G1-S03` Chuẩn hóa enum event/field và helper timing; không thêm abstraction ngoài các producer thực sự dùng.
- [ ] `P006-G1-S04` Instrument HTTP, upload, queue/lease, source, quality, delete/export và component lifecycle theo danh sách §10.2.
- [ ] `P006-G1-S05` Thêm audit sink/migration additive theo D005; audit route read/download/delete/admin và outcome.
- [ ] `P006-G1-S06` Mở rộng `OperationalMetrics` bằng counter/gauge/histogram bounded-cardinality; bỏ `keyIndex` và ID khỏi label/output công khai.
- [ ] `P006-G1-S07` Tách `/health` và `/readiness`; readiness không gây mutation/billing và báo freshness worker/reconciler/sweeper.
- [ ] `P006-G1-S08` Triển khai và đăng ký `trace:p006`, `status:p006` hoặc công cụ tương đương; output chỉ dùng safe projection, nối `requestId -> operationId -> batchId -> jobId -> jobAttempt -> terminal/cleanup`, có CLI contract test.
- [ ] `P006-G1-S09` Kiểm thử restart: `bootId` đổi, release giữ đúng, log cũ/mới vẫn phân biệt được.

**Cổng G1:** `T39`, `T64–T65` xanh; một synthetic job có trace đầy đủ từ request đến cleanup; không sentinel/secret/content nào lọt log/audit/artifact; metric không có label cardinality theo ID; health/readiness thuần read-only.

### G2 — Worker fencing, cleanup ownership và lifecycle process

- [ ] `P006-G2-S01` Tạo lỗi typed `OWNERSHIP_LOST`; tách user cancel, shutdown, timeout và processing failure.
- [ ] `P006-G2-S02` Rà mọi caller của `assertJobActive`, `saveTranslatedChunk`, terminal transition và `cleanupJob`; ghi bảng ownership precondition.
- [ ] `P006-G2-S03` Fence mọi chunk/write/terminal update bằng attempt; bắt buộc kiểm `matchedCount` trước side effect tiếp theo.
- [ ] `P006-G2-S04` Đổi cleanup API nhận cause + authority/precondition; stale attempt không được cleanup/emit terminal.
- [ ] `P006-G2-S05` Thêm race test hai QueueManager với barrier cho assert, save và permanent-failure; user cancel thật vẫn cleanup.
- [ ] `P006-G2-S06` Tách capacity khỏi GC; GC bảo vệ active local/R2 temp path, có grace và lock/registry tối thiểu đủ đúng.
- [ ] `P006-G2-S07` Sửa cleanup intent/recovery scan để lỗi marker đầu tiên vẫn eventual cleanup sau restart.
- [ ] `P006-G2-S08` Thêm graceful SIGTERM/SIGINT: readiness false, ngừng claim, chờ/drain có timeout, giữ lease/cleanup semantics.

**Cổng G2:** toàn bộ `T01–T04`, `T09–T10`, `T13–T14`, `T38` xanh; fault test chứng minh token mới/job/source/chunk sống sau stale attempt; GET capacity tạo zero mutation; kill/restart không double-terminal.

### G3 — Authentication, authorization và chống lạm dụng

- [ ] `P006-G3-S01` Lập route matrix method/path/public/auth/scope/rate/audit; chỉ public liveness tối giản nếu D001 cho phép.
- [ ] `P006-G3-S02` Cài auth middleware theo D001; triển khai bootstrap/login, expiry, logout, rotation/revocation; cookie có CSRF defense hoặc bearer ở memory ngắn hạn; secret/session không nằm trong bundle frontend, URL hoặc log.
- [ ] `P006-G3-S03` Scope query/update/delete/download theo owner/principal; nếu single-owner, enforce đúng một audience và không giả vờ multi-tenant.
- [ ] `P006-G3-S04` Bảo vệ SSE trước subscribe; dùng authenticated fetch-stream/gateway nếu bearer; giới hạn connection, tháo listener khi close/revoke và đo active gauge.
- [ ] `P006-G3-S05` Bảo vệ metrics/readiness detail/force-wakeup; response anonymous không lộ job, storage hoặc component detail.
- [ ] `P006-G3-S06` Tách rate limit prepare/confirm/abandon/read/admin theo principal; giữ contract 500 file; trả và tôn trọng `Retry-After`.
- [ ] `P006-G3-S07` Cập nhật frontend auth bootstrap/fetch/stream và UX 401/403; không lưu credential lâu hơn policy.
- [ ] `P006-G3-S08` Audit login/auth reject/read/download/delete/admin; test audit sink failure theo D005.

**Cổng G3:** `T05–T08`, `T27–T28`, `T63`, `T65–T66` xanh; anonymous và user chéo bị chặn trên HTTP, SSE, download, delete và admin; CSRF/rotation/revocation đạt theo D001; 3 batch hợp lệ không tự 429; security review không thấy credential ở build/log.

### G4 — R2, upload batch và cleanup state machine

- [ ] `P006-G4-S01` Seal source hoặc enforce ETag theo D003; worker chỉ resolve đúng version đã confirm.
- [ ] `P006-G4-S02` Viết state machine/CAS confirm–abandon–expire; bỏ fallback status và kiểm mọi `matchedCount`.
- [ ] `P006-G4-S03` Chặn/biến đổi delete khi upload đang hoạt động; phối hợp abort/abandon frontend và tombstone/TTL backend.
- [ ] `P006-G4-S04` Sửa reconciler interval để rejection được catch/metric/log, flag reset và tick sau chạy tiếp.
- [ ] `P006-G4-S05` Tách upload status khỏi translation status trong `refreshBatch` và summary.
- [ ] `P006-G4-S06` Cho batch unsafe sau F5 có manifest thiếu, reattach/match và abandon toàn batch.
- [ ] `P006-G4-S07` Làm prepare idempotent qua transaction hoặc `preparing` recovery theo D004; crash không khóa `clientBatchId` vĩnh viễn.
- [ ] `P006-G4-S08` Canonicalize folder tại backend và trả identity canonical; frontend không tự đoán/truncate.
- [ ] `P006-G4-S09` Dọn File reference sau safe terminal; giữ metadata thuần; xác nhận memory giảm bằng fixture local.
- [ ] `P006-G4-S10` Reconcile staging/sealed/orphan với exit code có nghĩa; không xóa object đang active.

**Cổng G4:** `T15–T25`, `T48`, `T54`, `T57–T58` xanh; mọi interleaving confirm/abandon/delete hội tụ hợp lệ; overwrite sau confirm bị reject; restart phục hồi được preparing/cleanup.

### G5 — Quality strict-PASS

- [ ] `P006-G5-S01` Viết một shared strict-PASS validator theo §9.4 và xóa logic trùng.
- [ ] `P006-G5-S02` Áp dụng validator tại parse/verify/reverify/persist transition; dữ liệu mâu thuẫn fail-closed với reason code.
- [ ] `P006-G5-S03` Thêm fixture PASS+coverage error và all-match; kiểm terminal state, audit/log chỉ chứa metadata.
- [ ] `P006-G5-S04` Chạy regression P003 quality/legacy bằng synthetic fixture; không gọi model thật ở unit gate.

**Cổng G5:** `T11–T12` và regression quality/legacy xanh; không code path nào tự quyết PASS ngoài shared validator.

### G6 — Export và download không mất dữ liệu

- [ ] `P006-G6-S01` Tạo API/query contract enumerate completed jobs theo folder tới EOF hoặc server manifest snapshot; authorize từng target.
- [ ] `P006-G6-S02` Đối chiếu requested/eligible/downloaded/failed; không dùng length của page đang hiển thị làm tổng.
- [ ] `P006-G6-S03` Thay filename allocator bằng final-name reservation có normalize/case-fold và kiểm directory hiện hữu.
- [ ] `P006-G6-S04` Đổi write lifecycle thành success=`close`, failure=`abort`; stream error/HTTP error không commit partial.
- [ ] `P006-G6-S05` Failure bất kỳ page/item làm export terminal `partial/failed`, không báo “toàn bộ”; cung cấp summary retry được.
- [ ] `P006-G6-S06` Delete confirmation lấy tổng server/canonical folder; không suy luận đã backup chỉ từ export button.

**Cổng G6:** `T29–T33` xanh với folder >200, collision case/Unicode/file hiện hữu, HTTP 500 và mid-stream failure; checksum của mọi file success đúng, file cũ không bị đè.

### G7 — Frontend state, phục hồi và accessibility

- [ ] `P006-G7-S01` Đổi folder grouping sang `Map`/null-prototype và rà dictionary động.
- [ ] `P006-G7-S02` Sửa job pagination newest-first ở backend; load-more lấy older cursor ổn định.
- [ ] `P006-G7-S03` Merge SSE resync theo job ID + revision/generation; không replace pages đã tải, bỏ response stale.
- [ ] `P006-G7-S04` Banner shutdown dùng `every` trên task relevant; mixed state hiển thị số task unsafe.
- [ ] `P006-G7-S05` Validate file size/type/zero-byte sớm và cho remove/reselect; backend vẫn là authority.
- [ ] `P006-G7-S06` Tách global server count khỏi local byte progress; sửa preview retry state.
- [ ] `P006-G7-S07` Khôi phục focus-visible, `aria-live`, keyboard Space/Enter và kiểm keyboard-only.

**Cổng G7:** `T26`, `T34–T37`, `T49–T50`, `T55–T56` xanh; reconnect nhiều lần không làm trạng thái lùi/mất history; ba prototype-key render/an toàn.

### G8 — Cấu hình, launcher, migration và công cụ

- [ ] `P006-G8-S01` Thực hiện D002: deployed-only launcher hoặc dev preflight namespace hoàn toàn local; `strictPort`, readiness timeout và exit code đúng.
- [ ] `P006-G8-S02` Thay integer parser bằng helper strict dùng chung; test toàn bộ biến số.
- [ ] `P006-G8-S03` Chỉ validate quality config trong quality mode; legacy rollback khởi động độc lập.
- [ ] `P006-G8-S04` Đặt `autoIndex:false` cho read-only/dry-run; thay `syncIndexes()` bằng additive index migration; drop cần approval riêng.
- [ ] `P006-G8-S05` Sửa `test:keys` exit semantics và redaction; không dùng lệnh này như health production.
- [ ] `P006-G8-S06` Đồng bộ README/package scripts; sửa TTL smoke; thống nhất retention config và reconcile threshold.
- [ ] `P006-G8-S07` Chốt/pin Node/package manager; xác minh dependency trực tiếp; dọn `.lnk`/PII/path không portable theo review.
- [ ] `P006-G8-S08` Hardening backup: stream/bounded memory, artifact ngoài repo, checksum, bảo vệ truy cập và restore drill.

**Cổng G8:** `T40–T47`, `T51–T53`, `T59–T62` xanh; launcher preflight chứng minh đúng một target/worker; dry-run có zero write/index; migration giữ manual index; backup bounded-memory và restore synthetic thành công.

### G9 — Full regression, security và failure matrix

- [ ] `P006-G9-S01` Chạy toàn bộ backend test/coverage và frontend test/coverage/lint/build trên runtime đã pin.
- [ ] `P006-G9-S02` Chạy race/fault matrix: lease loss, Mongo reject, R2 412/404/5xx, stream break, process SIGTERM, reconnect SSE.
- [ ] `P006-G9-S03` Chạy authorization matrix anonymous/A/B/admin cho mọi route từ G3.
- [ ] `P006-G9-S04` Chạy privacy scan artifact/build/log với sentinel; kiểm không có source/name/key/token/content.
- [ ] `P006-G9-S05` Chạy `npm audit` và dependency tree; review dependency mới nếu có, ưu tiên zero dependency mới.
- [ ] `P006-G9-S06` Review code theo caller map; xác nhận không còn shared helper/caller sibling bỏ sót.
- [ ] `P006-G9-S07` Tạo báo cáo coverage delta; coverage giảm chỉ được chấp nhận bằng waiver có lý do.

**Cổng G9:** tất cả test áp dụng xanh, zero S0/S1 mở, zero secret/PHI sentinel leak, lint/build/audit xanh, reviewer độc lập ký xác nhận invariant matrix.

### G10 — Rollout additive, canary và quan sát

- [ ] `P006-G10-S01` Backup + restore verification; lưu checksum/manifest ngoài repo, không chứa dữ liệu trong evidence công khai.
- [ ] `P006-G10-S02` Deploy schema/index additive trước code; xác minh readiness và index diff không drop.
- [ ] `P006-G10-S03` Deploy code với feature flags/default an toàn; auth boundary phải active trước mở endpoint.
- [ ] `P006-G10-S04` Canary chỉ dùng synthetic PDF nhỏ: upload, seal, translate, quality, export, delete, cleanup.
- [ ] `P006-G10-S05` Quan sát error/ownership-lost/cleanup backlog/readiness/SSE gauges theo cửa sổ đã chốt ở D006.
- [ ] `P006-G10-S06` Fault/cancel race chỉ chạy local/staging; production canary không cố tình làm stale-token race.
- [ ] `P006-G10-S07` Tăng traffic theo bậc; dừng ngay khi invariant, auth, error budget hoặc cleanup SLA vi phạm.

**Cổng G10:** canary synthetic hoàn tất end-to-end, không có source/chunk orphan, không log dữ liệu cấm, metric/readiness ổn trong cửa sổ D006 và rollback trigger chưa kích hoạt.

### G11 — Đóng dự án và archive

- [ ] `P006-G11-S01` Đối chiếu 36 lỗi + 10 risk; mỗi mục có trạng thái, test, commit và evidence/waiver.
- [ ] `P006-G11-S02` Hoàn tất runbook điều tra, upload recovery, cleanup, backup/restore, rollback và incident response.
- [ ] `P006-G11-S03` Xác nhận không còn runner nền ngoài runner dự kiến; đóng/xóa an toàn artifact local theo retention.
- [ ] `P006-G11-S04` Owner ký acceptance; cập nhật trạng thái tổng, decision/evidence/progress table.
- [ ] `P006-G11-S05` Chuyển file sang `archive/project-006/project-006.md`, cập nhật `archive/README.md` và link liên quan trong một commit riêng.

**Cổng G11:** closure checklist §20 đạt 100%; tài liệu archive là append-only, link hợp lệ và không chứa secret/dữ liệu người dùng.

## 12. Bảng tiến độ

| Giai đoạn | Trạng thái | Bước hoàn tất | Cổng | Bằng chứng gần nhất |
| --- | --- | ---: | --- | --- |
| G0 — Baseline/quyết định | Chưa bắt đầu triển khai | 0/10 | Chưa đạt | `E001` chỉ là audit lập kế hoạch |
| G1 — Observability | Chưa bắt đầu | 0/9 | Chưa đạt | — |
| G2 — Worker/cleanup | Chưa bắt đầu | 0/8 | Chưa đạt | — |
| G3 — Auth/security | Chưa bắt đầu | 0/8 | Chưa đạt | — |
| G4 — R2/upload | Chưa bắt đầu | 0/10 | Chưa đạt | — |
| G5 — Quality | Chưa bắt đầu | 0/4 | Chưa đạt | — |
| G6 — Export/download | Chưa bắt đầu | 0/6 | Chưa đạt | — |
| G7 — Frontend state/a11y | Chưa bắt đầu | 0/7 | Chưa đạt | — |
| G8 — Ops/tooling | Chưa bắt đầu | 0/8 | Chưa đạt | — |
| G9 — Regression/security | Chưa bắt đầu | 0/7 | Chưa đạt | — |
| G10 — Rollout/canary | Chưa bắt đầu | 0/7 | Chưa đạt | — |
| G11 — Close/archive | Chưa bắt đầu | 0/5 | Chưa đạt | — |

## 13. Ma trận test bắt buộc

### 13.1. Worker, source, auth và quality

| Test | Loại | Kịch bản và assertion bắt buộc | Lỗi/cổng |
| --- | --- | --- | --- |
| `P006-T01` | Race integration | Worker 1 dừng tại `assertJobActive`, lease hết, worker 2 claim; thả worker 1: nhận ownership lost, không terminal/cleanup. | BUG-01, G2 |
| `P006-T02` | Race integration | Worker 1 dừng trước save chunk, worker 2 claim token mới; chunk cũ không insert/update, chunk attempt mới còn nguyên. | BUG-01, G2 |
| `P006-T03` | Race integration | Permanent failure của stale attempt có terminal CAS `matchedCount=0`; job/source/output của attempt mới không đổi. | BUG-01, G2 |
| `P006-T04` | Integration | User cancel có authority hợp lệ vẫn chuyển trạng thái, dừng worker và cleanup đúng một lần. | BUG-01, G2 |
| `P006-T05` | Supertest | Anonymous nhận 401/403 trên upload, jobs, result, download, delete, SSE, metrics và wakeup. | BUG-02, G3 |
| `P006-T06` | Supertest | Nếu multi-user: A không đọc/tải/xóa B; nếu single-owner: credential ngoài audience bị chặn và query luôn scope đúng owner duy nhất. | BUG-02, G3 |
| `P006-T07` | Integration | SSE và streaming download kiểm auth trước header/body; unauthorized không tạo listener/stream/presign. | BUG-02, G3 |
| `P006-T08` | Contract | Public liveness không lộ DB/R2/queue; readiness detail và metrics cần quyền. | BUG-02/RISK-09/10, G3 |
| `P006-T09` | Integration | Tạo active R2 job cùng `.part`/`.pdf`; gọi capacity nhiều lần: zero delete/rename/write và file còn tồn tại. | BUG-03, G2 |
| `P006-T10` | Integration | GC với active + orphan: giữ toàn bộ active path, chỉ xóa orphan quá grace; chạy đúng lúc download/rename không `ENOENT`. | BUG-03, G2 |
| `P006-T11` | Unit | Report `PASS + errors=[] + COMPLETE` nhưng một coverage item `error` bị reject và không persist `passed`. | BUG-04, G5 |
| `P006-T12` | Unit/integration | Verify/reverify reject coverage thiếu, ID trùng, ID lạ hoặc count do model tự báo; exact expected-ID set all-match mới pass. | BUG-04, G5 |
| `P006-T13` | Fault integration | Inject lỗi DB ở lần ghi cleanup marker đầu; sau DB hồi phục/restart, recovery phát hiện và xóa source rồi mark succeeded. | BUG-05, G2 |
| `P006-T14` | Integration | Chạy cleanup/recovery lặp lại không double-delete sai, không đổi job ngoài phạm vi và có terminal outcome duy nhất. | BUG-05, G2 |
| `P006-T15` | R2 adapter | Confirm ETag A, overwrite staging cùng size thành ETag B; resolve bằng A fail-closed, không đưa bytes B vào worker. | BUG-06, G4 |
| `P006-T16` | R2 adapter | Source ETag/version đúng được stream đủ, size/magic/checksum contract đạt. | BUG-06, G4 |
| `P006-T17` | Integration | Nếu sealed-copy: PUT muộn chỉ đổi staging; sealed key worker đọc không đổi và staging eventual cleanup. | BUG-06, G4 |
| `P006-T18` | Race integration | Barrier tại HEAD/update/delete, confirm thắng abandon: DB/object/response đều ready hợp lệ, abandon không xóa sealed source. | BUG-07, G4 |
| `P006-T19` | Race integration | Abandon thắng confirm: response/DB đều abandoned, confirm không trả pending giả; object eventual cleanup. | BUG-07, G4 |

### 13.2. Upload state, frontend và export

| Test | Loại | Kịch bản và assertion bắt buộc | Lỗi/cổng |
| --- | --- | --- | --- |
| `P006-T20` | API race | PUT đang deferred rồi DELETE job/folder: backend 409 hoặc chuyển abandon an toàn; manifest không mất. | BUG-08, G4 |
| `P006-T21` | Integration | PUT hoàn tất muộn sau abandon/delete không tạo orphan vĩnh viễn; reconciler dọn sau TTL. | BUG-08, G4 |
| `P006-T22` | Unit | Batch ready, job dịch `pending -> processing -> failed`: upload batch vẫn ready/canClose và confirmed count không đổi. | BUG-09, G4 |
| `P006-T23` | Integration | Refresh batch phân biệt upload failure thật với translation failure và giữ invariant count tổng. | BUG-09, G4 |
| `P006-T24` | Unit/fault | Reconcile promise reject: không có `unhandledRejection`, flag reset, log/metric an toàn và tick kế tiếp thành công. | BUG-10, G4 |
| `P006-T25` | Frontend/integration | Reload batch partial: có reattach và abandon toàn batch; file đúng resume, metadata sai bị từ chối, không cần dữ liệu raw từ server. | BUG-11, G4 |
| `P006-T26` | Frontend | Queue safe+unsafe không hiện banner an toàn; toàn bộ relevant task safe mới hiện; count unsafe đúng. | BUG-12, G7 |
| `P006-T27` | Contract/load-local | Ba batch 500-file theo contract không tự chạm limiter confirm; abusive prepare vẫn 429. | BUG-13, G3 |
| `P006-T28` | Unit | Inject 429 + `Retry-After`; fake clock xác nhận client chờ đúng header, không retry 300/600 ms nóng. | BUG-13, G3 |
| `P006-T29` | Integration/frontend | Folder >200 completed jobs qua nhiều page được enumerate đúng một lần và export đủ theo manifest/tổng server. | BUG-14, G6 |
| `P006-T30` | Frontend | Page giữa lỗi/unauthorized hoặc tổng thay đổi: không báo “toàn bộ”, summary partial rõ và không dẫn người dùng sang xóa nhầm. | BUG-14, G6 |
| `P006-T31` | Frontend | HTTP 500 trước stream: writable `abort`, không `close`, file cũ giữ nguyên. | BUG-15, G6 |
| `P006-T32` | Frontend | Stream lỗi giữa chừng: abort và không commit partial; success path close đúng bytes/checksum. | BUG-15, G6 |
| `P006-T33` | Unit/frontend | `A.pdf,A.pdf,A_2.pdf`, case/Unicode/sanitize collision và file đích có sẵn đều sinh final name unique, không overwrite. | BUG-16, G6 |
| `P006-T34` | Frontend | Render/action folder `constructor`, `toString`, `__proto__`; không crash và prototype không đổi. | BUG-17, G7 |
| `P006-T35` | Frontend | Load hai page rồi reconnect SSE; cả hai page/cursor còn, page đầu mới được merge. | BUG-18, G7 |
| `P006-T36` | Frontend race | Hoãn GET processing, emit SSE completed rồi resolve GET; UI cuối vẫn completed theo revision/generation. | BUG-19, G7 |
| `P006-T37` | Backend/frontend | Initial page trả newest, load-more trả older không trùng; insert mới trong lúc paging không làm lùi/mất cursor. | BUG-20, G7 |
| `P006-T38` | Process integration | SIGTERM đặt readiness false, ngừng claim, drain/timeout đúng; restart recover lease mà không double-terminal/cleanup. | RISK-05, G2/G9 |
| `P006-T39` | Privacy/trace CLI | Chạy `trace:p006`/công cụ tương đương: sentinel trong name/path/key/token/content/raw error không xuất hiện; output nối đủ bằng opaque IDs; ID sai/không tồn tại có exit code an toàn. | RISK-08, G1/G9 |

### 13.3. Launcher, migration, config và công cụ

| Test | Loại | Kịch bản và assertion bắt buộc | Lỗi/cổng |
| --- | --- | --- | --- |
| `P006-T40` | Static/preflight | Launcher phát hiện frontend production + backend/worker local-remote và refuse trước start; không in secret. | BUG-21, G8 |
| `P006-T41` | Process | Một invocation tạo đúng target và số worker dự kiến; PID/port/readiness được xác nhận, process lỗi không báo ready. | BUG-21, G8 |
| `P006-T42` | Mock integration | Dry-run migration/reconcile dùng `autoIndex:false` và có zero create/update/delete/index side effect. | BUG-22, G8 |
| `P006-T43` | Migration | Additive migration tạo index thiếu nhưng giữ manual index; drop chỉ xảy ra trong test có approval flag riêng. | BUG-22, G8 |
| `P006-T44` | Unit table | Mọi integer env reject suffix, fraction, scientific, zero/negative/unsafe; chấp nhận positive canonical sau trim. | BUG-23, G8 |
| `P006-T45` | Unit/config | Legacy start dù quality-only var thiếu/sai; quality mode vẫn validate strict; toggle không mutate job cũ. | BUG-24, G8 |
| `P006-T46` | Documentation check | Mọi `npm run <name>` trong README tồn tại trong đúng `package.json` hoặc được ghi rõ archived/non-runnable. | BUG-25, G8 |
| `P006-T47` | CLI | `test:keys`: zero key/all fail exit 1, policy success exit 0; stdout/stderr không lộ key/raw credential error. | BUG-26, G8 |
| `P006-T48` | API/frontend | Folder >120 ký tự nhận canonical identity; delete/refresh dùng identity đó và UI chỉ bỏ state khi server xác nhận. | BUG-27, G4 |
| `P006-T49` | Frontend/API | 0 byte, quá size, sai type bị chặn sớm/remove được; bypass client vẫn bị backend từ chối cùng error code. | BUG-28, G7 |
| `P006-T50` | Frontend | Global uploading count và local active-byte progress có nhãn/nguồn riêng, safe task không giữ progress active. | BUG-29, G7 |
| `P006-T51` | Script | R2 presign smoke assertion dùng TTL fixture/config nhất quán ở ít nhất hai giá trị. | BUG-30, G8 |
| `P006-T52` | Launcher | Port bận/backend fail/readiness timeout đều exit non-zero; `strictPort` ngăn Vite tự đổi cổng. | BUG-31, G8 |
| `P006-T53` | Config/reconcile | Retention/account config có một nguồn sự thật; giá trị đổi làm reconcile threshold đổi đúng hoặc biến chết bị xóa. | BUG-32, G8 |
| `P006-T54` | Frontend/memory | Sau task terminal, không còn `File` trong entries/state; metadata UI vẫn đủ và heap không giữ fixture lớn. | BUG-33, G4 |
| `P006-T55` | Frontend | Preview fetch lỗi giữ panel đóng; retry thành công chỉ cần một action và hiển thị đúng. | BUG-34, G7 |
| `P006-T56` | A11y | Keyboard-only/focus-visible/Space-Enter/live-region hoạt động; axe hoặc check tương đương không có regression mục tiêu. | BUG-35, G7 |
| `P006-T57` | Fault integration | Crash ngay sau tạo UploadBatch trước insert jobs; restart/reconcile hoàn tất hoặc abandon, không khóa clientBatchId. | BUG-36, G4 |
| `P006-T58` | Idempotency | Retry prepare cùng clientBatchId sau timeout/crash trả cùng manifest hợp lệ, không tạo duplicate batch/job/object. | BUG-36, G4 |

### 13.4. Hardening, runtime contract và credential lifecycle

| Test | Loại | Kịch bản và assertion bắt buộc | Rủi ro/cổng |
| --- | --- | --- | --- |
| `P006-T59` | Backup/load-local | Backup synthetic lớn theo cursor/stream giữ peak memory dưới ngưỡng được chốt ở G8-S08, artifact ngoài repo có checksum/protection và restore drill khớp manifest. | RISK-01, G8 |
| `P006-T60` | CLI | `reconcile-r2`: clean exit 0; anomaly/error exit non-zero theo contract; report-only được gắn nhãn rõ và không mutation. | RISK-03, G8 |
| `P006-T61` | Runtime/dependency | CI chạy đúng Node/package-manager đã pin; import `bson`/mọi package runtime có dependency trực tiếp hợp lệ, không phụ thuộc hoisting tình cờ. | RISK-02/04, G8 |
| `P006-T62` | Repository privacy | Scan tracked files chặn `.lnk`/absolute user path, email/private-key location và artifact nhạy cảm ngoài allowlist có review; không xóa mù tài liệu hợp lệ. | RISK-06, G8/G9 |
| `P006-T63` | SSE load/security | Vượt cap principal/IP bị từ chối; close, logout và revoke tháo listener; active gauge về baseline, anonymous không tạo listener. | RISK-07, G3 |
| `P006-T64` | Health/readiness | Liveness không gọi DB/R2/Gemini; readiness chỉ read-only, phản ánh init/worker/reconciler/sweeper stale và không cleanup/index/billing. | RISK-09, G1 |
| `P006-T65` | Metrics contract | Restart đổi `bootId`; metrics protected, không có `jobId`/batch/key index/error text label, cardinality giữ bounded dưới workload synthetic. | RISK-10, G1/G3 |
| `P006-T66` | Auth lifecycle | Theo D001: bootstrap an toàn, expiry/logout/rotate/revoke chặn request và stream cũ; cookie path chống CSRF hoặc bearer path dùng authenticated fetch-stream, không native EventSource thiếu header. | BUG-02, G3 |

## 14. Quy trình cụ thể để theo dấu một lần thực thi

Phần này mô tả trạng thái đích sau G1. Trước khi G1 hoàn thành, không được giả định các command/script trace bên dưới đã tồn tại.

### 14.1. Theo dấu một request/job từ đầu đến cuối

1. **Xác nhận đúng bản chạy:** gọi readiness có quyền và ghi `release`, `bootId`, `environment`, component status. Dừng nếu release khác commit đang điều tra hoặc component degraded không liên quan được giải thích.
2. **Gửi hành động với operation ID:** client nhận `X-Request-Id`; action nhiều request nhận `operationId` do server phát. Ghi hai ID này vào run metadata, không ghi tên file/folder.
3. **Theo upload batch:** truy vấn trace bằng `requestId`/`operationId`; lấy opaque `batchId`, kiểm chuỗi `prepared -> item sealed -> batch terminal`. Một event `started` chưa chứng minh DB đã đổi.
4. **Theo job:** từ audit/event lấy `jobId`; kiểm DB bằng safe projection chỉ gồm ID/status/sourceState/attemptCount/timestamps/cleanupState, tuyệt đối không select nội dung/tên/path/key.
5. **Theo attempt:** nhóm event theo `jobAttempt`; chỉ attempt claim hiện tại được có heartbeat/write/terminal. Nếu thấy `ownership.lost`, attempt đó không được có cleanup hoặc terminal persisted sau thời điểm mất quyền.
6. **Theo quality:** kiểm stage transition và reason code; `passed` phải có strict validator success, không cần và không được đọc raw quality report trong log.
7. **Theo terminal và cleanup:** terminal DB event phải xuất hiện trước cleanup requested; kết thúc bằng cleanup completed hoặc retry scheduled có deadline. User delete phải có audit requested + terminal outcome.
8. **Đối chiếu metric:** counter delta khớp outcome, active gauge trở về baseline, backlog/freshness trong SLA; metric chỉ dùng để phát hiện, event/audit/DB safe projection dùng để kết luận.
9. **Kết luận run:** runner ghi đúng một `complete.json` hoặc `failure.json`, rồi tạo `summary.md` chỉ chứa ID opaque, outcome, duration, test/evidence IDs và lỗi đã redact.

Command đích cần được G1 cung cấp để tránh điều tra thủ công không nhất quán:

```powershell
# Safe summary theo request; script phải tự redact và chỉ dùng projection allowlist.
npm run trace:p006 -- --request-id <uuid>

# Hoặc theo operation nhiều request.
npm run trace:p006 -- --operation-id <uuid>

# Kiểm health của component mà không gây cleanup, index hay Gemini call.
npm run status:p006
```

Các script này chưa có ở baseline; `P006-G1-S08` chịu trách nhiệm tạo hoặc thay bằng công cụ tương đương, sau đó `P006-T39` khóa contract riêng tư.

### 14.2. Theo dấu tiến độ sửa P006

Mỗi phiên làm việc thực hiện đúng thứ tự:

1. Chọn **một** bước `P006-Gx-Syy` có dependency đã đạt; ghi owner, thời điểm, branch và test mục tiêu vào Nhật ký thực thi.
2. Chụp test tái hiện đỏ và lưu command/exit code trong artifact; không lưu raw PDF/model output.
3. Truy vết mọi caller của shared function sẽ sửa; cập nhật Bản đồ caller §16 nếu phát hiện nhánh mới.
4. Viết diff nhỏ nhất đạt invariant; không gom refactor ngoài phạm vi vào cùng commit.
5. Chạy test mục tiêu, rồi gate của giai đoạn, rồi full regression thích hợp.
6. Review `git diff --check`, `git diff --stat`, secret/privacy scan và file list trước stage.
7. Commit có mã bước; append `P006-E...` gồm commit, command, exit, artifact/checksum và phạm vi môi trường.
8. Chỉ sau bước 7 mới đổi checkbox `[ ]` thành `[x]` và cập nhật Bảng tiến độ.
9. Nếu test đỏ do nguyên nhân mới, tạo mã lỗi/risk mới và liên kết; không âm thầm nới assertion.
10. Nếu rollback/waiver, ghi decision trước khi tiếp tục giai đoạn phụ thuộc.

### 14.3. Lệnh gate hiện có tại baseline

```powershell
Push-Location .\med-translator-backend
npm test
npm run test:coverage
npm audit
npm ls --all
Pop-Location

Push-Location .\med-translator-frontend
npm test
npm run test:coverage
npm run lint
npm run build
npm audit
npm ls --all
Pop-Location
```

Không chạy `test:keys`, migration, R2 smoke, quality smoke hoặc reconcile với `.env` production trong gate local mặc định. Các lệnh đó cần fixture/environment tách biệt và approval tương ứng.

### 14.4. Cấu trúc artifact/checkpoint cho runner dài

Artifact local đích, chỉ được dùng sau khi `.p006-local/` đã nằm trong `.gitignore`:

```text
.p006-local/
  runs/
    <runId>/
      metadata.json       # runId, release, boot/environment giả lập, test IDs, startedAt
      runner.pid          # PID duy nhất của runner, không chứa command/secret
      stdout.jsonl        # structured allowlist events
      stderr.log          # lỗi đã redact
      checkpoint.json     # phase/test cuối đã hoàn tất, updatedAt, resume contract
      complete.json       # chỉ tạo khi exit 0 và mọi gate mục tiêu đạt
      failure.json        # chỉ tạo khi fail/timeout/cancel, gồm safe error code
      summary.md          # báo cáo ngắn không chứa dữ liệu cấm
```

Quy tắc:

- `runId` dạng UUID; resume cùng run chỉ khi checkpoint schema/release khớp.
- `checkpoint.json` ghi atomically qua temp + rename; không coi dòng stdout cuối là checkpoint.
- Một run chỉ có một terminal marker; nếu cả hai xuất hiện thì run invalid và phải điều tra runner.
- Test dùng synthetic PDF, ID giả và service adapter/mock; không copy production payload vào artifact.
- Retention/xóa artifact phải theo D005; không commit artifact.

### 14.5. Bàn giao runner nền

Test/benchmark dài, không cần giám sát liên tục, phải chạy bằng một tiến trình nền có checkpoint. Trước khi kết thúc lượt vận hành phải cung cấp đủ:

- đúng một PID dự kiến và `runId`;
- kết quả enumerate process chứng minh chỉ có đúng một runner P006 mang `runId` đó; lệnh kiểm tra không được truyền secret trên command line;
- đường dẫn tuyệt đối tới `stdout.jsonl`, `stderr.log`, `checkpoint.json`;
- lệnh kiểm tra ngắn, ví dụ:

```powershell
Get-Process -Id <PID> -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*p006-runner*' -and $_.CommandLine -like '*<runId>*' } |
  Select-Object ProcessId, CommandLine
Get-Content -Tail 20 -LiteralPath '<absolute-run-path>\stdout.jsonl'
Get-Content -Raw -LiteralPath '<absolute-run-path>\checkpoint.json'
```

- tiêu chí hoàn tất: process exit, `complete.json` tồn tại, `failure.json` không tồn tại, summary ghi exit 0 và đủ test IDs;
- tiêu chí thất bại: `failure.json` tồn tại, stderr có safe error code, checkpoint quá freshness SLA hoặc process mất mà không có terminal marker;
- lưu ý: tắt Codex/terminal có thể được nếu runner thật sự độc lập; tắt máy sẽ dừng runner và chỉ resume khi checkpoint contract cho phép.

Sau bàn giao không polling chỉ để chờ. Khi người dùng quay lại, kiểm theo thứ tự: process → checkpoint → terminal marker → stderr → summary; không mặc định thành công chỉ vì PID đã biến mất.

## 15. Runbook điều tra nhanh

| Triệu chứng | ID/nguồn bắt đầu | Kiểm đầu tiên | Invariant kết luận | Không được làm |
| --- | --- | --- | --- | --- |
| Job biến mất sau reclaim | `jobId`, `jobAttempt` | Event claim/ownership/terminal/cleanup theo thời gian | Attempt cũ sau ownership lost không có destructive event | Không log token để “so sánh” |
| Source R2 mất | `jobId`, `operationId` | sourceState, seal ETag outcome, cleanup audit, reconciler | Chỉ sealed đúng version được đọc; cleanup có authority | Không mở/log presigned URL/key |
| UI trạng thái lùi | `requestId`, `jobId` | revision HTTP và SSE event generation | Revision mới nhất thắng, history không bị replace | Không coi SSE là nguồn replay |
| Export thiếu/đè file | `operationId` | manifest total, page/item outcome, allocator reservation | Success count đúng manifest; mỗi final name unique | Không kết luận từ số item đang hiển thị |
| File rỗng/partial | `operationId`, item ordinal | HTTP status, bytes, abort/close event | Failure chỉ abort; close chỉ sau EOF | Không giữ raw file để đưa vào log |
| Cleanup backlog tăng | component/release | readiness freshness, retry counter, terminal source projection | Mọi terminal source có completed hoặc scheduled retry | Không gọi capacity để ép cleanup |
| Anonymous thấy dữ liệu | `requestId`, actorRef | auth decision, route audit, response status | Auth trước query/stream/listener | Không dựa vào CORS/browser UI |
| Quality false pass | `jobId`, `jobAttempt` | strict validator outcome/reason | Mọi coverage item match | Không log raw report |

## 16. Bản đồ caller và điểm sửa gốc

| Miền | Điểm dùng chung cần ưu tiên | Caller/consumer phải rà | Lỗi liên quan |
| --- | --- | --- | --- |
| Queue ownership | `assertJobActive`, `saveTranslatedChunk`, terminal/failure handler, `cleanupJob` | worker loop, cancel, permanent fail, delete/recovery | BUG-01, BUG-05 |
| Source lifecycle | `SourceService`, `sourceCleanupService`, `storageService` GC | capacity, worker resolve, user delete, sweeper, reconciler | BUG-03, BUG-05, BUG-06 |
| Upload state | `uploadBatchService` prepare/confirm/refresh/abandon/reconcile | upload controller, frontend `cloudUploader`, delete folder/job | BUG-07–13, BUG-36 |
| Auth boundary | Express middleware + owner-scoped repository/query | jobs/result/download/SSE/metrics/delete/upload/wakeup | BUG-02, BUG-13 |
| Quality | strict validator trong `translationQuality` | verify/reverify/parser/pipeline state/persist | BUG-04 |
| Job pagination | queue/service list query và cursor contract | initial fetch, load more, SSE resync, folder export | BUG-14, BUG-18–20 |
| Export writer | manifest enumeration, filename allocator, writable lifecycle | folder download UI, summary/delete confirmation | BUG-14–16 |
| Frontend job reducer | merge theo revision, grouping canonical | HTTP resync, SSE, deletion, folders, dashboard | BUG-17–20, BUG-27, BUG-29 |
| Config/tooling | `env.js`, launcher preflight, migration connector | server startup, legacy mode, smoke/reconcile/backup docs | BUG-21–26, BUG-30–32 |
| Telemetry | request context/logger/audit/metrics | mọi route, worker claim, R2, quality, cleanup/export | RISK-07–10 |

## 17. Chiến lược commit và review

- Một commit chỉ nên đóng một bước hoặc một invariant nhỏ; test đi cùng bản sửa.
- Commit mẫu:

```text
test(P006-G2-S05): reproduce stale worker cleanup race
fix(P006-G2-S03): fence chunk and terminal writes by attempt
fix(P006-G6-S04): abort failed directory downloads
feat(P006-G1-S01): add safe request correlation context
docs(P006-G8-S06): align runnable scripts with package metadata
```

- Thứ tự review ưu tiên: invariant/data loss → auth/privacy → R2 state machine → export → UI → ops/docs.
- Reviewer phải lần caller từ §16, không chỉ đọc diff tại symptom.
- Không gộp migration/index change với feature code trong cùng commit rollout.
- Không commit `.env`, `.p006-local`, backup, PDF, output dịch, raw log hay screenshot có dữ liệu người dùng.

## 18. Rollout, rollback và trigger dừng

### 18.1. Thứ tự rollout

1. Migration additive/index/audit schema, xác minh không drop.
2. Observability/readiness ở chế độ tương thích, không đổi business outcome.
3. Worker fencing + source cleanup/GC read-only.
4. Auth boundary và frontend auth trong một cửa sổ phối hợp; không để endpoint mở do lệch version.
5. R2/upload state machine theo feature flag/versioned transition nếu cần.
6. Quality strict validator.
7. Export/UI/config/tool fixes.
8. Synthetic canary, rồi tăng traffic theo bậc.

### 18.2. Trigger dừng/rollback

Rollback hoặc dừng traffic ngay khi có một trong các dấu hiệu:

- ownership lost đi kèm terminal/cleanup của attempt cũ;
- auth bypass, 2xx anonymous trên route protected hoặc audit destructive bị mất;
- sealed source integrity mismatch không được fail-closed;
- cleanup backlog/freshness vượt ngưỡng D006 hoặc source active bị xóa;
- false PASS quality;
- export success count/checksum không khớp manifest;
- readiness false kéo dài hoặc error rate/latency vượt error budget D006;
- log/artifact có sentinel/secret/nội dung cấm.

### 18.3. Nguyên tắc rollback

- Rollback code bằng release trước; không drop field/index mới trong cùng sự cố.
- Migration additive phải tương thích ít nhất một release trước/sau.
- Không rollback auth bằng cách mở public API; nếu frontend/auth lệch, đóng traffic hoặc dùng bản pair đã xác minh.
- Không chuyển về worker không-fence nếu schema/source state mới đã hoạt động; giữ claim off cho tới khi release an toàn sẵn sàng.
- Quality có thể dùng mode legacy chỉ nếu G8 chứng minh khởi động được và decision/waiver chấp nhận semantics; không âm thầm hạ strict-PASS cho job quality.
- Restore dữ liệu chỉ sau khi xác định phạm vi/checksum và có approval; không dùng restore để che lỗi logic chưa sửa.

## 19. Nhật ký quyết định, bằng chứng và thực thi

### 19.1. Nhật ký quyết định

| Mã | Trạng thái | Quyết định cần chốt / quyết định đã có | Owner | Ngày | Tác động |
| --- | --- | --- | --- | --- | --- |
| `P006-D001` | Chờ chốt | Single-owner gateway/session hay multi-user ownership; phải chốt bootstrap, HTTP/SSE transport, cookie+CSRF hoặc bearer, expiry, logout, rotation và revocation. P006 sẽ thay thế quyết định no-auth thuộc phạm vi P002 sau khi chốt, không sửa lịch sử P002. | Chủ dự án | — | Schema, route query, frontend auth, test A/B và credential lifecycle |
| `P006-D002` | Chờ chốt | Launcher chỉ mở deployed app (khuyến nghị ít rủi ro/ít code) hay giữ dev stack với namespace local bắt buộc. | Chủ dự án | — | Launcher, `.env.local`, worker startup |
| `P006-D003` | Chờ chốt | Sealed-copy staging → immutable key (khuyến nghị) hay conditional GET `If-Match`. | Tech owner | — | R2 cost/state/reconcile |
| `P006-D004` | Chờ xác minh | Mongo deployment có transaction phù hợp prepare batch hay dùng state `preparing` + reconciler. | Tech owner | — | BUG-36 implementation |
| `P006-D005` | Chờ chốt | Audit sink, retention đề xuất 90 ngày, quyền đọc, action nào fail-closed. | Security/data owner | — | Schema/storage/privacy |
| `P006-D006` | Chờ chốt | Canary window, error budget, cleanup freshness/backlog và rollback threshold. | Ops owner | — | G10 gate |
| `P006-D007` | Đã chốt | Project đang mở giữ tài liệu ở root; chỉ archive sau G11. | Quy ước repository | 19-07-2026 | Vị trí `project 006.md` |

### 19.2. Nhật ký bằng chứng

Nhật ký append-only; nếu bằng chứng sai, thêm mục đính chính thay vì sửa làm mất lịch sử.

| Mã | Ngày | Phạm vi | Kết quả | Artifact/command | Ghi chú |
| --- | --- | --- | --- | --- | --- |
| `P006-E001` | 19-07-2026 | Baseline audit tại `3926a63bb7e4` | Backend 118/118; frontend 22/22; syntax/lint/build pass; audit 0; coverage backend 84,69%, frontend 66,5% | Các npm gate hiện có, kết quả phiên audit lập kế hoạch | Không chạy live Mongo/R2/Gemini/migration; không phải production evidence |
| `P006-E002` | — | G0 runtime/worktree snapshot | Chưa chạy | `.p006-local/runs/<runId>/metadata.json` | Chỉ điền sau G0-S01 |

Mẫu mục mới:

```text
| P006-E0xx | YYYY-MM-DD | P006-Gx-Syy / BUG-nn | PASS/FAIL/BLOCKED |
  command + exit code + commit + artifact checksum | local/staging/production; giới hạn bằng chứng |
```

### 19.3. Nhật ký thực thi

| Run/session | Bước | Owner | Bắt đầu/kết thúc | Branch/commit | Test mục tiêu | Trạng thái | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — | Chưa có phiên triển khai | — |

## 20. Closure checklist

- [ ] Tất cả `P006-BUG-01…36` đã fix hoặc có waiver owner còn hiệu lực; không S0/S1 nào được waiver chỉ để kịp rollout.
- [ ] Tất cả `P006-RISK-01…10` đã được xác minh và có trạng thái cuối.
- [ ] Tất cả bước G0–G11 và cổng tương ứng đạt; bảng tiến độ khớp checkbox.
- [ ] Ma trận test áp dụng `P006-T01…66` xanh trên runtime đã pin; baseline test/lint/build/audit không hồi quy.
- [ ] Auth/authorization route matrix được review; SSE/download/metrics/admin không có đường vòng.
- [ ] Worker/source/upload/quality/export invariants có race/fault test tự động.
- [ ] Trace một synthetic job nối đủ request → batch → job → attempt → quality → terminal → cleanup mà không lộ dữ liệu cấm.
- [ ] Health/readiness/metrics/audit/runbook hoạt động và có quyền truy cập đúng.
- [ ] Migration additive, backup checksum và restore drill có bằng chứng; rollback pair đã diễn tập.
- [ ] Canary synthetic đạt trong cửa sổ D006, không trigger rollback.
- [ ] Không còn runner nền ngoài runner dự kiến; terminal marker/artifact retention được xử lý.
- [ ] `git diff --check`, test, lint, build, audit và secret/privacy scan cuối đều pass.
- [ ] Owner ký acceptance; decision/evidence log đầy đủ và không chứa secret/PII/PHI.
- [ ] File được chuyển vào `archive/project-006/project-006.md` và `archive/README.md` cập nhật trong commit đóng riêng.

## 21. Điều kiện bắt đầu ngay

Thứ tự công việc đầu tiên được khuyến nghị:

1. Thực hiện `P006-G0-S01`, thêm runner artifact ignore và chụp baseline tái lập được.
2. Chốt D001 (auth) và D002 (launcher); riêng launcher nên cô lập ngay vì hiện có khả năng trộn môi trường.
3. Viết test đỏ `T01–T04` và sửa BUG-01 trước mọi thay đổi concurrency/cleanup khác.
4. Viết `T09–T10`, làm capacity read-only để loại mutation từ GET.
5. Xây correlation/logger tối thiểu của G1 song song với test, nhưng không đưa token/nội dung vào log.
6. Sau khi G2 đạt mới mở G3/G4; không làm state machine R2 khi destructive fencing còn sai.

P006 không được coi là đã bắt đầu triển khai chỉ vì tài liệu này tồn tại. Bước đầu tiên chỉ chuyển `[x]` khi có commit và `P006-E002` hợp lệ.
