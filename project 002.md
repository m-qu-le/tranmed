# PROJECT 002 — Upload bền vững lên Cloudflare R2 và dịch độc lập với trình duyệt

## 1. Thông tin dự án

| Thuộc tính | Giá trị |
| --- | --- |
| Mã kế hoạch | P002 |
| Ngày lập | 15-07-2026 |
| Trạng thái tổng | G1–G8 hoàn tất cục bộ; bước tiếp theo là G9 test tải, lỗi và hiệu năng |
| Mục tiêu chính | Cho phép chọn và upload 50–200+ PDF lên cloud trong một phiên ngắn, xác nhận an toàn rồi đóng tab/tắt máy; Render tiếp tục dịch toàn bộ batch mà không cần trình duyệt |
| Kho file nguồn | Cloudflare R2 Standard, bucket private, lưu tạm và xóa sau xử lý |
| Nguồn sự thật của queue | MongoDB |
| Hạ tầng giữ nguyên | Vercel frontend, Render backend/worker, MongoDB, Gemini |
| Quy mô thiết kế | Mặc định tối đa 500 file/batch; phần lớn 1–3 MB/file, một số file tới khoảng 30 MB |
| Ngoài phạm vi | Đăng nhập, mật khẩu, `UPLOAD_SECRET`, phân quyền nhiều người dùng; thay Gemini; thay toàn bộ UI; lưu PDF lâu dài |

## 2. Vấn đề cần giải quyết

PROJECT 001 bảo vệ disk tạm của Render bằng cách chỉ upload một file, đợi file đó dịch xong rồi mới upload file kế tiếp. Các file chưa tới lượt chỉ tồn tại trong `File` object của tab trình duyệt. Vì vậy, đóng tab, F5 hoặc tắt máy sẽ làm mất phần Local Queue chưa lên cloud.

PROJECT 002 thay đổi ranh giới bền vững của hệ thống:

- Trình duyệt upload toàn bộ PDF trực tiếp lên R2 trước, không đi xuyên qua Render.
- MongoDB lưu metadata và trạng thái của từng PDF.
- Chỉ khi R2 và backend đã xác nhận mọi file của batch tồn tại an toàn, giao diện mới báo **“Đã lưu trên Cloud — có thể tắt máy”**.
- Render tải từng file từ R2 về disk tạm khi tới lượt dịch.
- Restart/redeploy/spin-down Render không làm mất PDF nguồn vì bản nguồn vẫn còn trên R2.
- Sau khi job hoàn thành, bị hủy hoặc lỗi vĩnh viễn theo chính sách, backend xóa PDF nguồn khỏi R2.
- Lifecycle của R2 là lớp dọn rác cuối cùng nếu backend không xóa được.

## 3. Các quyết định kiến trúc đã chốt

### 3.1. Không thêm đăng nhập hoặc mật khẩu

Theo quyết định của chủ dự án, P002 **không triển khai authentication/authorization**, không thêm màn hình đăng nhập, mật khẩu cá nhân hoặc `UPLOAD_SECRET`. Đây là ứng dụng cá nhân và chủ dự án chấp nhận rủi ro endpoint công khai có thể bị request ngoài ý muốn.

Các giới hạn kỹ thuật như số file/batch, dung lượng file, rate limit và kiểm tra PDF vẫn được giữ để tránh lỗi vận hành; chúng không phải cơ chế đăng nhập.

### 3.2. Bucket R2 luôn private

Bucket không bật public access và không dùng `r2.dev` để công khai file. Việc không có đăng nhập ở ứng dụng không đồng nghĩa với việc công khai bucket.

Backend giữ R2 API credentials và tạo presigned URL ngắn hạn cho đúng một thao tác `PUT` trên đúng một object. Presigned URL là cơ chế kỹ thuật giữa backend và R2, không yêu cầu người dùng đăng nhập và không làm lộ Secret Access Key.

### 3.3. Upload trực tiếp từ trình duyệt tới R2

PDF không đi qua Vercel và không đi qua request body của Render. Backend chỉ tạo metadata, presigned URL và xác nhận object bằng `HEAD`. Điều này:

- Không chiếm disk/RAM/bandwidth upload của Render khi nạp batch.
- Cho phép upload đồng thời có giới hạn, dự kiến 4 file.
- Không bị chặn bởi quy tắc PROJECT 001 “server chỉ giữ một source file”.
- Tách thời gian upload khỏi thời gian dịch.

### 3.4. MongoDB vẫn là nguồn sự thật của queue

R2 chỉ lưu byte PDF nguồn. MongoDB quyết định file nào đang upload, đã sẵn sàng, pending, processing, retry, completed, failed hoặc cancelled. Worker không dùng thao tác liệt kê bucket làm queue chính.

### 3.5. Xóa chủ động và lifecycle phòng vệ

- Backend xóa object R2 ngay khi không còn cần nguồn.
- Lỗi retryable giữ object để lần sau tiếp tục.
- Lifecycle mặc định xóa object dưới prefix `incoming/` sau 3 ngày để dọn orphan.
- Không chuyển sang R2 Infrequent Access; dùng Standard để hưởng free tier và không có minimum-retention/retrieval fee.

### 3.6. Tương thích và triển khai cuốn chiếu

Schema mới phải additive. Backend mới vẫn đọc được job P001 dùng `filePath`; frontend cũ vẫn có thể hoạt động trong thời gian backend/frontend deploy lệch phiên bản. Chỉ loại bỏ luồng Local Feeder cũ sau khi batch R2 production đạt.

## 4. Luồng mục tiêu

```text
Người dùng chọn 50–200+ PDF
        |
        v
Frontend gửi manifest nhỏ tới Render
        |
        v
Render tạo job trạng thái uploading + presigned PUT URL
        |
        v
Frontend upload trực tiếp 4 PDF song song tới R2
        |
        v
Backend HEAD xác nhận size/ETag và chuyển job sang pending
        |
        v
Toàn batch đã xác nhận -> UI báo "Có thể tắt máy"
        |
        v
Worker claim từng job -> tải 1 PDF từ R2 về disk tạm
        |
        v
Dịch/chunk/retry như P001 -> lưu kết quả MongoDB
        |
        v
Xóa file tạm Render + xóa source R2 -> job completed
```

## 5. Bảng tiến độ tổng

| Giai đoạn | Nội dung | Trạng thái | Cổng nghiệm thu |
| --- | --- | --- | --- |
| G1 | Đăng ký và cấu hình Cloudflare R2 | Hoàn thành | Có bucket private Standard, token đúng quyền, CORS/lifecycle và biến môi trường cục bộ |
| G2 | Tích hợp R2 SDK và kiểm tra kết nối | Hoàn thành cục bộ | Put/Head/Get/Delete smoke đạt, không lộ secret |
| G3 | Mở rộng schema và vòng đời source | Hoàn thành code + dry-run | Job uploading không bị worker claim; object/job idempotent |
| G4 | API chuẩn bị/xác nhận batch và presigned URL | Hoàn thành code + smoke | 200 URL được tạo, object được HEAD xác nhận trước khi pending |
| G5 | Frontend Cloud Uploader | Hoàn thành code + mock | Upload song song toàn batch; chỉ báo có thể tắt máy sau cloud confirmation |
| G6 | Worker tải source từ R2 và phục hồi restart | Hoàn thành code + test | Restart làm worker tải lại từ R2, không còn `FILE_MISSING` do disk Render |
| G7 | Xóa, hủy, retry và garbage collection | Hoàn thành code + reconciliation | Không có object R2 mồ côi ngoài retention window |
| G8 | UX, realtime và quan sát vận hành | Hoàn thành cục bộ | UI phân biệt upload cloud/dịch; reconnect resync đúng |
| G9 | Test tải, lỗi và hiệu năng | Chưa làm | Batch 200 file mock đạt; batch production đại diện đạt |
| G10 | Migration, deploy và theo dõi production | Chưa làm | Có thể tắt client sau upload; toàn batch vẫn hoàn thành |

---

## G1 — Đăng ký và cấu hình Cloudflare R2

Mục tiêu: chủ dự án tạo tài nguyên R2 và đặt đủ cấu hình để Codex có thể triển khai/tích hợp mà không ghi secret vào Git, Markdown hoặc hội thoại.

Tài liệu chính thức:

- Bắt đầu với R2: <https://developers.cloudflare.com/r2/get-started/>
- R2 qua S3 API: <https://developers.cloudflare.com/r2/get-started/s3/>
- Tạo API credentials: <https://developers.cloudflare.com/r2/api/tokens/>
- CORS cho browser upload: <https://developers.cloudflare.com/r2/buckets/cors/>
- Object lifecycle: <https://developers.cloudflare.com/r2/buckets/object-lifecycles/>
- Pricing/free tier: <https://developers.cloudflare.com/r2/pricing/>

### P002-G1-S01 — Tạo/đăng nhập Cloudflare và kích hoạt R2

1. Mở <https://dash.cloudflare.com/sign-up> để tạo tài khoản mới, hoặc đăng nhập tài khoản hiện có.
2. Trong Dashboard chọn **Storage & databases → R2 → Overview**.
3. Hoàn tất checkout/kích hoạt R2. R2 có free tier nhưng là sản phẩm usage-based; Cloudflare có thể yêu cầu phương thức thanh toán.
4. Không cần mua domain, Workers Paid, Pro plan hoặc dịch vụ khác.
5. Sau khi kích hoạt, xác nhận trang R2 Overview mở được.

**Bằng chứng cần ghi:** ngày kích hoạt và xác nhận R2 Overview hoạt động; không chụp/gửi số thẻ hoặc thông tin thanh toán.

### P002-G1-S02 — Tạo bucket nguồn tạm

1. Tại **R2 Overview**, chọn **Create bucket**.
2. Tên đề xuất: `tranmed-pdf-staging`.
3. Location: để **Automatic** nếu không có lý do chọn khu vực khác.
4. Default storage class: chọn **Standard**.
5. Tạo bucket.
6. Trong Settings, xác nhận public development URL (`r2.dev`) đang tắt và không gắn custom public domain.

Tên bucket chỉ dùng chữ thường, số và dấu gạch ngang. Nếu tên đề xuất đã tồn tại trong account, dùng tên khác và ghi lại chính xác.

**Bằng chứng cần ghi:** `R2_BUCKET_NAME`, storage class `Standard`, bucket private.

### P002-G1-S03 — Tạo R2 API token giới hạn đúng bucket

1. Từ R2 Overview, ở **Account Details → API Tokens**, chọn **Manage**.
2. Chọn **Create Account API token**.
3. Tên đề xuất: `tranmed-render-r2`.
4. Permission: **Object Read & Write**.
5. Scope: **Apply to specific buckets only**.
6. Chọn duy nhất bucket `tranmed-pdf-staging` hoặc tên thực tế ở S02.
7. Tạo token.
8. Sao chép ngay hai giá trị vì Secret Access Key chỉ hiển thị một lần:
   - `Access Key ID`.
   - `Secret Access Key`.
9. Ghi lại `Account ID` và `S3 API endpoint`, dạng mặc định:

```text
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

Không tạo token có quyền quản trị toàn account nếu UI cho phép giới hạn bucket.

### P002-G1-S04 — Đặt thông tin R2 vào môi trường local an toàn

Chủ dự án mở file đã được Git ignore:

```text
med-translator-backend/.env
```

Thêm các biến sau bằng giá trị thật:

```dotenv
R2_ACCOUNT_ID=account_id_thật
R2_ACCESS_KEY_ID=access_key_id_thật
R2_SECRET_ACCESS_KEY=secret_access_key_thật
R2_BUCKET_NAME=tranmed-pdf-staging
R2_ENDPOINT=https://account_id_thật.r2.cloudflarestorage.com
R2_REGION=auto
R2_PRESIGNED_URL_TTL_SECONDS=1800
R2_UPLOAD_CONCURRENCY=4
R2_SOURCE_RETENTION_DAYS=3
```

Quy tắc bàn giao:

- **Không** dán `R2_SECRET_ACCESS_KEY` vào chat, `project 002.md`, issue, log hoặc commit.
- **Không** đặt credentials trong `VITE_*`; mọi biến `VITE_*` có thể bị đóng gói vào frontend công khai.
- Codex chỉ cần chủ dự án báo “đã đặt đủ biến R2 trong backend `.env`”. Khi cần kiểm tra, lệnh/script phải chỉ in trạng thái thành công hoặc fingerprint che bớt, không in secret.
- Các giá trị không bí mật có thể báo trực tiếp: bucket name, Account ID, endpoint, region.
- Nếu secret từng bị dán vào nơi công khai, revoke token và tạo token mới trước khi tiếp tục.

### P002-G1-S05 — Cấu hình CORS cho upload từ trình duyệt

1. Mở bucket → **Settings → CORS Policy → Add CORS policy**.
2. Dán cấu hình sau:

```json
[
  {
    "AllowedOrigins": [
      "https://med-translator-frontend.vercel.app",
      "http://localhost:5173"
    ],
    "AllowedMethods": ["PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

3. Chọn Save.
4. Nếu frontend production đổi domain, bổ sung đúng origin đó; không dùng `*` nếu chưa có nhu cầu.
5. Không thêm `GET` công khai cho trình duyệt. Render đọc object bằng S3 credentials ở backend.

**Cổng nhỏ:** CORS Settings hiển thị đúng hai origin và cho `PUT`, `HEAD`.

### P002-G1-S06 — Tạo lifecycle dọn object mồ côi

1. Mở bucket → **Settings → Object Lifecycle Rules → Add rule**.
2. Tên rule đề xuất: `delete-stale-incoming-after-3-days`.
3. Scope/prefix: `incoming/`.
4. Action: expire/delete object sau **3 ngày**.
5. Không tạo rule chuyển sang Infrequent Access.
6. Lưu rule.

Lifecycle là lớp phòng vệ; code vẫn phải xóa object ngay khi job kết thúc. Cloudflare có thể thực hiện lifecycle deletion trễ tới khoảng 24 giờ sau mốc expiration.

### P002-G1-S07 — Thiết lập theo dõi chi phí

1. Mở **Billing → Billable Usage/Budget Alerts** nếu tài khoản hiển thị mục này.
2. Tạo budget alert nhỏ, đề xuất **1 USD**, gửi về email của chủ dự án.
3. Ghi nhớ free tier R2 Standard hiện gồm 10 GB-month, 1 triệu Class A, 10 triệu Class B và egress trực tiếp miễn phí.
4. Không coi budget alert là hard spending cap; vẫn kiểm tra dashboard sau batch production đầu tiên.

### P002-G1-S08 — Checklist bàn giao cho Codex

Chủ dự án chỉ cần trả lời các mục sau; không gửi Secret Access Key:

```text
[x] R2 đã kích hoạt
[x] Bucket name: tranmed-pdf-staging
[x] Account ID và S3 endpoint đã được xác định và đặt trong backend .env
[x] Storage class: Standard
[x] Bucket public access: Off
[x] Token scope: Object Read & Write, chỉ bucket trên
[x] CORS đã lưu với domain Vercel + localhost
[x] Lifecycle incoming/ = 3 ngày
[x] Các biến R2 thật đã được đặt trong med-translator-backend/.env
[x] Budget alert đã bật
[x] Token R2 đã được revoke/rotate sau khi credential cũ bị dán vào hội thoại; .env đã cập nhật key mới
```

**Cổng G1:** đạt ngày 15-07-2026. Credential cũ đã được revoke/rotate, backend `.env` đã cập nhật và key mới không được đưa vào hội thoại/tài liệu.

---

## G2 — Tích hợp R2 SDK và kiểm tra kết nối

Mục tiêu: tạo lớp truy cập R2 độc lập, fail-fast đúng cấu hình và có smoke test không làm rò rỉ secret.

- [x] **P002-G2-S01 — Bảo toàn worktree và baseline.** Ghi `git status`, branch/commit hiện tại, test/lint/build/audit trước P002; không đụng ba deletion có sẵn ở root.
- [x] **P002-G2-S02 — Tạo nhánh P002.** Tạo nhánh riêng từ commit production đã chốt sau P001; ghi rollback commit/tag.
- [x] **P002-G2-S03 — Dependency S3-compatible.** Thêm các package tối thiểu cần thiết, dự kiến `@aws-sdk/client-s3` và `@aws-sdk/s3-request-presigner`; chạy audit và review lockfile.
- [x] **P002-G2-S04 — Mở rộng env validation.** Bổ sung toàn bộ biến R2; startup phải dừng với thông báo tên biến còn thiếu nhưng không in giá trị.
- [x] **P002-G2-S05 — Tạo `r2Service`.** Khởi tạo S3 client với endpoint R2, region `auto`, credentials backend; cung cấp `put/head/get/delete/createPresignedPut` qua interface nhỏ có thể mock.
- [x] **P002-G2-S06 — Stream thay vì buffer toàn bộ.** Hàm download phải stream object ra file tạm, không giữ PDF 30–350 MB trong một Buffer lớn.
- [x] **P002-G2-S07 — Smoke script.** Tạo object nhỏ dưới prefix `smoke/`, HEAD, GET kiểm tra nội dung rồi DELETE trong `finally`.
- [x] **P002-G2-S08 — Redaction log.** Test rằng error/log không chứa Access Key ID đầy đủ, Secret, presigned query hoặc Mongo URI.
- [x] **P002-G2-S09 — Health/readiness.** Thêm kiểm tra storage riêng hoặc startup probe hợp lý; `/api/health` không được tạo object mới mỗi 5 phút.

**Cổng G2:** smoke Put/Head/Get/Delete đạt local; bucket trở lại rỗng; test/audit nền vẫn sạch; không có secret trong stdout hoặc Git diff.

## G3 — Schema upload bền vững và vòng đời source

Mục tiêu: biểu diễn rõ file đang upload lên R2, đã sẵn sàng cho worker và đã được xóa.

- [x] **P002-G3-S01 — Thêm trạng thái job `uploading`.** Worker tuyệt đối không claim job này.
- [x] **P002-G3-S02 — Thêm metadata R2 vào Job.** Tối thiểu: `storageProvider`, `storageKey`, `sourceSize`, `sourceEtag`, `sourceState`, `uploadBatchId`, `uploadConfirmedAt`, `sourceDeletedAt`.
- [x] **P002-G3-S03 — Giữ tương thích P001.** Job cũ có `filePath` nhưng không có `storageKey` vẫn xử lý/hiển thị được trong thời gian chuyển tiếp.
- [x] **P002-G3-S04 — Object key không dùng tên file.** Dùng `incoming/<batchId>/<jobId>.pdf`; tên gốc chỉ nằm trong MongoDB để tránh collision/ký tự đường dẫn.
- [x] **P002-G3-S05 — UploadBatch model.** Lưu batch ID, folder name, tổng file/byte, số confirmed/failed, timestamps và trạng thái tổng; không nhúng byte hoặc presigned URL.
- [x] **P002-G3-S06 — Unique/idempotency.** Unique `jobId`, `clientUploadId`, `storageKey`; prepare/confirm gọi lại không tạo job hoặc object key mới.
- [x] **P002-G3-S07 — Index.** Index cho `status=uploading`, batch lookup, source cleanup và reconcile object chưa confirm.
- [x] **P002-G3-S08 — Migration idempotent.** Script dry-run/report và migration additive; không bắt job cũ phải có trường R2.
- [x] **P002-G3-S09 — Invariant tests.** `uploading` không claim; `pending` R2 phải có `sourceState=ready`; terminal state không được đánh dấu source deleted giả khi DELETE chưa thành công.

**Cổng G3:** schema mới/cũ cùng đọc được; migration chạy lần hai không mutate thêm; queue không claim file chưa upload xong.

## G4 — API chuẩn bị và xác nhận upload trực tiếp

Mục tiêu: frontend nhận URL tạm, upload thẳng lên R2 và backend chỉ đưa job vào queue sau khi xác minh object.

- [x] **P002-G4-S01 — `POST /upload-batches/prepare`.** Nhận manifest gồm folder và danh sách `{clientUploadId, name, size, type}`; không nhận byte PDF.
- [x] **P002-G4-S02 — Validation manifest.** Mặc định tối đa 500 file/batch, size từng file không vượt giới hạn cấu hình, tổng byte có giới hạn hợp lý, MIME/extension PDF và tên folder được chuẩn hóa.
- [x] **P002-G4-S03 — Presigned PUT.** URL hết hạn mặc định 30 phút, khóa đúng object key và `Content-Type: application/pdf`; response không bao gồm credentials.
- [x] **P002-G4-S04 — Response phân trang/chunk nếu cần.** 500 presigned URL phải nằm dưới Express response limit và không gây timeout; nếu quá lớn, cấp URL theo cửa sổ.
- [x] **P002-G4-S05 — `POST /upload-batches/:batchId/confirm`.** Nhận danh sách item đã PUT; backend gọi HEAD và kiểm tra object tồn tại, size khớp, ETag hợp lệ trước khi atomically chuyển `uploading -> pending`.
- [x] **P002-G4-S06 — Confirm idempotent.** Gọi lại sau mất mạng trả cùng trạng thái, không tăng count hai lần và không tạo job trùng.
- [x] **P002-G4-S07 — Reconciler.** Nếu browser PUT thành công nhưng request confirm bị mất, backend định kỳ HEAD job `uploading` và tự promote object hợp lệ.
- [x] **P002-G4-S08 — API trạng thái batch.** Trả `totalFiles`, `uploadedFiles`, `confirmedFiles`, `failedFiles`, `totalBytes`, `confirmedBytes`, `canCloseClient`.
- [x] **P002-G4-S09 — Capacity API mới.** Phân biệt `r2UploadAvailable` và `renderWorkerDiskAvailable`; không chặn R2 upload chỉ vì Render đang dịch file khác.
- [x] **P002-G4-S10 — Giới hạn tài nguyên không đăng nhập.** Giữ rate limit/batch-size/file-size để tránh request lỗi; không thêm login, password hoặc upload secret.
- [x] **P002-G4-S11 — Test presigned URL.** Kiểm tra đúng method/key/expiry/content type; URL hết hạn hoặc sửa key phải thất bại.

**Cổng G4:** mock batch 200 file tạo đúng 200 job/object key; chỉ object HEAD hợp lệ mới chuyển pending; không có PDF đi qua Render upload middleware.

## G5 — Frontend Cloud Uploader

Mục tiêu: tải nhanh toàn batch lên R2 và đưa ra tín hiệu “có thể tắt máy” chính xác.

- [x] **P002-G5-S01 — Thay Local Feeder theo translation.** Không còn chờ job trước completed mới upload file sau.
- [x] **P002-G5-S02 — Prepare manifest.** Gửi metadata toàn batch, nhận job IDs và presigned URLs.
- [x] **P002-G5-S03 — Upload pool.** Upload trực tiếp tối đa 4 file đồng thời; concurrency cấu hình được và không tạo 200 request đồng thời.
- [x] **P002-G5-S04 — Progress theo byte.** Hiển thị tổng MB, MB đã upload, phần trăm tổng và số file confirmed; không chỉ đếm file.
- [x] **P002-G5-S05 — Retry upload.** Retry network/5xx có backoff; 4xx signature expired phải xin URL mới đúng object key; không upload trùng job.
- [x] **P002-G5-S06 — Confirm theo lô nhỏ.** Xác nhận ngay các upload thành công và flush phần còn lại; retry confirm độc lập với PUT.
- [x] **P002-G5-S07 — Tín hiệu đóng máy.** Chỉ `canCloseClient=true` khi toàn bộ file mong muốn đã HEAD-confirmed hoặc người dùng chủ động bỏ các file lỗi khỏi batch.
- [x] **P002-G5-S08 — Cảnh báo đóng sớm.** `beforeunload` chỉ bật khi còn file chưa confirmed; tắt ngay khi batch an toàn trên R2, dù dịch chưa xong.
- [x] **P002-G5-S09 — Resync.** F5 sau khi upload xong phải đọc batch/job từ MongoDB và không cần `File` object cũ.
- [x] **P002-G5-S10 — Partial failure UI.** Cho retry file lỗi, bỏ file lỗi khỏi batch hoặc chọn lại đúng file; không gọi batch an toàn khi còn lỗi chưa xử lý.
- [x] **P002-G5-S11 — Không proxy qua Vercel/Render.** Network test phải cho thấy request chứa PDF đi từ browser tới `r2.cloudflarestorage.com`.
- [x] **P002-G5-S12 — Test 200 file.** Mock đủ prepare, PUT pool, confirm, retry và xác nhận concurrency không vượt cấu hình.

**Cổng G5:** 200 file được PUT mà không chờ dịch; UI báo “có thể tắt máy” dựa trên backend confirmation, không dựa trên state cục bộ đơn thuần.

## G6 — Worker tải PDF từ R2 và phục hồi restart

Mục tiêu: worker chỉ cần disk cho một PDF đang xử lý và không phụ thuộc sự sống của instance Render trước đó.

- [x] **P002-G6-S01 — Source resolver.** Với job R2, tải object theo `storageKey`; với job legacy, fallback `filePath`.
- [x] **P002-G6-S02 — Download atomically.** Stream vào file `.part`, kiểm tra đủ byte rồi rename; không xử lý file tải dở.
- [x] **P002-G6-S03 — Validate lại PDF.** Kiểm tra magic bytes/PDF parse sau download; không tin MIME từ browser.
- [x] **P002-G6-S04 — Disk admission.** Trước download kiểm tra `sourceSize` và budget disk; backend vẫn chỉ giữ tối đa số source file theo cấu hình.
- [x] **P002-G6-S05 — Restart recovery.** Lease hết hạn trả job về pending; worker mới xóa `.part` cũ và tải lại từ R2.
- [x] **P002-G6-S06 — Không còn permanent `FILE_MISSING` vì Render.** Mất file local chỉ kích hoạt redownload; chỉ báo source missing nếu R2 HEAD thực sự 404.
- [x] **P002-G6-S07 — Resume chunk.** Tận dụng TranslationChunk P001; redownload/retry không dịch lại chunk đã lưu.
- [x] **P002-G6-S08 — Cleanup local.** Xóa file tạm trong `finally` sau success/failure/cancel; startup orphan scan vẫn hoạt động.
- [x] **P002-G6-S09 — R2 timeout/error taxonomy.** Phân biệt auth/config, object missing, rate limit, timeout và unavailable; retry đúng loại, không tăng Gemini circuit breaker.
- [x] **P002-G6-S10 — Streaming/memory test.** File 30 MB và file gần max không tạo Buffer copy toàn file ngoài nhu cầu thư viện PDF.

**Cổng G6:** kill/restart giả lập giữa download và giữa translation vẫn hoàn thành sau khi worker mới tải lại source; tab trình duyệt đã đóng.

## G7 — Hủy, xóa và garbage collection đa tầng

Mục tiêu: MongoDB, R2, disk Render và TranslationChunk có semantics cleanup thống nhất.

- [x] **P002-G7-S01 — Centralize source cleanup.** Mọi đường completed/failed/cancel/delete gọi cùng service, có retry và idempotency.
- [x] **P002-G7-S02 — Completed.** Chỉ sau khi kết quả/chunks đã commit an toàn mới DELETE source R2; lỗi DELETE không đổi completed thành failed nhưng phải xếp cleanup retry.
- [x] **P002-G7-S03 — Retryable failure.** Giữ object R2 trong thời gian retry; không phụ thuộc file local.
- [x] **P002-G7-S04 — Permanent failure.** Xóa object theo policy sau khi lưu error rõ; cân nhắc giữ ngắn hạn nếu cần người dùng retry thủ công trong retention window.
- [x] **P002-G7-S05 — Cancel/delete.** Dừng pipeline, xóa local, chunks theo semantics hiện tại, xóa object R2 và Job/Batch đúng thứ tự phục hồi được.
- [x] **P002-G7-S06 — Uploading orphan.** Job chuẩn bị nhưng chưa PUT phải hết hạn; object PUT nhưng chưa confirm được reconciler phát hiện hoặc lifecycle xóa.
- [x] **P002-G7-S07 — Cleanup retry queue.** Persist số lần/thời điểm thử xóa R2; restart không làm quên object cần xóa.
- [x] **P002-G7-S08 — Batch cleanup.** Batch chỉ terminal khi từng item đã terminal/removed; xóa folder xử lý cả R2 sources.
- [x] **P002-G7-S09 — Lifecycle verification.** Xác nhận rule `incoming/` 3 ngày tồn tại ở production và ghi cảnh báo nếu bị tắt.
- [x] **P002-G7-S10 — Reconciliation report.** Script read-only báo số job thiếu object, object tham chiếu, object orphan và tổng byte; không tự xóa trong dry-run.

**Cổng G7:** sau ma trận cancel/error/delete, số object R2, file disk, Job và chunk khớp; không có orphan vượt retention window.

## G8 — UX, realtime và quan sát vận hành

Mục tiêu: người dùng biết chính xác dữ liệu còn trên máy, đã lên cloud hay đang được dịch.

- [x] **P002-G8-S01 — Tách ba progress.** `Đang upload lên R2`, `Đã an toàn trên Cloud`, `Render đang dịch`; không gộp thành một trạng thái mơ hồ.
- [x] **P002-G8-S02 — Banner đóng máy.** Hiển thị nổi bật thời điểm batch có thể đóng tab; giải thích việc dịch tiếp tục trên Render.
- [x] **P002-G8-S03 — Batch dashboard.** Tổng/confirmed/pending/processing/completed/failed và byte upload.
- [x] **P002-G8-S04 — SSE event mới.** Batch/item upload confirmation và source cleanup; parse/reconnect/resync như P001.
- [x] **P002-G8-S05 — R2 system status.** Hiển thị storage configured/available bằng boolean và thông báo công khai; không trả bucket credential/presigned URL cũ.
- [x] **P002-G8-S06 — Log correlation.** `batchId`, `jobId`, `storageKey` dạng an toàn, attempt và latency; không log query signature.
- [x] **P002-G8-S07 — Metrics.** Upload prepare/confirm error, R2 HEAD/GET/DELETE error, download byte/time, cleanup backlog và object missing.
- [x] **P002-G8-S08 — Filename/folder.** Unicode, `#`, `%`, trùng tên và nhiều folder không ảnh hưởng object key hoặc download output.
- [x] **P002-G8-S09 — Accessibility/responsive.** Progress và thông báo quan trọng đọc được bằng keyboard/screen reader và trên mobile.

**Cổng G8:** đóng/reopen trang sau `canCloseClient=true` vẫn thấy đúng batch; trạng thái R2/worker không lộ secret.

## G9 — Test tải, lỗi và hiệu năng

Mục tiêu: chứng minh tính đúng đắn trước production và đo liệu mục tiêu 5 phút có đạt với mạng thực tế.

- [ ] **P002-G9-S01 — Unit test R2 service.** Presign, HEAD verify, stream download, delete idempotent, error mapping.
- [ ] **P002-G9-S02 — Integration mock S3.** Prepare → PUT → confirm → pending → download → completed → delete.
- [ ] **P002-G9-S03 — Frontend 200 file.** Concurrency=4, retry, expired URL, partial confirm, tổng byte và `canCloseClient`.
- [ ] **P002-G9-S04 — Duplicate/reconnect.** Double-click prepare, confirm lặp, SSE mất, F5 và retry không tạo job/object trùng.
- [ ] **P002-G9-S05 — Restart matrix.** Restart trước confirm, sau confirm, đang download, đang Gemini, đang cleanup.
- [ ] **P002-G9-S06 — Failure matrix.** R2 403/404/429/5xx/timeout, MongoDB lỗi, disk đầy, PDF hỏng, Gemini quota/config/unavailable.
- [ ] **P002-G9-S07 — Cleanup matrix.** Completed, permanent failed, retry waiting, cancel, delete folder, upload abandon và lifecycle.
- [ ] **P002-G9-S08 — Peak RAM/disk.** File 1 MB, 3 MB, 30 MB và gần max config; ghi số liệu thực.
- [ ] **P002-G9-S09 — Upload benchmark.** Batch đại diện 50 và 200 file; ghi tổng byte, tốc độ mạng, thời gian PUT, thời gian confirm và số retry.
- [ ] **P002-G9-S10 — Security regression tối thiểu.** Bucket private, credentials không ở bundle/log/API; không thêm authentication theo quyết định phạm vi.
- [ ] **P002-G9-S11 — Full regression P001.** Backend/frontend test, lint, build, audit, legacy result, cancellation và chunk resume đều đạt.

**Cổng G9:** test tự động sạch; batch 200 mock đạt; benchmark chỉ kết luận “dưới 5 phút” khi tổng byte/tốc độ mạng thực sự đạt, không hứa theo số file đơn thuần.

## G10 — Migration, triển khai và theo dõi production

Mục tiêu: rollout không làm mất job/kết quả hiện có và xác nhận đúng kịch bản tắt máy.

- [ ] **P002-G10-S01 — Backup/dry-run.** Đếm dữ liệu MongoDB; backup nếu có dữ liệu cần giữ; migration dry-run và report.
- [ ] **P002-G10-S02 — Đặt Render env.** Thêm biến R2 vào Render Environment, không ghi vào Blueprint/repo nếu file đó public; xác nhận secret masking.
- [ ] **P002-G10-S03 — Deploy backend tương thích trước.** API cũ và mới cùng hoạt động; smoke health/R2 readiness.
- [ ] **P002-G10-S04 — Chạy migration production.** Idempotent, verify index/schema và không claim job uploading.
- [ ] **P002-G10-S05 — Smoke một PDF R2.** Browser PUT → confirm → worker GET → completed → source R2 deleted.
- [ ] **P002-G10-S06 — Deploy frontend.** Xác nhận bundle có Cloud Uploader và không chứa R2 credentials.
- [ ] **P002-G10-S07 — Batch 5 file.** Upload xong, đóng tab, đợi hoàn thành; kiểm tra object/disk/chunk.
- [ ] **P002-G10-S08 — Batch 50 file.** Đo upload/confirm, đóng máy hoặc ngắt client sau banner an toàn, xác nhận toàn batch tiếp tục.
- [ ] **P002-G10-S09 — Batch 200 file đại diện.** Chỉ thực hiện khi quota Gemini/thời gian cho phép; đo tốc độ, restart recovery và cleanup.
- [ ] **P002-G10-S10 — Render restart thật có kiểm soát.** Khi còn source R2, restart/deploy backend; job phải redownload và hoàn thành.
- [ ] **P002-G10-S11 — Theo dõi 24 giờ.** R2 objects/bytes, cleanup backlog, Render RAM/disk/restart, Mongo jobs/chunks, Gemini calls/retry và UI resync.
- [ ] **P002-G10-S12 — Đóng dự án.** Chỉ hoàn thành khi tiêu chí mục 12 đều đạt và tài liệu vận hành đã cập nhật.

**Cổng G10:** sau khi UI xác nhận toàn batch đã an toàn và client bị tắt, Render vẫn dịch hết; restart không mất nguồn; R2 trở lại gần rỗng sau terminal cleanup.

## 6. Ma trận kiểm thử bắt buộc

| ID | Tình huống | Kết quả mong đợi | Trạng thái |
| --- | --- | --- | --- |
| T01 | Prepare 200 PDF hợp lệ | 200 job uploading + 200 key duy nhất, chưa job nào được claim | Chưa chạy |
| T02 | Upload trực tiếp concurrency 4 | Không quá 4 PUT đang bay; Render không nhận byte PDF | Chưa chạy |
| T03 | Tất cả PUT + confirm thành công | Batch `canCloseClient=true`, jobs pending | Chưa chạy |
| T04 | Đóng tab sau canCloseClient | Worker tiếp tục hết batch | Chưa chạy |
| T05 | Đóng tab trước upload xong | Có cảnh báo; file chưa PUT không bị báo an toàn | Chưa chạy |
| T06 | PUT thành công nhưng mất confirm response | Reconciler HEAD và promote đúng job | Chưa chạy |
| T07 | Presigned URL hết hạn | Frontend xin URL mới cùng key, không tạo job trùng | Chưa chạy |
| T08 | Confirm gọi hai lần | Count/job không tăng trùng | Chưa chạy |
| T09 | Render restart đang download | File `.part` dọn; tải lại từ R2 | Chưa chạy |
| T10 | Render restart đang dịch | Lease/chunk resume; source vẫn còn R2 | Chưa chạy |
| T11 | Local file Render mất | Redownload; không permanent `FILE_MISSING` | Chưa chạy |
| T12 | R2 object thực sự mất | Typed error rõ, không retry vô hạn/Gemini circuit | Chưa chạy |
| T13 | R2 403 credentials sai | Fail-fast/config error, không log secret | Chưa chạy |
| T14 | R2 429/5xx/timeout | Backoff giới hạn, không dịch trùng | Chưa chạy |
| T15 | PDF hỏng | Permanent failed, source cleanup đúng policy | Chưa chạy |
| T16 | Gemini 429/503 | Source R2 được giữ qua retry, chunk resume | Chưa chạy |
| T17 | Cancel pending/processing | Dừng pipeline, local/R2/chunk/job sạch đúng semantics | Chưa chạy |
| T18 | Xóa folder hỗn hợp | Không object/job/chunk mồ côi | Chưa chạy |
| T19 | Hai file trùng tên/Unicode | Hai key UUID riêng; output không ghi đè | Chưa chạy |
| T20 | File 30 MB | Upload/stream/dịch thành công trong memory budget | Chưa chạy |
| T21 | Batch tổng gần giới hạn | Prepare từ chối rõ hoặc upload đúng policy | Chưa chạy |
| T22 | Lifecycle orphan 3 ngày | Object mồ côi được Cloudflare xóa | Chưa chạy/thời gian dài |
| T23 | F5 sau upload hoàn tất | Resync từ MongoDB, không cần File local | Chưa chạy |
| T24 | Frontend bundle production | Không có Access Key/Secret/presigned URL tĩnh | Chưa chạy |
| T25 | Job P001 legacy | Vẫn preview/download/delete và xử lý theo đường tương thích | Chưa chạy |

## 7. Bản đồ file dự kiến tác động

| File/khu vực | Thay đổi dự kiến |
| --- | --- |
| `med-translator-backend/package.json` | AWS S3-compatible SDK/presigner và scripts smoke |
| `backend/src/config/env.js` | Validate biến R2/upload concurrency/retention |
| `backend/src/services/r2Service.js` | Presign, HeadObject, GetObject stream, DeleteObject |
| `backend/src/services/sourceService.js` | Resolve legacy/R2 source, download atomically và cleanup |
| `backend/src/models/jobModel.js` | uploading/source metadata/batch fields/index |
| `backend/src/models/uploadBatchModel.js` | Batch progress và canCloseClient |
| `backend/src/services/queueManager.js` | Claim chỉ source ready; redownload/retry/restart/cleanup |
| `backend/src/controllers/translateController.js` | Prepare/confirm/batch status/capacity mới |
| `backend/src/routes/translateRoute.js` | Route upload batch; giữ route cũ khi tương thích |
| `backend/src/services/storageService.js` | Disk budget chỉ áp dụng source đang worker download |
| `backend/scripts/*` | R2 smoke, migration và reconciliation report |
| `frontend/src/api/client.js` | API batch/presigned URL không làm lộ credentials |
| `frontend/src/App.jsx` | Thay Local Feeder bằng Cloud Uploader và trạng thái đóng máy |
| `frontend/src/components/*` | Batch uploader/progress/status banner nếu tách component |
| `frontend/src/App.test.jsx` | 200 file, concurrency, retry, confirm và close-safe |
| `.env.example`, README, knowledge docs | Biến R2, setup/rotation/rollback/vận hành |

Trong bảng, `backend/` và `frontend/` là tên viết gọn cho hai thư mục thực tế.

## 8. Chiến lược commit và rollback

- Mỗi commit có mã bước, ví dụ `feat(P002-G4-S03): issue scoped R2 upload URLs`.
- Backend/schema additive được deploy trước frontend.
- Không xóa route upload P001 cho đến khi production R2 batch đạt.
- Không xóa `filePath`/legacy result trong P002.
- Trước deploy ghi commit/tag rollback và export cấu hình R2 không chứa secret.
- Nếu backend R2 lỗi trước khi frontend deploy: rollback backend, không ảnh hưởng frontend P001.
- Nếu frontend uploader lỗi: rollback frontend; backend mới vẫn phục vụ đường cũ.
- Nếu cần rollback sau khi object đã upload R2: không xóa bucket/token ngay; giữ object trong retention window để tránh mất nguồn.
- Revoke/rotate R2 token chỉ sau khi instance backend cũ không còn chạy.
- Không dùng `git reset --hard`, không xóa database/bucket hàng loạt để rollback.

## 9. Bằng chứng kiểm thử

| Thời gian | Giai đoạn/bước | Lệnh/phép đo | Kết quả | Log/artifact |
| --- | --- | --- | --- | --- |
| 15-07-2026 | G1 / P002-G1-S08 | Đối chiếu checklist và kiểm tra trạng thái biến môi trường không in giá trị | Bucket/cấu hình local đầy đủ; `.env` được Git ignore; chờ rotate credential đã lộ | Không lưu secret |
| 15-07-2026 | G1 / credential rotation | Chủ dự án xác nhận revoke/rotate token và cập nhật backend `.env`; kiểm tra 9/9 biến ở trạng thái SET, không đọc/in giá trị | Đạt cổng G1 | Không lưu secret |
| 15-07-2026 | G2 / baseline | Backend test; frontend test/lint/build; audit hai package | Backend 14/14, frontend 3/3, lint/build đạt, audit 0 trước thay đổi | stdout phiên local |
| 15-07-2026 | G2 / SDK + service | `npm test`, `npm audit --audit-level=high` | Backend 18/18; service mock kiểm tra presign/head/get/delete/readiness/stream; audit 0 | stdout phiên local |
| 15-07-2026 | G2 / R2 smoke | `npm run smoke:r2` và readiness check | PUT/HEAD/GET/DELETE đạt; cleanup đạt; HeadBucket readiness đạt | stdout đã redaction, không có URL/key |
| 15-07-2026 | G2 / regression + secret scan | Frontend test/lint/build/audit; `git diff --check`; đối chiếu credential local với file repo chỉ trả pass/fail | Tất cả đạt; không phát hiện R2/Mongo credential trong repo | Không in secret |
| 15-07-2026 | G3 / schema + invariant | `npm test` | Backend 25/25; legacy/R2 coexist, claim gate, source deletion, key, batch và index đạt | stdout phiên local |
| 15-07-2026 | G3 / migration dry-run | `npm run migrate:p002:dry` | 5 Job legacy được nhận diện; 0 R2 Job/UploadBatch; `modifiedCount=0`, không tạo index | stdout không chứa URI |
| 15-07-2026 | G4 / API service mock | `npm test` | Mock prepare 200 file tạo 200 key ổn định; prepare/confirm lặp idempotent; HEAD size/ETag trước pending | stdout phiên local |
| 15-07-2026 | G4 / presigned production smoke | `npm run smoke:r2-presign` | Sai Content-Type bị từ chối; PUT đúng + HEAD đạt; URL hết hạn bị từ chối; cleanup đạt | Không in URL ký/key |
| 15-07-2026 | G5 / Cloud Uploader 200 file | Frontend Vitest | 200 PUT mock, peak concurrency ≤4, retry 503/403, confirm chunk ≤10, 200 ID duy nhất | Không gọi Render với PDF body |
| 15-07-2026 | G5 / close-safe + resync | React Testing Library | `beforeunload` bật trước confirm, tắt sau `canCloseClient`; batch ready phục hồi từ Mongo không cần File | Frontend 8/8, lint/build đạt |
| 15-07-2026 | G5 / partial failure | Backend + frontend test | Retry giữ nguyên client IDs; abandon chỉ close-safe sau DELETE R2 và `confirmed + skipped = total` | Backend 29/29 |
| 15-07-2026 | G6 / R2 source resolver | Backend Node test | Stream PDF 30 MB qua `.part`, đủ byte + magic rồi rename; cleanup file/part; legacy path giữ nguyên | Backend 32/32 trước final gate |
| 15-07-2026 | G6 / missing/restart | SourceService + queue regression | `.part` cũ bị dọn trước disk admission; R2 404 thành `R2_SOURCE_MISSING`; R2 job không phụ thuộc `filePath` | Không tăng Gemini quota breaker |
| 15-07-2026 | G7 / cleanup matrix | Backend Node test | DELETE-before-mark, retry redaction/persistence, restart sweeper, abandon và stale upload expiry | Backend 36/36, audit 0 |
| 15-07-2026 | G7 / reconciliation | `npm run reconcile:r2` | 0 R2 job, 0 object, 0 missing, 0 orphan, 0 byte; read-only | Không DELETE/UPDATE |
| 15-07-2026 | G7 / lifecycle | Dashboard G1 + S3 read attempt | Rule `incoming/` 3 ngày đã được chủ dự án xác nhận ở G1; Object Read/Write token trả AccessDenied khi đọc bucket lifecycle | Giữ least-privilege, script cảnh báo nếu không xác minh API được |
| 15-07-2026 | G8 / realtime + resync | Backend Node test + React Testing Library | SSE phát batch/source cleanup; reconnect đọc lại status/jobs/batches từ Mongo; batch close-safe cập nhật realtime | Backend 37/37, frontend 9/9 |
| 15-07-2026 | G8 / UX + observability | Frontend lint/build; metrics unit test; review response/log | Dashboard ba giai đoạn responsive; R2 status/backlog và metrics tổng hợp không chứa credential/presigned URL | Lint/build đạt; diff/secret scan sạch |

## 10. Nhật ký thay đổi

| Thời gian | Mã bước | Commit/PR | Nội dung | Người thực hiện | Kết quả |
| --- | --- | --- | --- | --- | --- |
| 15-07-2026 | P002-PLAN | Chưa commit | Lập kế hoạch upload bền vững qua Cloudflare R2 | Codex | Hoàn thành tài liệu; chờ G1 |
| 15-07-2026 | P002-G1-S08 | Chưa commit | Ghi nhận cấu hình R2, hoàn thiện `R2_ACCOUNT_ID` trong backend `.env` và kiểm tra không lộ giá trị | Codex | Chờ rotate credential trước G2 |
| 15-07-2026 | P002-G2-S01..S09 | `1309036` | Thêm AWS SDK, env fail-fast, `r2Service`, streaming download, smoke, redaction và readiness; rollback `ae14db7` | Codex | Hoàn thành cục bộ, smoke thật đạt |
| 15-07-2026 | P002-G3-S01..S09 | `1309036` | Schema Job additive, UploadBatch, source key, claim invariant, index và migration P002 dry-run/idempotent | Codex | Hoàn thành code; production migration để G10 |
| 15-07-2026 | P002-G4-S01..S11 | `6b8a7af` | API prepare/confirm/status, manifest limits, scoped presign, reconciler, capacity split và mock 200 file | Codex | Hoàn thành code + smoke thật |
| 15-07-2026 | P002-G5-S01..S12 | `0a42f5d` | Cloud upload pool, byte progress, retry/refresh URL, chunk confirm, close-safe banner, resync và abandon file lỗi | Codex | Hoàn thành code + mock 200 file |
| 15-07-2026 | P002-G6-S01..S10 | `1b74665` | Source resolver legacy/R2, atomic stream, byte/magic validation, disk admission, local cleanup và error taxonomy | Codex | Hoàn thành code + test 30 MB |
| 15-07-2026 | P002-G7-S01..S10 | `5b6ed9f` | Source cleanup tập trung, persistent retry sweeper, orphan expiry, batch cleanup và reconciliation report | Codex | Hoàn thành code; bucket hiện sạch |
| 15-07-2026 | P002-G8-S01..S09 | Checkpoint G8 (commit này) | Dashboard ba giai đoạn, R2 status/metrics, SSE batch/cleanup, correlation log và reconnect resync Mongo | Codex | Hoàn thành cục bộ; test/lint/build đạt |

## 11. Nhật ký vấn đề và quyết định

| ID | Ngày | Vấn đề/quyết định | Ảnh hưởng | Hướng xử lý | Trạng thái |
| --- | --- | --- | --- | --- | --- |
| D001 | 15-07-2026 | Local Feeder P001 phụ thuộc tab và đợi dịch từng file | Không đáp ứng upload nhanh rồi tắt máy | Upload toàn batch trực tiếp lên R2 trước khi dịch | Đã chốt |
| D002 | 15-07-2026 | Chủ dự án không muốn bất kỳ đăng nhập/mật khẩu/UPLOAD_SECRET nào | Endpoint ứng dụng vẫn công khai; rủi ro request ngoài ý muốn được chấp nhận | Không triển khai auth; chỉ giữ validation/rate/resource limits | Đã chốt |
| D003 | 15-07-2026 | Render filesystem ephemeral | Source local có thể mất khi restart/spin-down/deploy | R2 là source bền vững; Render chỉ giữ bản tạm đang xử lý | Đã chốt |
| D004 | 15-07-2026 | PDF chủ yếu 1–3 MB, đôi khi 30 MB; 50–200+ file/batch | Tổng thường khoảng 50–750 MB/batch | R2 Standard + direct PUT concurrency 4 | Đã chốt |
| D005 | 15-07-2026 | Secret cần cho tích hợp nhưng không được đưa vào Git/chat | Codex cần kiểm tra mà không làm lộ key | Chủ dự án đặt secret trong backend `.env` và Render Environment; chỉ báo xác nhận | Đã chốt |
| D006 | 15-07-2026 | R2 là usage-based dù có free tier | Có khả năng phát sinh phí khi vượt quota | Xóa sớm, lifecycle 3 ngày, budget alert và theo dõi usage | Đã chốt |
| D007 | 15-07-2026 | R2 Access Key, Secret Access Key và token value đã bị dán vào hội thoại | Credential cũ không còn an toàn để dùng smoke test hay deploy | Đã revoke/rotate token R2 và cập nhật backend `.env`; Render Environment sẽ dùng key mới ở G10; không ghi/dán key mới vào tài liệu hoặc hội thoại | Đã xử lý cục bộ |

## 12. Điều kiện hoàn thành PROJECT 002

PROJECT 002 chỉ được đóng khi tất cả điều sau đều đúng:

- Chọn batch 200 file không còn chỉ POST file đầu tiên rồi đợi translation.
- Toàn bộ PDF được upload trực tiếp từ browser lên R2 với concurrency giới hạn.
- UI chỉ báo “có thể tắt máy” sau khi backend xác nhận object trên R2.
- Sau khi đóng tab/tắt client, Render vẫn xử lý toàn bộ job confirmed.
- Render restart/redeploy không làm source biến mất và không tạo vòng lặp `FILE_MISSING` local.
- Worker chỉ giữ disk tạm trong budget và không buffer toàn bộ batch.
- Retry Gemini/R2/MongoDB không dịch trùng hoặc tạo job/object trùng.
- Completed/cancelled/permanent-failed dọn R2 theo policy; lifecycle dọn orphan.
- Bucket vẫn private; frontend bundle/API/log không chứa R2 credentials.
- Không có màn hình đăng nhập, mật khẩu hoặc `UPLOAD_SECRET` theo quyết định chủ dự án.
- Job/result P001 legacy vẫn hoạt động trong thời gian tương thích.
- Test backend/frontend, lint, build, audit và migration verification đều đạt.
- Batch production tối thiểu 50 file được upload, client đóng sau confirmation và toàn batch hoàn thành.
- Sau thời gian theo dõi, R2 object count/bytes, Render disk/RAM và MongoDB queue đúng kỳ vọng.
- README/knowledge/runbook mô tả đúng setup, secret rotation, cleanup, rollback và giới hạn free tier.
