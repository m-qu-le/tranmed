# P014 — Runbook cutover Render → Oracle A1

> **ARCHIVED — không được chạy.** P014 đóng ngày 11-08-2026 trước khi cutover và
> trước mọi purge production. Xem `project-014-closure.md`.

## Nguyên tắc an toàn

- Đây là **cold cutover**: chỉ có một backend worker chạy trên MongoDB/R2 tại một
  thời điểm. Không khởi chạy Oracle worker trong khi Render còn có thể xử lý queue.
- Người dùng đã quyết định không backup lịch sử công việc. Thao tác purge là không
  thể hoàn tác; vẫn phải có dry-run và xác nhận hai lớp để chống xóa nhầm scope.
- Không xóa `System`, `GeminiQuotaState` hoặc `GeminiSchedulerState`. Reset các state
  này có thể tạo burst retry/429 sau khi khởi động VM mới.
- Không thực hiện bất cứ purge nào trước khi VM, TLS, secret, Atlas và R2 đều sẵn
  sàng để canary.

## 1. Chuẩn bị code và deployment

Khi bắt đầu P014, cần bổ sung và review các thay đổi sau:

1. Dockerfile ARM-compatible cho backend Node và Compose production gồm `backend` +
   `gateway` (Caddy).
2. Caddyfile để:
   - public `GET /api/health` và `GET /api/readiness`, trả `Cache-Control: no-store`;
   - yêu cầu Basic Auth cho static frontend và mọi API nghiệp vụ;
   - serve SPA fallback an toàn;
   - proxy API tới backend trong Docker network nội bộ.
3. Build frontend production với `VITE_API_URL=/api/translate`, để EventSource và
   request API không đi qua Vercel/cross-origin.
4. Một chế độ build Vercel “legacy notice”: chỉ hiện địa chỉ mới, không tự redirect và
   không khởi động app/SSE hay gọi production API.
5. Chuyển các thông báo/validation gắn tên “Render” trong backend thành platform
   neutral; không thay giá trị giới hạn worker an toàn hiện có.
6. Thêm script purge có test: dry-run mặc định; chỉ thực thi sau cờ CLI và biến môi
   trường xác nhận rõ ràng. Script không import/start server hoặc worker.
7. Cập nhật `.gitignore` để ngăn `.env`, Docker secret override và certificate/state
   cục bộ bị commit.

Mỗi thay đổi có unit/integration test phù hợp và toàn bộ test backend/frontend phải
pass trước deploy.

## 2. Chuẩn bị cấu hình ngoài repository

### Secrets trên VM

Chép thủ công các secret cần thiết từ dashboard Render hiện tại vào file riêng trên
VM, ví dụ backend env và gateway env. File phải thuộc user deploy/root, permission
`0600`; không in secret ra terminal, issue, commit hay workflow log.

Backend env bao gồm các giá trị MongoDB Atlas, Gemini key pool, Cloudflare R2,
maintenance token và `FRONTEND_URL=https://tranmed-api.duckdns.org`. Gateway env chỉ
nhận Basic Auth hash/cấu hình tối thiểu; không cần Gemini hay MongoDB secret.

### MongoDB Atlas và Cloudflare R2

1. Thêm public IP Oracle A1 vào Atlas network access.
2. Cập nhật R2 CORS, thêm origin chính xác `https://tranmed-api.duckdns.org` và các
   method/header cần cho browser PUT qua presigned URL.
3. Không xóa `0.0.0.0/0` cho đến khi `/api/readiness` trên Oracle xác nhận Atlas
   connect thành công.
4. Sau khi xác nhận, gỡ allowlist rộng `0.0.0.0/0`. Nếu VM bị tái tạo và IP đổi, phải
   thêm IP mới vào Atlas trước khi backend khởi động lại.

## 3. Trình tự cutover

| Gate | Hành động | Điều kiện tiếp tục |
| --- | --- | --- |
| A | A1 VM, DuckDNS và TLS đã sẵn sàng | Hostname trả certificate hợp lệ |
| B | Deploy code lần đầu nhưng chưa chạy worker xử lý | Container build được; secret không lộ |
| C | Xác nhận `/api/readiness`, frontend qua Basic Auth, Atlas, R2 CORS | Tất cả pass; backend chưa xử lý job cũ |
| D | Chạy purge script ở **dry-run** | Scope chỉ là `incoming/` và ba Mongo collection đã chốt |
| E | Xác nhận chữ ký/biến destructive, purge R2 trước | Mọi object `incoming/` xóa thành công |
| F | Xóa Mongo `TranslationChunk`, `Job`, `UploadBatch` | Không đụng ba scheduler/system collections giữ lại |
| G | Bật backend worker trên Oracle | Chỉ một instance worker hoạt động |
| H | Chạy canary một PDF nhỏ | Kết quả hoàn chỉnh, không lỗi/quota burst |
| I | Xóa job/source canary, bật monitoring | Readiness được UptimeRobot quan sát |
| J | Xóa Render service | Không còn khả năng có worker Render thứ hai |

Nếu E có bất cứ R2 key nào xóa thất bại, script phải dừng trước F; không được xóa
Mongo để làm mất reference trong khi source còn tồn tại. Script cần idempotent để có
thể chạy lại an toàn sau khi xử lý lỗi.

## 4. Canary và tiêu chí rollback

Canary chỉ dùng **một PDF nhỏ**, thông qua UI thật:

```text
Browser → R2 presigned upload → queue → Gemini → result UI
```

Quan sát status job, error log, quota/circuit và kết quả cuối. Không tăng worker
concurrency hoặc bật `GEMINI_DIAGNOSTIC_PROBE_ENABLED` để “thử cho nhanh”. Sau khi
canary đạt, xóa job/source canary theo quyết định không lưu lịch sử.

Trước khi xóa Render, rollback là dừng Oracle worker, sửa cấu hình và deploy lại. Sau
khi Render bị xóa, rollback không phải là khôi phục Render tự động; cần tạo lại dịch
vụ và cấu hình riêng nên chỉ thực hiện khi owner yêu cầu rõ ràng.

## 5. Điều tuyệt đối không làm

- Không chạy song song Render và Oracle worker.
- Không dùng `git reset --hard` trong deploy; chỉ `git pull --ff-only`.
- Không proxy ứng dụng qua Vercel; thời gian request/stream có thể bị giới hạn và
  không cần thiết khi frontend cùng VM.
- Không đổi MongoDB, R2 bucket, Gemini project/key, worker limit hay pipeline trong
  cùng cutover nếu không có quyết định mới được review.
- Không coi frontend render được là dấu hiệu dữ liệu/queue hoạt động đúng.
