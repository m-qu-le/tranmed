# StudyMed Translator — Backend

Express/MongoDB backend với persistent queue, atomic job lease, PDF Worker Thread, Gemini key rotation, retry có phân loại lỗi và kết quả lưu theo chunk.

## Chạy local

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Điền `MONGODB_URI` và `GEMINI_API_KEYS` thật trong `.env`. Không commit file này.

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

Trước lần deploy P001 đầu tiên, backup MongoDB rồi chạy:

```powershell
npm run migrate:p001
```

Migration có tính idempotent và đồng bộ index cho Job, System và TranslationChunk. Không chạy migration production nếu chưa có backup.
