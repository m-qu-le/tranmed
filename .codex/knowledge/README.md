# Knowledge base — StudyMed Translator

Ghi chú vận hành dành cho Codex, đã đồng bộ sau khi đóng PROJECT 003 ngày 16-07-2026. Không lưu secret, nội dung `.env`, PDF, prompt/response thô hoặc bản dịch của người dùng.

## Thứ tự đọc

1. `project-map.md` — kiến trúc và bất biến hiện hành.
2. `backend.md` hoặc `frontend.md` — khu vực mã cần sửa.
3. `operations.md` — test, deploy, rollback và Git an toàn.
4. `known-gaps.md` — giới hạn được chấp nhận khi đóng P003.
5. `../../project 003.md` — nguồn sự thật về quyết định, bằng chứng và trạng thái đóng dự án.

Mã nguồn có ưu tiên cao hơn ghi chú. Khi đổi API, schema, biến môi trường, queue, R2 hoặc quality policy, cập nhật thư mục này trong cùng commit.

## Trạng thái đã chốt

- PROJECT 003 đã hoàn thành theo owner waiver; production mặc định `quality`.
- Pipeline hiện hành là `p003-v3` / `p003-prompts-v3`, model `gemini-3.1-flash-lite`.
- PDF được upload trực tiếp từ trình duyệt lên Cloudflare R2; Render chỉ tải một source tạm khi xử lý.
- Quality dùng context passport toàn PDF, chunk 2 trang, thinking `HIGH`, structured audit/verify và tối đa hai repair/reverify.
- Chỉ `PASS` cùng coverage `COMPLETE` mới được tính `passed`; mọi lỗi kể cả minor đều phải repair hoặc thành `needs_review`.
- Không thêm authentication trong phạm vi đã đóng; vẫn phải giữ CORS, rate limit, validation và không lộ secret/dữ liệu người dùng.
