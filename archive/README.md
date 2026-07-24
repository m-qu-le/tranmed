# Lưu trữ dự án

Thư mục này chỉ chứa bằng chứng và báo cáo lịch sử của các dự án đã đóng; không được ứng dụng import và không phải nguồn kiến trúc hiện hành.

- `project-001/`, `project-002/`: hồ sơ đóng và quyết định lịch sử của hai dự án nền.
- `project-003/`: hồ sơ đóng, báo cáo benchmark, migration, canary, hiệu năng và smoke đã lọc của PROJECT 003.
- `project-004/`: hồ sơ đóng của cảnh báo kiểm soát chất lượng trong Preview, Copy và Download.
- `project-005/`: hồ sơ đóng của thống kê toàn cục, ẩn batch bền vững và worker hai lane có admission 10 MiB.
- `project-007/`: hồ sơ đóng của hàng đợi ưu tiên, gồm upload priority, claim tuyệt đối, tương thích ngủ đông và kiểm thử logic/mock.
- `project-008/`: hồ sơ đóng của thử nghiệm worker pool 5 job / source budget 100 MiB; đã rollback cấu hình vì Render Free tràn bộ nhớ và tự restart.
- `project-009/`: hồ sơ đóng của danh mục thư mục toàn cục và lazy-load job theo thư mục; `📌 Ưu tiên` luôn ghim đầu khi còn job.
- `project-010/`: hồ sơ đóng của nâng cấp Gemini 3.5 Flash-Lite, gồm kế hoạch, kiểm chứng key/API, smoke quality và telemetry production hậu deploy.
- `project-012/`: hồ sơ P012 đã đóng sau controlled cold start, cutover MongoDB sang
  US East và canary đạt.
- `project-013/`: hồ sơ sự cố Gemini 429 trên Render, bản vá rate-limit circuit,
  adaptive cooldown, safe maintenance drain và nghiệm thu production phục hồi.

Kiến trúc, vận hành và giới hạn đang hiệu lực nằm trong `../.codex/knowledge/`.

Trạng thái kiến trúc hiện hành nằm trong `../.codex/knowledge/`. Cluster MongoDB Hong
Kong của P012 vẫn phải được giữ hết rollback window 7–14 ngày và qua ít nhất hai batch
thật; đây là công việc vận hành sau đóng dự án, không phải lý do để giữ hồ sơ P012 ở
thư mục gốc. P011 đã được mở lại ngày 24-07-2026 và nằm tại
`../project-011/project-011.md`; không dùng bản ghi archive cũ làm trạng thái hiện hành.
`project 006.md` vẫn là kế hoạch hardening cũ ở thư mục gốc; P011/P012 không ngầm đóng
hoặc archive kế hoạch đó.
