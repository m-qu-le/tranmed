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

Sau deploy production, kiểm tra `/api/readiness`, chạy một batch close-safe qua restart có kiểm soát, rồi dùng `npm run reconcile:r2` xác nhận không còn object mồ côi.
