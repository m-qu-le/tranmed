# Lưu trữ dự án

Thư mục này chỉ chứa bằng chứng và báo cáo lịch sử của các dự án đã đóng; không được ứng dụng import và không phải nguồn kiến trúc hiện hành.

- `project-001/`, `project-002/`: hồ sơ đóng và quyết định lịch sử của hai dự án nền.
- `project-003/`: hồ sơ đóng, báo cáo benchmark, migration, canary, hiệu năng và smoke đã lọc của PROJECT 003.
- `project-004/`: hồ sơ đóng của cảnh báo kiểm soát chất lượng trong Preview, Copy và Download.
- `project-005/`: hồ sơ đóng của thống kê toàn cục, ẩn batch bền vững và worker hai lane có admission 10 MiB.
- `project-006/`: kế hoạch hardening được archive ở trạng thái retired/superseded; không
  có nghĩa các checklist chưa làm đã hoàn thành hoặc được miễn trừ.
- `project-007/`: hồ sơ đóng của hàng đợi ưu tiên, gồm upload priority, claim tuyệt đối, tương thích ngủ đông và kiểm thử logic/mock.
- `project-008/`: hồ sơ đóng của thử nghiệm worker pool 5 job / source budget 100 MiB; đã rollback cấu hình vì Render Free tràn bộ nhớ và tự restart.
- `project-009/`: hồ sơ đóng của danh mục thư mục toàn cục và lazy-load job theo thư mục; `📌 Ưu tiên` luôn ghim đầu khi còn job.
- `project-010/`: hồ sơ đóng của nâng cấp Gemini 3.5 Flash-Lite, gồm kế hoạch, kiểm chứng key/API, smoke quality và telemetry production hậu deploy.
- `project-011/`: hồ sơ capacity cloud được archive ở trạng thái retired/superseded;
  canary 5 → 6 chưa chạy và mục tiêu throughput 5× không được tuyên bố đạt.
- `project-012/`: hồ sơ P012 đã đóng sau controlled cold start, cutover MongoDB sang
  US East và canary đạt.
- `project-013/`: hồ sơ sự cố Gemini 429 trên Render, bản vá rate-limit circuit,
  adaptive cooldown, safe maintenance drain và nghiệm thu production phục hồi.
- `project-015/`: hồ sơ local-first đã nghiệm thu và đóng; runtime local dùng loopback,
  MongoDB/filesystem trên máy owner, không có fallback web được hỗ trợ.

Kiến trúc, vận hành và giới hạn đang hiệu lực nằm trong `../.codex/knowledge/`.

Trạng thái kiến trúc hiện hành nằm trong `../.codex/knowledge/`. P006 và P011 được
archive theo quyết định owner ngày 23-08-2026 ở trạng thái retired/superseded; việc
archive không xác nhận các kế hoạch/checklist dang dở đã hoàn thành hoặc được miễn trừ.
