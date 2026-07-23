# Vận hành, cấu hình, kiểm tra và deploy

## Nguyên tắc an toàn

- Không đọc/in/commit `.env`, API key, Mongo URI, R2 credential, maintenance token, presigned URL, PDF hay nội dung dịch. Dùng endpoint đã redacted để chẩn đoán khi có thể.
- Không chạy migration, backup, reconcile R2, smoke Gemini hay thay env Render chỉ để kiểm tra thông thường. Đây là thao tác chủ động có tác động dữ liệu/chi phí.
- `/api/health` là heartbeat Mongo. `/api/readiness` là readiness Mongo + R2. Cả hai đều cần thành công trước và sau deploy; health không chứng minh R2 usable.
- Runtime production có thể khác fallback mã nguồn. Xem `/api/translate/status` để biết worker/budget/hibernate/maintenance/storage backlog và `/api/translate/gemini-keys/status` để biết số/trạng thái key, không suy luận từ `.env` local.

## Biến môi trường backend

Tạo `.env` từ `.env.example` khi chạy local. `validateRuntimeEnv()` yêu cầu các biến sau khi server thật khởi động:

| Nhóm | Biến | Ghi chú |
| --- | --- | --- |
| Server | `PORT`, `FRONTEND_URL` | PORT fallback 8080; FRONTEND_URL bổ sung CORS allow-list |
| Mongo/Gemini | `MONGODB_URI`, `GEMINI_API_KEYS`, `GEMINI_MODEL` | keys phân tách dấu phẩy, không có phần tử rỗng; model fallback 3.5 Flash-Lite |
| R2 required | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT`, `R2_REGION` | endpoint bắt buộc HTTPS |
| R2 behavior | `R2_PRESIGNED_URL_TTL_SECONDS`, `R2_UPLOAD_CONCURRENCY`, `R2_SOURCE_RETENTION_DAYS` | ba biến này bắt buộc ở runtime; retention failed source mặc định code là 7 ngày nhưng vẫn phải cấu hình rõ |
| Upload/retry | `MAX_UPLOAD_STORAGE_MB`, `MAX_FILE_SIZE_MB`, `MAX_JOB_ATTEMPTS`, `GEMINI_TIMEOUT_MS` | defaults code 400, 350, 3, 180000 ms; file size phải nhỏ hơn storage budget |
| Worker | `TRANSLATION_WORKER_CONCURRENCY`, `PARALLEL_SOURCE_BUDGET_MB` | nhận strict 1–5 và 10–100; fallback code 5/100, không mặc định đó là cấu hình Render an toàn |
| Pipeline | `TRANSLATION_PIPELINE_MODE`, `PDF_PAGES_PER_CHUNK`, `GEMINI_THINKING_LEVEL`, `QUALITY_MAX_REPAIR_CYCLES` | mode `quality|legacy`; thinking phải `HIGH`; repair 0–2 |
| Maintenance | `MAINTENANCE_CONTROL_TOKEN` | token riêng cho pause/cancel redeploy; nếu không có, endpoint trả 503 và UI vô hiệu hóa control |

`GEMINI_MODEL` nên được đặt rõ trong Render dù mã có fallback để truy vết model. `GEMINI_THINKING_LEVEL=HIGH` là yêu cầu của parser hiện tại, không hạ xuống để giảm chi phí. P010 bỏ `temperature`; không thêm sampling field cũ vào request config.

### Kiểm tra key pool không lộ secret

```powershell
Invoke-RestMethod https://tranmed.onrender.com/api/translate/gemini-keys/status
```

Response chỉ có `keyCount` và các key index/status/cooldown time. `untested` là chưa có request thành công sau startup; `available` là có thể dùng; `cooldown` có `cooldownUntil`; `disabled` là 401/403 cho đến restart/reconfigure. Endpoint unreachable/404 chỉ có nghĩa không xác minh được hoặc deployment chưa có diagnostics, không phải bằng chứng số key bằng 0.

## Kiểm tra local thay đổi mã

```powershell
cd med-translator-backend
npm test
npm audit

cd ..\med-translator-frontend
npm test
npm run lint
npm run build
npm audit

cd ..
git diff --check
```

Không chạy benchmark/PDF thật để làm regression thông thường. P003 benchmark raw đã được dọn. Sau thay đổi Gemini SDK/model/payload, chỉ chạy smoke thực khi đã được giao việc và có môi trường/key được cấp:

```powershell
cd med-translator-backend
npm run test:keys
npm run smoke:p010-gemini
npm run smoke:p003-quality
```

Các smoke Gemini có thể phát sinh request/chi phí; P010 smoke tạo tài nguyên tạm và có cleanup, nhưng vẫn cần xác nhận kết quả/cleanup thay vì coi script chạy là thành công.

## Migration, backup và R2 maintenance

Migration P001–P003 là additive/idempotent nhưng vẫn làm trên dữ liệu thật, không phải lệnh bootstrap vô hại. Trước P002/P003, chọn một thư mục backup **ngoài repository** và chạy dry-run trước migration.

```powershell
cd med-translator-backend

# P001 (nếu lịch sử/database của môi trường cần nó)
npm run migrate:p001:dry
npm run migrate:p001
npm run verify:p001

# P002
$env:P002_BACKUP_DIR='D:\backup\studymed-p002'
npm run backup:p002
npm run migrate:p002:dry
npm run migrate:p002

# P003
$env:P003_BACKUP_DIR='D:\backup\studymed-p003'
npm run backup:p003
npm run migrate:p003:dry
npm run migrate:p003
```

Không có migration bắt buộc riêng cho P004–P010 trong mã hiện tại. P009/P010 thay đổi hành vi/API/version nhưng không phải lý do để rewrite kết quả cũ. `npm run reconcile:r2` là công cụ chủ động để kiểm object R2 mồ côi, không chạy trong server và không chạy trên production nếu chưa hiểu phạm vi/cleanup của script.

## Redeploy an toàn

1. Kiểm tra batch upload: người dùng phải đã thấy `canCloseClient=true`; đừng redeploy giữa một upload browser chưa được confirm.
2. Kiểm tra `/api/translate/status`. Dùng UI hoặc `POST /maintenance/pause` với `X-Maintenance-Token` để ngừng claim mới.
3. Đợi `worker.activeJobs=0` và không còn Job `processing`. Pause không giết active job; nó chỉ là cửa sổ an toàn để tránh job lai model/code.
4. Deploy backend trước frontend nếu API contract thay đổi. Khi đổi model, đặt rõ `GEMINI_MODEL`; khi đổi worker/budget, đặt rõ cả hai biến, không xóa biến để rơi vào fallback 5/100.
5. Sau restart, gọi `/api/readiness`, `/api/translate/status`, `/api/translate/metrics`, và kiểm key status. Xác nhận maintenance không còn paused, storage available, cleanup/upload backlog hợp lý, worker config đúng ý định.
6. Chỉ chạy canary/smoke production nếu được phê duyệt; không thêm PDF canary khi backlog thật đang tồn tại.

Nếu maintenance instance cũ bị redeploy, pause state chỉ sống trong instance đó; instance mới recovery queue/lease và bắt đầu worker bình thường. Sau crash/restart, kiểm `processing`, `nextRetryAt`, cleanup state và stderr/log; không mặc định job thành công chỉ vì server đã lên.

## Rollback

| Tình huống | Rollback tối thiểu |
| --- | --- |
| Quality regression | pause an toàn, đặt `TRANSLATION_PIPELINE_MODE=legacy` cho job mới, restart/deploy; không rewrite quality artifact terminal |
| Gemini model/SDK regression | pause, đặt model baseline rõ ràng (P010 lịch sử là 3.1), redeploy artifact/SDK cần thiết; không chuyển model giữa job active |
| Worker memory/throughput xấu | đặt concurrency/budget bảo thủ rõ ràng, ví dụ 2/10 hoặc 1/10, restart; P008 cho thấy 5/100 không an toàn trên Render Free |
| API/code regression | tạo commit revert và deploy lại; không `git reset --hard` lịch sử đã push |
| Cleanup/retry backlog | giữ metadata/source state, kiểm R2/Mongo và sweeper; không xóa Job/chunk/object hàng loạt để “làm sạch” trước khi xác định scope |

Rollback schema không cần thiết cho migration additive. Job terminal vẫn phải đọc được từ `TranslationChunk.content` hoặc legacy `Job.result`.

## Git và dữ liệu workspace

- Worktree hiện có thay đổi archive do người dùng tạo; không stage/đảo ngược/xóa các thay đổi ngoài phạm vi.
- Không dùng `git add -A`, `git reset --hard` hoặc commit `.env`, `samplepdf/`, PDF, `uploads/`, `node_modules/`, `dist/`, signed URL hay raw benchmark artifact.
- Trước commit: review `git status`, diff đúng file, `git diff --check`, và test tương xứng với thay đổi. Tài liệu `.codex/knowledge` phải thay đổi cùng contract/semantics mà nó mô tả.
