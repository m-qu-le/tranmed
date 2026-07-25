# Vận hành, cấu hình, kiểm tra và deploy

## Nguyên tắc an toàn

- Không đọc/in/commit `.env`, API key, Mongo URI, R2 credential, maintenance token, presigned URL, PDF hay nội dung dịch. Dùng endpoint đã redacted để chẩn đoán khi có thể.
- Không chạy migration, backup, reconcile R2, smoke Gemini hay thay env Render chỉ để kiểm tra thông thường. Đây là thao tác chủ động có tác động dữ liệu/chi phí.
- `/api/health` là heartbeat Mongo. `/api/readiness` là readiness Mongo + R2. Cả hai đều cần thành công trước và sau deploy; health không chứng minh R2 usable.
- Runtime production có thể khác fallback mã nguồn. Xem `/api/translate/status` để biết worker/budget/hibernate/maintenance/storage backlog và `/api/translate/gemini-keys/status` để biết số/trạng thái key, không suy luận từ `.env` local.

## Topology production sau P012

- Backend chạy trên Render Ohio (US East).
- MongoDB hiện hành là Atlas project `TranMed-US`, cluster Free
  `tranmed-us-prod`, AWS N. Virginia `US_EAST_1`, database
  `studymed_translator`.
- P012 dùng controlled cold start: chỉ bootstrap state/index bắt buộc, không restore
  job/folder/chunk cũ. Lịch sử giao diện cũ đã được chủ hệ thống chủ động từ bỏ sau
  khi tải các file Markdown cần giữ.
- Cluster Hong Kong là rollback safety net, phải giữ 7–14 ngày và qua ít nhất hai
  batch thật trước khi cân nhắc xóa.
- Canary ngày 24-07-2026 hoàn tất 1/1 chunk trong khoảng 21 giây, không retry/429;
  Mongo operation p95 là 31 ms so với khoảng 598–757 ms trước cutover. Đây là bằng
  chứng tại thời điểm canary, không thay cho giám sát production liên tục.
- Atlas IP Access List `0.0.0.0/0` là ngoại lệ được owner chấp nhận cho hệ thống cá
  nhân. Database user `tranmed_app` hiện có role `readWriteAnyDatabase@admin`; không
  dùng tài khoản này cho quản trị và nên thu hẹp về `readWrite` trên đúng database
  trong đợt hardening.

### Capacity rollout P011 và containment P013

- P011 được đưa ra khỏi archive ngày 24-07-2026 để tiếp tục theo dõi capacity hậu P012.
- Kiểm tra live 16:56–16:58 ICT: Mongo operation p95 98 ms/3.610 mẫu, quota
  reserve/release p95 97/95 ms, RSS khoảng 47% và event-loop p95 20 ms; Mongo/resource
  gate đạt.
- Cửa sổ trước P013 từng có amplification tích lũy 1,219, limiter window rate-limit
  22% và burst 77 giây với +29 logical-issued, +41 physical, +21 phản hồi 429.
- P013 đã đóng retry storm bằng commit `0f739b1`. Nghiệm thu production ngày
  24-07-2026 đạt 225 logical-issued/226 physical, 0 response 429, amplification
  1,0044, 45 terminal chunk và 0 job failed. Đây là bằng chứng tại cửa sổ nghiệm
  thu, không phải bảo đảm quota tương lai.
- Giữ `GEMINI_MAX_CONCURRENCY=5`. Không tăng chỉ vì Mongo p95 xanh; phải điều tra quota
  thật và lặp lại gate ≥200 logical-issued/≥20 chunk terminal với amplification
  ≤1,15, 429 <1%, không lỗi persist/lease/duplicate/mất stage trước mỗi lần tăng.
- Hồ sơ đang hoạt động: `../../project-011/project-011.md`; runbook:
  `../../med-translator-backend/PROJECT_POOL_ROLLOUT.md`.
- Hồ sơ sự cố đã đóng: `../../archive/project-013/project-013.md`.

### Runbook Gemini 429 sau P013

- Generic `429 RESOURCE_EXHAUSTED` không chứng minh project hết RPD, quota dimension
  cụ thể hoặc outbound IP Render bị block.
- Scheduler mở global circuit khi 5 project độc lập trả 429 trong 10 giây. Backoff
  tăng khoảng 60 giây → 2 → 4 → 8 → tối đa 10 phút và cần 10 physical success liên
  tiếp để reset.
- Stage đã chờ limiter phải re-check gate trước reservation/API call. Khi circuit
  mở, physical-attempt mới phải bằng 0 cho tới `nextAvailableAt`.
- Project generic 429 có cooldown tăng dần; `Retry-After` từ provider vẫn được ưu
  tiên. Counter đạt 500 RPD mới là căn cứ nội bộ để chờ Pacific reset; không tự gắn
  RPD-exhausted chỉ từ response generic.
- Kiểm `/api/translate/metrics`: `gemini.rateLimitCircuit`, `globalGateReason`,
  `physicalAttempts/logicalIssuedRequests`, `rateLimitResponses`; kiểm
  `/api/translate/status`: `quotaGate`, `blockedReason`, `nextWakeTime`.
- Khi 429 burst xuất hiện: không tăng concurrency, không bật thêm project để probe,
  không restart liên tục. Đợi circuit deadline, xác nhận queue hibernate và dùng
  maintenance drain trước diagnostic probe cô lập.
- Chỉ nghi source/IP enforcement khi cùng key/project/model/payload thành công local
  nhưng Render idle vẫn 429 trong phép thử đồng thời, giới hạn request. Nếu workload
  production Render đang thành công liên tục thì không kết luận IP block.

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

## Upload từ laptop không mở giao diện

Nhấp đúp `../../Upload file chờ dịch.bat` để quét
`D:\1. File chờ dịch`, xem thống kê rồi xác nhận một lần trước khi tạo job
production. Cấu trúc bắt buộc là `Tên sách\<một thư mục con>\*.pdf`; tên sách trở
thành nhóm StudyMed và mọi file đi vào hàng thường.

Chỉ kiểm tra local, không gọi mạng, không tạo job và không ghi ledger:

```powershell
cd med-translator-backend
npm run upload:staging:dry-run
```

Ledger chống trùng nằm tại
`%LOCALAPPDATA%\StudyMed\Uploader\state-v1.json`. Không xóa/reset ledger hoặc đổi
file của batch đang dở để thử lại; giữ nguyên nguồn và chạy lại để resume. Thiết
kế, interface, failure mode và recovery đầy đủ nằm trong
[local-uploader.md](local-uploader.md).

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
3. Pause cho physical request đang chạy hoàn tất, suspend job ở ranh giới stage và persist về pending; nó không abort qua `CANCELLED`. Đợi `maintenanceState=drained`, `worker.activeJobs=0`, `dispatcher.activeStages=0`, `dispatcher.waitingStages=0` và không còn Job `processing`.
4. Deploy backend trước frontend nếu API contract thay đổi. Khi đổi model, đặt rõ `GEMINI_MODEL`; khi đổi worker/budget, đặt rõ cả hai biến, không xóa biến để rơi vào fallback 5/100.
5. Sau restart, gọi `/api/readiness`, `/api/translate/status`, `/api/translate/metrics`, và kiểm key status. Xác nhận maintenance `running`/không paused, circuit/gate hợp lý, storage available, cleanup/upload backlog hợp lý, worker config đúng ý định.
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
