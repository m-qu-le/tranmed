# Vận hành, cấu hình và Git

## Biến môi trường

Backend xem `.env.example`:

- `MONGODB_URI`, `GEMINI_API_KEYS` bắt buộc khi chạy server.
- `PORT` mặc định 8080; `FRONTEND_URL` thêm origin CORS.
- `GEMINI_MODEL` mặc định `gemini-3.1-flash-lite`.
- `MAX_UPLOAD_STORAGE_MB` mặc định 400; `MAX_FILE_SIZE_MB` mặc định 350 và bắt buộc nhỏ hơn disk budget.
- `MAX_JOB_ATTEMPTS` mặc định 3; `GEMINI_TIMEOUT_MS` mặc định 180000.

Frontend: `VITE_API_URL` phải là base đầy đủ, ví dụ `https://tranmed.onrender.com/api/translate`.

## Lệnh local

```powershell
cd med-translator-backend
npm install
npm run dev
npm test

cd ..\med-translator-frontend
npm install
npm run dev
npm test -- --run
npm run lint
npm run build
```

`Dichtailieu.bat` mở hai server nhưng không còn tự xóa `uploads/`; queue/orphan service chịu trách nhiệm cleanup.

## Migration P001

Mặc định không chạy với production trước khi backup MongoDB. Ngoại lệ P001 đã được chủ dự án chấp thuận ngày 15-07-2026 vì database được xác nhận không còn job/dữ liệu cần giữ: chạy dry-run/count trước; nếu phát hiện document thì dừng và backup thay vì migration tiếp.

```powershell
npm run migrate:p001:dry
npm run migrate:p001
```

Dry-run chỉ đếm document thiếu field, không update hoặc sync index. Migration thật bổ sung default additive và sync indexes; code vẫn đọc job legacy có `result`.

## Checklist bàn giao/deploy

1. Backend tests, frontend test/lint/build, `npm audit` cả hai và `git diff --check` phải sạch.
2. Chạy migration dry-run và lưu số liệu không chứa credential. Với database có dữ liệu phải backup; ngoại lệ database trống của P001 chỉ tiếp tục nếu count xác nhận đúng kỳ vọng.
3. Deploy backend trước, smoke health/capacity/jobs/SSE/upload/result/delete.
4. Deploy frontend với đúng `VITE_API_URL`, smoke Local Feeder nhiều file.
5. Theo dõi RAM, disk, restart, retry/orphan trong 24 giờ trước khi đóng Project 001.

## Git an toàn

- Không stage ba deletion tài liệu gốc đang có sẵn trong worktree nếu chưa được chủ dự án xác nhận.
- Không dùng `git add -A`, không commit `.env`, PDF, secret hoặc `dist`.
- Nhánh triển khai hiện tại: `refactor/project-001`.
- Trước production cần commit/tag rollback; không dùng `git reset --hard` để xử lý worktree của người dùng.
