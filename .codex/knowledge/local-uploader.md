# Local uploader — upload PDF không cần mở giao diện

## Mục tiêu và phạm vi

Local uploader là công cụ Windows chạy trên laptop của chủ hệ thống. Công cụ quét
một thư mục chờ dịch, ánh xạ mỗi thư mục sách thành một `folderName` của StudyMed,
upload PDF trực tiếp lên Cloudflare R2 qua presigned URL và xác nhận batch với
backend. Nó dùng đúng protocol prepare/PUT/confirm của frontend nhưng không cần mở
frontend hoặc chạy backend local.

Entry point dành cho người dùng là `../../Upload file chờ dịch.bat`. Phần triển khai
nằm tại `../../med-translator-backend/scripts/local-uploader.js`; npm script tương
đương là `npm run upload:staging -- <tham số>`.

Công cụ không tải kết quả dịch, không theo dõi quality pipeline, không xóa PDF
nguồn và không tự dọn job lỗi trên server. Thành công của uploader chỉ có nghĩa là
backend đã trả `canCloseClient=true`; quá trình dịch tiếp tục độc lập trên Render.

## Cấu trúc nguồn bắt buộc

Nguồn mặc định là `D:\1. File chờ dịch` và phải có đúng hình dạng:

```text
D:\1. File chờ dịch\
├─ Tên sách A\
│  └─ Tên thư mục con bất kỳ\
│     ├─ Phần 1.pdf
│     └─ Phần 2.pdf
└─ Tên sách B\
   └─ Split\
      └─ Chương 1.pdf
```

- Cấp nguồn chỉ chứa các thư mục sách.
- Mỗi thư mục sách có đúng một thư mục con; tên thư mục con không được dùng làm
  nhóm và có thể thay đổi tùy sách.
- PDF phải nằm trực tiếp trong thư mục con. Không chấp nhận tầng sâu hơn,
  junction/symlink, file đặt trực tiếp trong thư mục sách hoặc file không phải PDF.
- Tên thư mục sách trở thành `folderName`; mọi batch đều có `priority=false`.
- Preflight kiểm tra toàn bộ cây trước request ghi: cấu trúc, giới hạn tên, file
  không rỗng, tối đa 350 MB và chữ ký đầu file `%PDF-`. Một lỗi làm dừng toàn bộ
  lượt chạy để không tạo một đợt upload thiếu âm thầm.

## Kiến trúc và data flow

```text
BAT
  │
  ▼
CLI scan + SHA-256 ──► ledger cục bộ
  │                      │
  │ user xác nhận        │ stable clientBatchId/clientUploadId
  ▼                      ▼
GET readiness/status → POST prepare
                           │
                           ▼
                    PUT stream PDF → R2
                           │
                           ▼
                    POST confirm (tối đa 50 job/lần)
                           │
                           ▼
                    GET batch status
                           │
                  canCloseClient=true
                           │
                           ▼
                    ledger status=ready
```

CLI kiểm tra `/api/readiness` và `/api/translate/status` sau khi người dùng xác
nhận nhưng trước khi tạo operation mới. Upload bị chặn nếu MongoDB/R2 chưa sẵn
sàng hoặc maintenance pause đang bật.

Mỗi sách được xử lý tuần tự để log và recovery dễ hiểu. Bên trong một batch, tối
đa bốn PDF được stream song song từ disk; file không được nạp toàn bộ vào RAM.
Một operation chứa tối đa 500 file và 2 GiB. Sách vượt giới hạn được chia thành
nhiều operation nhưng giữ cùng `folderName`.

## Ledger và tính idempotent

Ledger mặc định:

```text
%LOCALAPPDATA%\StudyMed\Uploader\state-v1.json
```

Mỗi lần ghi tạo file tạm, lưu bản trước đó thành `state-v1.json.bak`, rồi rename
file tạm. Ledger không chứa credential hoặc presigned URL. Nó chứa:

- schema version và timestamps;
- operation với `clientBatchId`, `clientUploadId`, `batchId` và manifest ổn định;
- record đã xác nhận gồm folder, tên file, kích thước, SHA-256, batch/job ID.

Fingerprint được tính từ API URL chuẩn hóa + tên sách + tên file + SHA-256. Vì
vậy:

- chạy lại cùng file trong cùng sách sẽ bỏ qua;
- file đổi nội dung nhưng giữ tên được xem là file mới;
- đổi tên file được xem là file mới để tên output trên StudyMed phản ánh đúng;
- cùng nội dung nhưng thuộc sách/tên file khác vẫn là hai tài liệu riêng.

Operation mới được persist trước `POST prepare`. Nếu process, mạng hoặc máy bị
ngắt, lần chạy sau dùng lại các ID cũ; backend trả lại cùng batch thay vì tạo job
trùng. Confirm thành công được persist theo từng nhóm. Khi chạy lại batch dở,
item server đã chuyển khỏi `uploading` không bị PUT lại; chỉ khi toàn batch trả
`canCloseClient=true` operation mới được đánh dấu `ready`.

Không xóa hoặc tự sửa ledger để “thử lại”. Nếu JSON/schema hỏng, file của operation
đang dở bị mất/đổi, hoặc server trả manifest/batch ID khác, CLI fail closed. Điều
tra `state-v1.json` và `.bak` trước; reset ledger có thể tạo bản dịch trùng và tốn
quota.

## Retry, lỗi và bảo mật

- Request API và PUT retry tối đa ba lần với backoff cho mất kết nối, 408, 429 và
  5xx.
- PUT nhận 400/401/403 sẽ gọi lại prepare để lấy presigned URL mới, tối đa ba vòng.
- File được stat lại ngay trước PUT; thay đổi size/mtime sau preflight làm dừng
  file.
- Một operation không đạt `canCloseClient=true` làm CLI dừng. Confirm đã thành
  công vẫn còn trong ledger; chạy lại để resume thay vì tạo batch khác.
- CLI còn yêu cầu `confirmedFiles` bằng đúng số file operation và
  `skippedFiles=0`; trạng thái close-safe do file bị abandon không được xem là
  upload hoàn tất.
- Presigned URL chỉ được PUT nếu dùng HTTPS và hostname kết thúc bằng
  `.r2.cloudflarestorage.com`. URL không được ghi vào ledger/log.
- CLI không import runtime services, không đọc `.env`, Mongo URI, Gemini key hoặc
  R2 credential. Backend hiện vẫn là bên cấp presigned URL theo public contract
  đang dùng bởi frontend.

## Sử dụng

Thông thường, nhấp đúp:

```text
Upload file chờ dịch.bat
```

BAT kiểm tra Node.js, gọi CLI bằng đường dẫn tương đối, giữ cửa sổ mở và trả lại
exit code. CLI luôn in số sách, tổng PDF/dung lượng, số mới, số resume và số đã
tải; nhập `Y` mới tạo job thật.

Kiểm tra không gọi mạng và không ghi ledger:

```powershell
cd med-translator-backend
npm run upload:staging:dry-run
```

Dùng nguồn hoặc backend khác:

```powershell
node scripts/local-uploader.js --source "D:\Nguồn khác" --api-url "http://localhost:8080/api/translate"
```

HTTP chỉ được phép cho `localhost`; đích từ xa bắt buộc HTTPS. Dùng
`node scripts/local-uploader.js --help` để xem interface hiện hành.

`--yes` bỏ qua câu hỏi xác nhận và chỉ dành cho automation đã được chủ hệ thống
phê duyệt rõ. BAT mặc định không truyền cờ này, nên thao tác nhấp đúp vẫn luôn yêu
cầu nhập `Y`.

## Xử lý sự cố

| Triệu chứng | Hành động |
| --- | --- |
| Preflight liệt kê sai cấu trúc | Sửa đúng đường dẫn được báo; chưa có job nào được tạo |
| Readiness/storage unavailable | Chờ Render/R2 phục hồi rồi chạy lại |
| Maintenance paused | Hoàn tất/cancel quy trình redeploy rồi chạy lại |
| Batch chưa an toàn | Giữ nguyên nguồn và ledger, chạy lại để resume |
| File batch dở bị mất/đổi | Khôi phục đúng file cũ trước; không reset ledger |
| Ledger lỗi JSON/schema | Giữ cả file chính và `.bak`, điều tra thủ công |
| Chạy lại báo 0 file mới | Hành vi bình thường: mọi fingerprint đã được xác nhận |

Regression test nằm tại
`../../med-translator-backend/test/localUploader.test.js`. Test dùng thư mục tạm
và API/R2 giả, không gọi production hoặc upload PDF thật.
