# Knowledge base — StudyMed Translator

Ghi chú vận hành dành cho Codex, đã đồng bộ sau khi đóng PROJECT 001–005 ngày 18-07-2026 và dọn artifact thử nghiệm. Không lưu secret, nội dung `.env`, PDF, prompt/response thô hoặc bản dịch của người dùng.

## Thứ tự đọc

1. `project-map.md` — kiến trúc và bất biến hiện hành.
2. `backend.md` hoặc `frontend.md` — khu vực mã cần sửa.
3. `operations.md` — test, deploy, rollback và Git an toàn.
4. `known-gaps.md` — giới hạn được chấp nhận khi đóng P003.
5. `../../archive/project-001/project-001.md` đến `../../archive/project-005/project-005.md` — hồ sơ lịch sử đã đóng; P003 là pipeline chất lượng, P004 là lớp cảnh báo đầu ra và P005 là thống kê/worker pool hiện hành.

Mã nguồn có ưu tiên cao hơn ghi chú. Khi đổi API, schema, biến môi trường, queue, R2 hoặc quality policy, cập nhật thư mục này trong cùng commit.

## Trạng thái đã chốt

- PROJECT 001–005 đều đã đóng; P003 là nguồn sự thật của pipeline chất lượng, P004 là nguồn sự thật của cảnh báo Markdown, P005 là nguồn sự thật của thống kê/worker pool, và mã nguồn hiện tại có ưu tiên cao nhất.
- Pipeline hiện hành là `p003-v3` / `p003-prompts-v3`, model `gemini-3.1-flash-lite`.
- PDF được upload trực tiếp từ trình duyệt lên Cloudflare R2; Render chỉ tải một source tạm khi xử lý.
- Quality dùng context passport toàn PDF, chunk 2 trang, thinking `HIGH`, structured audit/verify và tối đa hai repair/reverify.
- Chỉ `PASS` cùng coverage `COMPLETE` mới được tính `passed`; mọi lỗi kể cả minor đều phải repair hoặc thành `needs_review`.
- P004 dựng header rà soát khi trả kết quả cho job quality có `needs_review`; header không được persist vào `TranslationChunk.content`.
- P005 đã đóng: dashboard lấy thống kê toàn cục từ `/jobs/stats`; production cấu hình hai lane, lane thứ hai chỉ được admission khi tổng source active không quá 10 MiB.
- Không thêm authentication trong phạm vi đã đóng; vẫn phải giữ CORS, rate limit, validation và không lộ secret/dữ liệu người dùng.
- `.p003-local`, `.p005-local`, frontend `dist`, asset template và harness/canary một lần đã được xóa. Giữ regression production, migration/backup/reconcile/smoke và báo cáo bằng chứng đã lọc.
