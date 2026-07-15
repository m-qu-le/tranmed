# Knowledge base — StudyMed Translator

Ghi chú vận hành dành cho Codex, đã đối chiếu với mã nguồn Project 001 ngày 15-07-2026. Không lưu secret, nội dung `.env`, PDF hoặc bản dịch của người dùng.

## Thứ tự đọc

1. `project-map.md` để hiểu mục tiêu, cấu trúc và luồng tổng thể.
2. `backend.md` hoặc `frontend.md` tùy khu vực đang sửa.
3. `operations.md` trước khi chạy migration, test hoặc deploy.
4. `known-gaps.md` để không vô tình coi phần chưa kiểm chứng là đã hoàn tất.
5. `../../project 001.md` là hồ sơ theo dấu chi tiết và nguồn sự thật về tiến độ đại tu.

Mã nguồn có ưu tiên cao hơn ghi chú. Khi đổi API, schema, biến môi trường, queue hoặc chính sách lưu file, phải cập nhật thư mục này trong cùng thay đổi.

## Quyết định đã chốt

- Ứng dụng cá nhân, không thêm đăng nhập/phân quyền trong Project 001 theo quyết định của chủ dự án.
- Render chỉ có khoảng 500 MB và filesystem không bền vững; trình duyệt giữ hàng trăm chương trong Local Feeder, backend chỉ nhận một PDF tại một thời điểm.
- MongoDB giữ metadata và từng chunk Markdown; PDF nguồn trên Render chỉ là dữ liệu tạm.
- Không ghi API key, URI MongoDB hay dữ liệu người dùng vào Git/log/tài liệu.
