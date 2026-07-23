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

Kiến trúc, vận hành và giới hạn đang hiệu lực nằm trong `../.codex/knowledge/`.
