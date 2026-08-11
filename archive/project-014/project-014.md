# PROJECT 014 — Thử nghiệm chuyển StudyMed sang Oracle Always Free

| Thuộc tính | Giá trị |
| --- | --- |
| Mã dự án | `P014` |
| Ngày mở | 09-08-2026 |
| Ngày đóng | 11-08-2026 |
| Trạng thái | **ĐÃ ĐÓNG — KHÔNG TRIỂN KHAI PRODUCTION** |
| Lý do đóng | Không thể tạo/hoàn tất tài khoản Oracle Always Free |
| Render baseline | `e442641` — `Fix quality PDF chunk retry exhaustion` |
| Snapshot code P014 | `748bdd4` — `Archive Project 014 Oracle deployment attempt` |
| Hướng kế tiếp | Project 015 — local-first |

## Kết luận

P014 dừng trước khi có Oracle VM và trước mọi thao tác cutover hoặc purge production.
Code thử nghiệm Docker, Caddy, GitHub Actions, maintenance/purge safety và frontend
legacy notice đã đạt test local, nhưng chưa từng được xác nhận trên Oracle.

Không tiếp tục triển khai từ hồ sơ P014. Toàn bộ nội dung chi tiết được giữ trên
GitHub tại branch `archive/project-014-oracle-attempt` và tag
`project-014-oracle-attempt-2026-08-11`.

Nền code Render đã chạy trước P014 được khóa riêng bằng branch
`archive/render-stable-2026-08-11` và tag `render-stable-2026-08-11`.

## Những việc không xảy ra

- Không tạo Oracle production VM.
- Không chuyển DuckDNS, TLS, Atlas allowlist hoặc R2 CORS sang Oracle production.
- Không chạy script purge P014 trên MongoDB/R2.
- Không xóa Render service trong phạm vi P014.
- Không đưa code Oracle vào `main`.

Xem [biên bản đóng P014](project-014-closure.md) để biết checkpoint và kết quả test.
