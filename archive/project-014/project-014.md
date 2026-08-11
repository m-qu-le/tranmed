# PROJECT 014 — Chuyển StudyMed Translator từ Render sang Oracle Always Free

| Thuộc tính | Giá trị |
| --- | --- |
| Mã dự án | `P014` |
| Cập nhật | 09-08-2026 |
| Ngày đóng | 11-08-2026 |
| Trạng thái | **ĐÃ ĐÓNG — không tạo được tài khoản Oracle Always Free; chưa triển khai production** |
| Mục tiêu | Thay backend Render và frontend Vercel bằng một VM Oracle Always Free, không dùng dịch vụ trả phí |
| Backend hiện tại | Render — đang bị suspend vì đã dùng hết 5 GB free bandwidth |
| Đích triển khai | Oracle Cloud Always Free A1 tại US East, 2 OCPU / 6 GB RAM / 50 GB disk |
| Tên miền đích | `https://tranmed-api.duckdns.org` |
| Tài liệu chuẩn bị | [P014 Oracle onboarding](project-014-oracle-onboarding.md) |
| Runbook cutover | [P014 cutover runbook](project-014-cutover-runbook.md) |
| Vận hành sau cutover | [P014 operations](project-014-operations.md) |

> Hồ sơ này chỉ ghi phương án đã thống nhất. Việc tạo VM, thay DNS, xóa dữ liệu,
> thêm secret, deploy code hoặc xóa Render **chưa được thực hiện** bởi việc tạo tài liệu.

> **Hồ sơ lịch sử:** P014 đã dừng vì owner không thể hoàn tất việc tạo tài khoản
> Oracle Always Free. Không thực hiện tiếp runbook trong thư mục này. Toàn bộ code
> chuẩn bị Oracle đã được lưu tại branch `archive/project-014-oracle-attempt` và tag
> `project-014-oracle-attempt-2026-08-11`. Nền Render trước P014 được giữ riêng tại
> branch/tag `archive/render-stable-2026-08-11` / `render-stable-2026-08-11`.

## 0. Kết quả đóng dự án

- Oracle VM không được tạo; DuckDNS/Caddy/TLS trên Oracle không được kích hoạt.
- Không chạy purge P014 trên R2/MongoDB và không xóa Render theo runbook này.
- Code Docker, Caddy, CI/CD, legacy notice và purge safety đã được viết và đạt test
  local, nhưng chỉ là snapshot thử nghiệm, không phải bằng chứng production.
- Hướng tiếp theo là P015 local-first. P015 không kế thừa giả định Oracle, domain,
  Caddy hoặc GitHub Actions SSH deploy của P014.

## 1. Kết quả kiến trúc đã chốt

```text
Trình duyệt của chủ sở hữu
  └─ HTTPS + Basic Auth
       └─ Caddy trên Oracle A1
            ├─ Frontend React/Vite (static files)
            └─ Backend Node/Express (/api/*)
                 ├─ MongoDB Atlas
                 ├─ Cloudflare R2 (browser upload trực tiếp qua presigned URL)
                 └─ Gemini API
```

- Caddy phục vụ frontend và reverse proxy backend cùng một hostname; frontend gọi
  API cùng origin tại `/api/translate`.
- DuckDNS cung cấp hostname miễn phí; Caddy tự cấp/gia hạn TLS qua Let's Encrypt.
- Frontend Vercel không còn phục vụ ứng dụng. Nó chỉ giữ một trang thông báo rằng
  ứng dụng đã chuyển sang hostname mới, không redirect và không gọi API production.
- Một Caddy Basic Auth bảo vệ giao diện và API nghiệp vụ. Chỉ `/api/health` và
  `/api/readiness` công khai để monitoring; hai endpoint này không chứa dữ liệu nhạy cảm.
- Cấu hình production được chạy bằng Docker Compose trên VM. Chưa có Dockerfile,
  Compose file hay script deploy trong repository tại thời điểm viết tài liệu này.

## 2. Quyết định đã khóa

| Chủ đề | Quyết định |
| --- | --- |
| Nền tảng | Chỉ Oracle Always Free, không phương án trả phí hay vùng dự phòng |
| Vùng | US East là home region; lựa chọn này không thể đổi cho Always Free compute |
| Capacity A1 | Nếu A1 báo hết capacity: chờ và thử lại; không chuyển sang cấu hình/trả phí khác |
| Dữ liệu cũ | Không backup; xóa toàn bộ lịch sử hàng đợi trước khi cutover |
| Dữ liệu được xóa | MongoDB: `Job`, `TranslationChunk`, `UploadBatch`; R2: chỉ prefix `incoming/` |
| Dữ liệu phải giữ | `System`, `GeminiQuotaState`, `GeminiSchedulerState` — đặc biệt quota/circuit |
| Gemini/worker | Không đổi key pool, giới hạn worker, source budget hay diagnostic probe trong P014 |
| Bảo mật secret | Secret chỉ ở file trên VM, owner/root đọc được (`0600`); không commit, chat hay GitHub Actions |
| Atlas | Cho phép IP public hiện tại của VM, rồi bỏ allowlist cũ `0.0.0.0/0` sau khi kiểm chứng kết nối |
| R2 CORS | Thêm origin `https://tranmed-api.duckdns.org`; không chuyển file ra khỏi R2 |
| CI/CD | GitHub Actions test rồi SSH deploy tuần tự; application secrets không được đưa vào GitHub |
| Render | Chỉ xóa Render service sau canary thành công; GitHub, Atlas và R2 giữ nguyên |
| Monitoring | Oracle Monitoring + UptimeRobot free gọi `/api/readiness`, báo email |

## 3. Phạm vi và điều không thuộc P014

P014 là cold cutover hạ tầng. Nó không tối ưu throughput, không tăng concurrency,
không thay quality pipeline và không tái thiết kế Gemini quota scheduler. Việc gom
frontend/backend chung VM là phù hợp vì hệ thống chỉ có một người dùng và giúp tránh
bandwidth Render; nó không phải kiến trúc để phục vụ nhiều người dùng công khai.

Không coi CORS là cơ chế bảo mật. Basic Auth là lớp kiểm soát truy cập tối thiểu cho
người dùng duy nhất; mật khẩu/hash sẽ được tạo trực tiếp trên VM khi triển khai.

## 4. Gate hoàn thành P014

P014 chỉ được xem là hoàn thành khi mọi điều kiện sau đúng:

1. Oracle A1 chạy ứng dụng qua HTTPS tại hostname đã chốt và Basic Auth hoạt động.
2. `/api/readiness` báo healthy, MongoDB Atlas kết nối từ VM và R2 upload trực tiếp
   từ browser thành công với origin mới.
3. Một PDF nhỏ canary hoàn tất trọn luồng browser → R2 → queue → Gemini → kết quả;
   sau đó job/source canary được xóa.
4. Render service đã bị xóa, nên không còn worker thứ hai xử lý cùng database.
5. GitHub Actions chạy test trước deploy, deploy tuần tự và không có application
   secret trong repository hay workflow log.
6. UptimeRobot/Oracle Monitoring đã có alert thực tế cho endpoint readiness.

## 5. Thứ tự thực hiện ở mức cao

1. Hoàn tất đăng ký Oracle, chọn US East, rồi thử tạo A1. Chỉ chờ capacity nếu bước
   tạo A1 không có host capacity.
2. Khi VM đã tồn tại, xây dựng cấu hình hạ tầng và bảo vệ secret.
3. Cập nhật code/deployment, R2 CORS và Atlas allowlist; kiểm thử nội bộ.
4. Chạy script xóa work data có xác nhận rõ ràng trước khi worker khởi động.
5. Canopy một PDF nhỏ, bật monitoring, rồi xóa Render service.

Chi tiết bắt buộc nằm trong các tài liệu liên kết ở đầu trang. Không bỏ qua gate chỉ
vì UI đã hiện được trang web.
