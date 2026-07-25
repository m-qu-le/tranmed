# Knowledge base — StudyMed Translator

Tài liệu kỹ thuật và vận hành dành cho người sửa hệ thống. Nội dung này được đối chiếu với mã nguồn và bằng chứng vận hành trong workspace ngày 25-07-2026; khi khác nhau, **mã nguồn và cấu hình runtime thực tế luôn ưu tiên**. Không ghi secret, URL presigned, PDF, prompt/response Gemini thô, nội dung bản dịch hoặc dữ liệu MongoDB thật vào đây.

## Hệ thống hiện tại trong một đoạn

StudyMed Translator nhận PDF y khoa, đưa file trực tiếp từ trình duyệt lên Cloudflare R2, ghi trạng thái bền vững vào MongoDB, rồi một backend Express trên Render lấy job từ hàng đợi để dịch sang Markdown tiếng Việt. Mặc định, mỗi job chạy quality pipeline Gemini: tạo ngữ cảnh toàn tài liệu, dịch theo chunk PDF, audit y khoa, revise, verify và tối đa hai vòng repair/reverify. Kết quả được lưu theo chunk trong MongoDB, có thể xem/copy/tải về; các chunk không đạt chuẩn vẫn có kết quả cuối nhưng được gắn `needs_review` và nhận header cảnh báo khi đọc.

## Thứ tự đọc

1. [project-map.md](project-map.md) — sơ đồ thành phần, dữ liệu, luồng và các bất biến xuyên hệ thống.
2. [backend.md](backend.md) — backend, queue, API, schema và quality pipeline.
3. [frontend.md](frontend.md) — React UI, cloud uploader, SSE và luồng kết quả.
4. [local-uploader.md](local-uploader.md) — công cụ upload một chạm, cấu trúc nguồn, ledger chống trùng và recovery.
5. [operations.md](operations.md) — cấu hình, kiểm tra, deploy/redeploy, migration và an toàn dữ liệu.
6. [known-gaps.md](known-gaps.md) — giới hạn đã biết; không diễn giải chúng là tính năng đã hoàn tất.
7. `../../project-011/` — hồ sơ P011 đang mở để theo dõi capacity rollout hậu P012.
8. `../../archive/project-001/` đến `../../archive/project-013/`, trừ P011 đang mở — quyết định và bằng chứng lịch sử. Archive không phải runtime và không thay thế tài liệu này.

## Snapshot kỹ thuật đang áp dụng

| Hạng mục | Giá trị trong mã nguồn |
| --- | --- |
| Backend | Node ESM, Express 5, Mongoose 9, MongoDB, `@aws-sdk` S3/R2 và `@google/genai` 2.13.0 |
| Frontend | React 19, Vite 8, Axios, React Markdown |
| Model fallback | `gemini-3.5-flash-lite` |
| Quality pipeline | `p010-v1`; prompt `p003-prompts-v3`; document context `p003-context-v1` |
| Pipeline mặc định | `quality`; có `legacy` chỉ để rollback/job tương thích |
| Chunk PDF mặc định | 2 trang (`PDF_PAGES_PER_CHUNK`) |
| Gemini thinking | bắt buộc `HIGH`, không gửi thoughts ra client |
| Output ceiling | text 65,536 token; JSON audit/verify/context 16,384 token |
| Worker config code fallback | 5 job song song, source budget 100 MiB; runtime có thể đặt 1–5 và 10–100 MiB |
| Upload browser → R2 | concurrency 4, presigned URL, prepare/confirm idempotent |
| Upload laptop → R2 | BAT/Node CLI, concurrency 4, ledger SHA-256 trong LocalAppData |
| Hạ tầng production | Backend Render Ohio; MongoDB Atlas `tranmed-us-prod` Free/AWS N. Virginia `US_EAST_1`; Cloudflare R2 giữ nguyên |

Các fallback trên không chứng minh cấu hình Render đang chạy. Muốn biết runtime, gọi `/api/translate/status`, `/api/translate/metrics`, `/api/readiness` và endpoint key status theo hướng dẫn trong `operations.md`; không suy đoán từ `.env` local hoặc archive.

## Quy ước cập nhật

- Nếu thay API, schema, biến môi trường, model/SDK Gemini, queue, R2, chính sách quality hay UI state, cập nhật tối thiểu tài liệu liên quan trong thư mục này cùng thay đổi mã.
- Mô tả hành vi public phải dựa vào route/controller/public-view, không dựa vào field private trong MongoDB.
- Không ghi một kết quả smoke/canary cũ thành khẳng định production hiện tại. Ghi rõ đó là bằng chứng lịch sử và thời điểm nếu cần.
- Không tự chạy migration, smoke dùng Gemini, reconcile R2 hoặc thay đổi Render chỉ để “cập nhật tài liệu”. Đây là thao tác vận hành chủ động.

## Trạng thái lịch sử ngắn gọn

P001–P007 đặt nền queue, R2, quality, warning, dashboard và priority. P008 mở rộng code để cấu hình tối đa 5 worker/100 MiB nhưng thử nghiệm 5/100 trên Render Free từng gây tràn bộ nhớ; không xem đó là cấu hình production an toàn. P009 thêm danh mục thư mục toàn cục và lazy-load job theo thư mục. P010 nâng SDK/model lên Gemini 3.5, bỏ `temperature`, tăng text ceiling lên 65,536 và đổi pipeline version thành `p010-v1`. P011 sửa quota dead-time, thêm project-group rotation/global stage dispatcher; dự án vẫn mở cho mục tiêu capacity 5× dài hạn. P012 chủ động bỏ lịch sử giao diện, bootstrap database trắng và cutover MongoDB từ Hong Kong sang N. Virginia; canary ghi nhận Mongo p95 31 ms so với khoảng 598–757 ms trước đó. P013 khắc phục retry storm 429 bằng dispatcher theo current limit, global rate-limit circuit, adaptive project cooldown, gate re-check, persistence qua restart và safe maintenance drain; production nghiệm thu commit `0f739b1` với 225 logical-issued/226 physical, 0 response 429 và amplification 1,0044. Các hồ sơ trong archive chỉ ghi nhận lịch sử, không thay trạng thái live.
