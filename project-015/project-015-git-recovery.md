# P015 — Git recovery và đường quay lại web

## Các mốc đã push lên GitHub

| Mốc | Ref | Commit đầy đủ | Ý nghĩa |
| --- | --- | --- | --- |
| Render stable branch | `origin/archive/render-stable-2026-08-11` | `e44264144cac483b528f7b620a47acdc2f9e736c` | Code đã chạy trước P014 |
| Render stable tag | `render-stable-2026-08-11` | `e44264144cac483b528f7b620a47acdc2f9e736c` | Mốc bất biến để tạo nhánh web mới |
| P014 archive branch | `origin/archive/project-014-oracle-attempt` | `748bdd4b651ccc5853e5039ff073712febdf26a9` | Toàn bộ code Oracle thử nghiệm |
| P014 archive tag | `project-014-oracle-attempt-2026-08-11` | `748bdd4b651ccc5853e5039ff073712febdf26a9` | Mốc bất biến của snapshot P014 |

Không force-push hoặc xóa các ref archive/tag. P015 nằm ở branch
`feature/project-015-local-first`; không đưa local-only assumptions vào Render branch.

## Cách tạo đường khôi phục Render an toàn

Không thay đổi working tree đang làm P015. Từ một clone/worktree sạch:

```bash
git fetch origin --tags
git switch -c restore/render-YYYYMMDD origin/archive/render-stable-2026-08-11
```

Sau đó cập nhật dependency/config theo yêu cầu Render hiện hành, chạy toàn bộ test và
deploy canary từ branch `restore/...`. Không deploy trực tiếp tag và không merge toàn
bộ P015 hoặc P014 vào branch restore.

## Chọn thay đổi giữa các dòng phát triển

- Muốn lấy một bug fix chung từ P015 sang web: cherry-pick đúng commit nhỏ sau review.
- Muốn lấy Docker/maintenance từ P014: so sánh/cherry-pick từng commit hoặc file; loại
  bỏ Caddy/DuckDNS/Oracle assumptions.
- Muốn đưa một web fix về local: cherry-pick commit độc lập vào P015 và chạy lại
  local resource/recovery tests.

Mọi lần khôi phục phải ghi ba bằng chứng: commit đầu vào, test result và deployment
target. Tên branch không đủ để chứng minh code đang chạy.
