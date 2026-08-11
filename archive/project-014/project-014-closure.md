# Biên bản đóng Project 014

## Checkpoint Git bất biến

| Mục đích | Branch | Tag | Commit |
| --- | --- | --- | --- |
| Render ổn định trước P014 | `archive/render-stable-2026-08-11` | `render-stable-2026-08-11` | `e44264144cac483b528f7b620a47acdc2f9e736c` |
| Toàn bộ thử nghiệm Oracle/P014 | `archive/project-014-oracle-attempt` | `project-014-oracle-attempt-2026-08-11` | `748bdd4b651ccc5853e5039ff073712febdf26a9` |

Các branch/tag trên đã được push lên `origin` và đối chiếu SHA ngày 11-08-2026.
Không force-push, xóa hoặc tái sử dụng tên các ref này.

## Bằng chứng snapshot P014

- Backend: 218/218 test pass.
- Frontend: 31/31 test pass.
- Frontend ESLint: pass.
- Frontend production build: pass.
- Không phát hiện private key, Mongo URI có credential hoặc API key thật trong phần
  thay đổi được commit.

Đây là bằng chứng chất lượng local của snapshot, không phải bằng chứng Oracle hoặc
production.

## Quy tắc tái sử dụng

Nếu sau này cần Dockerfile, maintenance drain hoặc purge safety của P014, tạo branch
mới từ baseline phù hợp và chọn từng thay đổi sau review. Không merge nguyên branch
P014 vào Render/local production vì nó chứa giả định Oracle, Caddy, DuckDNS và Vercel
legacy notice đã hết hiệu lực.
