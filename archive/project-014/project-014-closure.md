# Đóng Project 014 — Oracle Always Free

| Thuộc tính | Giá trị |
| --- | --- |
| Ngày đóng | 11-08-2026 |
| Kết quả | **DỪNG, KHÔNG TRIỂN KHAI** |
| Lý do | Không thể tạo/hoàn tất tài khoản Oracle Always Free |
| Production thay đổi | Không |
| Purge dữ liệu | Không chạy |
| Hướng kế tiếp | Project 015 — local-first |

## Những gì đã hoàn thành

- Thiết kế Oracle A1 2 OCPU / 6 GB RAM / 50 GB disk.
- Dockerfile backend, Docker Compose, Caddy gateway và frontend build cùng origin.
- GitHub Actions test rồi SSH deploy Oracle.
- Cơ chế `WORKER_ENABLED=false`, maintenance drain và purge P014 có hai lớp xác nhận.
- Frontend legacy notice cho Vercel.
- Snapshot kết thúc đạt 218 backend tests, 31 frontend tests, frontend lint và build.

## Những gì chưa xảy ra

- Không có Oracle instance production.
- Không có hostname/TLS Oracle production.
- Không chuyển Atlas allowlist hoặc R2 CORS sang Oracle production.
- Không xóa `Job`, `TranslationChunk`, `UploadBatch` hoặc R2 `incoming/` bằng script P014.
- Không xóa Render service trong phạm vi P014.

## Điểm khôi phục Git

| Mục đích | Branch | Tag |
| --- | --- | --- |
| Code Render ổn định trước P014 | `archive/render-stable-2026-08-11` | `render-stable-2026-08-11` |
| Toàn bộ code/thư mục thử nghiệm P014 | `archive/project-014-oracle-attempt` | `project-014-oracle-attempt-2026-08-11` |

Không merge snapshot Oracle vào một deployment web mới theo kiểu nguyên khối. Nếu
cần dùng lại Docker/purge/maintenance, chọn từng commit/file sau review trên một
branch mới xuất phát từ mốc Render ổn định.
