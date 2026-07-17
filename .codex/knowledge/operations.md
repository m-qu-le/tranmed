# Vận hành, cấu hình và Git

## Biến môi trường chính

Backend xem `.env.example`:

- `MONGODB_URI`, `GEMINI_API_KEYS` và nhóm `R2_*` bắt buộc khi chạy server.
- `GEMINI_MODEL` mặc định `gemini-3.1-flash-lite`.
- `TRANSLATION_PIPELINE_MODE` mặc định `quality`; đặt `legacy` để rollback job mới.
- `PDF_PAGES_PER_CHUNK=2`, `GEMINI_THINKING_LEVEL=HIGH`, `QUALITY_MAX_REPAIR_CYCLES=2`.
- `MAX_JOB_ATTEMPTS` mặc định 3; `GEMINI_TIMEOUT_MS` mặc định 180000.
- `TRANSLATION_WORKER_CONCURRENCY` chỉ nhận `1|2`, mặc định 1; lane hai có budget source cố định 10 MiB.
- `MAX_UPLOAD_STORAGE_MB` mặc định 400; `MAX_FILE_SIZE_MB` mặc định 350.

Frontend: `VITE_API_URL` là base `/api/translate`, production hiện dùng `https://tranmed.onrender.com/api/translate`.

## Lệnh kiểm tra local

```powershell
cd med-translator-backend
npm test
npm audit

cd ..\med-translator-frontend
npm test
npm run lint
npm run build
npm audit
```

Không chạy benchmark/PDF thật chỉ để kiểm regression. P003 đã đóng; workload Gemini mới cần một dự án hoặc quyết định mới.

## Migration và deploy

- Migration P001–P003 là additive/idempotent; production P003 đã backup, dry-run, migrate và verify index. Field P004 nullable nên không cần migration bắt buộc.
- Mốc commit đóng hồ sơ P003 trước lượt dọn cuối: `5edce7a`; đã có trên `main` và `feature/project-003-translation-quality`.
- Render restart sau deploy v3 tại `2026-07-16T15:41:03.348Z`; health/readiness đạt, Mongo/R2 available, backlog 0.
- Frontend tương thích legacy và quality; P004 công khai header đã escape chỉ khi job quality hoàn thành còn chunk cần review.
- P005 phải deploy code với concurrency 1 trước; chỉ giữ production = 2 sau canary hai PDF nhỏ đạt concurrency, tài nguyên, quota, output và cleanup.

Checklist cho thay đổi tương lai:

1. Backend test; frontend test/lint/build; `git diff --check`.
2. Nếu đổi schema/index production: dry-run, backup khi có dữ liệu, rồi hậu kiểm.
3. Deploy backend trước frontend khi API contract thay đổi.
4. Smoke chỉ ở mức tương xứng với rủi ro; không dùng dữ liệu sách trong log/commit.

## Rollback

- Đặt `TRANSLATION_PIPELINE_MODE=legacy` và restart để job mới dùng pipeline cũ.
- Không migration ngược hoặc xóa field/artifact additive.
- Job terminal vẫn đọc từ `content`; job quality dở giữ artifact để resume sau.
- Live rollback drill và theo dõi 24 giờ được chủ dự án miễn khi đóng P003; không ghi chúng như bằng chứng đã thực hiện.

## Git an toàn

- Không stage các deletion/untracked root ngoài phạm vi đã có sẵn trong worktree.
- Không dùng `git add -A`; không commit `.env`, PDF, secret, signed URL, `.p003-local/` hoặc `dist/`.
- Nhánh P003: `feature/project-003-translation-quality`; production theo `main`.
- P004/P005 đang được hoàn thiện trên cùng nhánh lịch sử này; cả hai remote ref phải fast-forward cùng commit trước khi đóng.
- Không dùng `git reset --hard` để xử lý worktree của người dùng.

## Chính sách giữ/xóa artifact

- Giữ test của `src/`, migration, backup, reconcile và smoke có cleanup vì còn dùng cho regression/vận hành.
- Giữ `archive/project-003/project-003-*` và `archive/project-004/project-004.md` làm bằng chứng nhỏ đã lọc; không tái tạo raw artifact chỉ để làm đẹp báo cáo.
- Có thể xóa `dist/`, `uploads/` rỗng và `.p003-local/` sau khi chắc chắn không có runner; chúng đều tái tạo được hoặc chỉ là dữ liệu tạm.
- Không tự xóa `samplepdf/`, `.env`, `node_modules/` hoặc file người dùng dù chúng bị ignore. Asset/code chỉ được xóa sau khi kiểm tra không có import/tham chiếu runtime.
