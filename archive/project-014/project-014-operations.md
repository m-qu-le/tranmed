# P014 — Vận hành Oracle A1 sau cutover

> **ARCHIVED — chưa từng trở thành runbook production.** P014 đóng ngày 11-08-2026
> vì không thể tạo/hoàn tất tài khoản Oracle Always Free.

## 1. Deploy qua GitHub Actions

Pipeline đích chạy khi push vào `main` theo chuỗi tuần tự:

```text
Backend tests + Frontend tests/lint/build
  → SSH deploy Oracle (serialized)
  → health/readiness trên loopback
```

- Job deploy chỉ chạy sau khi toàn bộ test pass.
- Workflow dùng concurrency với `cancel-in-progress: false` để hai deploy không chồng
  nhau và tạo hai worker.
- GitHub Actions chỉ giữ secret hạ tầng: SSH host/user/private key/known-hosts.
- VM giữ một deploy key GitHub chỉ-read để clone/pull repository. Application env
  chỉ ở VM, không ở GitHub Secrets.
- Script deploy dừng/drain worker qua maintenance API nội bộ trước build/restart;
  `trap` phải hủy pause nếu deploy lỗi trước khi thay thế thành công.
- Chỉ dùng `git pull --ff-only`; nếu branch không fast-forward, deploy dừng để người
  vận hành kiểm tra thay vì ghi đè thay đổi trên VM.

## 2. Kiểm tra sau mỗi deploy

1. Kiểm tra `GET /api/health` và `GET /api/readiness` tại loopback/hostname.
2. Xem container backend/gateway đều healthy, không restart loop.
3. Kiểm tra log không chứa Mongo authentication/R2 CORS/Gemini configuration error.
4. Nếu deploy thay đổi frontend, mở UI sau Basic Auth và kiểm tra request dùng
   `/api/translate`, không trỏ tới `onrender.com`.
5. Không chạy file PDF thật chỉ để smoke test. Chỉ dùng canary được owner đồng ý.

## 3. Monitoring và cảnh báo

- UptimeRobot free gọi `https://tranmed-api.duckdns.org/api/readiness` và gửi email
  khi status không healthy.
- Oracle Monitoring theo dõi CPU, memory, disk và network. Theo dõi disk đặc biệt vì
  backend tải/cắt PDF tạm thời trên VM.
- Theo dõi chứng chỉ TLS, DuckDNS update timer và container restart count.
- Không đưa token, Mongo URI, Gemini key hay PDF content vào alert/log dashboard.

## 4. Bảo mật và bảo trì định kỳ

- Basic Auth là mandatory cho UI/API nghiệp vụ. Đổi mật khẩu bằng cách tạo hash mới
  trực tiếp trên VM rồi restart gateway; không paste plaintext password vào repo.
- Review Atlas allowlist sau khi Oracle public IP thay đổi. DuckDNS cập nhật hostname
  không tự cập nhật Atlas IP.
- Cập nhật base image/dependency theo đợt có test, không cập nhật nóng trong khi worker
  đang xử lý job.
- Kiểm tra dung lượng Docker images/logs/temp files. Cleanup chỉ nhắm chính xác các
  artifact có thể tái tạo, không dọn bừa volumes hoặc thư mục `/opt/studymed/secrets/`.
- Nếu Oracle cảnh báo reclaim vì idle, xử lý bằng kiểm tra instance/monitoring và
  cân nhắc khởi động lại có kiểm soát; không giả định có bản sao dữ liệu local vì P014
  không bao gồm backup.

## 5. Xử lý sự cố nhanh

| Triệu chứng | Kiểm tra đầu tiên | Không được làm ngay |
| --- | --- | --- |
| UI không mở | DuckDNS IP, Caddy container, port 80/443, certificate | Expose port Node ra Internet |
| `/api/readiness` lỗi | Backend logs, Atlas allowlist, Mongo URI | Reset quota/scheduler state |
| Upload R2 bị browser chặn | R2 CORS origin/method/header, presigned URL | Chuyển upload qua backend không review |
| Job không chạy | Một worker duy nhất, maintenance state, logs/circuit | Tăng concurrency hoặc chạy instance thứ hai |
| Gemini 429 | Quota/circuit persisted state và logs | Clear circuit, thay key hoặc bật diagnostic probe |
| VM mới đổi public IP | Atlas allowlist rồi DuckDNS timer | Khởi động backend trước khi Atlas cho phép IP |

## 6. Ranh giới hỗ trợ của cấu hình free

P014 tối ưu cho một owner và workload nhẹ. Một VM A1 không có HA, không có database
local, không có backup và phụ thuộc dịch vụ ngoài (Atlas, R2, Gemini, DuckDNS). Nếu
hệ thống cần nhiều người dùng, uptime cam kết hoặc dữ liệu không được mất, yêu cầu đó
vượt phạm vi free-only hiện đã chốt và phải được đánh giá thành dự án riêng.
