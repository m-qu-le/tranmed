# Knowledge base — StudyMed Translator

Tài liệu kỹ thuật và vận hành dành cho người sửa hệ thống. Nội dung này được đối
chiếu với code và lịch sử Git trong workspace ngày 23-08-2026; khi khác nhau,
**mã nguồn của branch đang checkout và cấu hình runtime được xác minh luôn ưu tiên**.
Không ghi secret, URL presigned, PDF, prompt/response Gemini thô, nội dung bản dịch
hoặc dữ liệu MongoDB thật vào đây.

## Hệ thống hiện tại trong một đoạn

P015 đã chuyển runtime mặc định sang local-first: Express và frontend production chỉ
bind `127.0.0.1`, MongoDB/filesystem local giữ queue và source, còn Gemini vẫn chạy qua
Internet. Owner đã nghiệm thu local runtime ngày 23-08-2026. Cloud Render/R2/Atlas vẫn
còn trong code cho tương thích lịch sử, nhưng Render đang suspended và P015 không duy
trì fallback web. P014 Oracle vẫn là snapshot chưa deploy.

## Thứ tự đọc

1. [project-map.md](project-map.md) — sơ đồ thành phần, dữ liệu, luồng và các bất biến xuyên hệ thống.
2. [backend.md](backend.md) — backend, queue, API, schema và quality pipeline.
3. [frontend.md](frontend.md) — React UI, cloud uploader, SSE và luồng kết quả.
4. [local-uploader.md](local-uploader.md) — công cụ upload một chạm, cấu trúc nguồn, ledger chống trùng và recovery.
5. [operations.md](operations.md) — cấu hình, kiểm tra, deploy/redeploy, migration và an toàn dữ liệu.
6. [known-gaps.md](known-gaps.md) — giới hạn đã biết; không diễn giải chúng là tính năng đã hoàn tất.
7. `../../archive/project-015/` — hồ sơ local-first đã đóng, gồm quyết định nghiệm thu và
   giới hạn vận hành còn hiệu lực.
8. `../../archive/project-011/` — hồ sơ capacity đã retired; không rollout lại giả định cũ.
9. `../../archive/project-001/` đến `../../archive/project-015/` —
   quyết định và bằng chứng lịch sử. Archive không phải runtime.

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
| Worker config | 3 job song song; cloud fallback 15 MiB, local fallback 48 MiB; local owner dùng 50 MiB |
| Upload browser → R2 | concurrency 4, presigned URL, prepare/confirm idempotent |
| Upload laptop → R2 | BAT/Node CLI, concurrency 4, ledger SHA-256 trong LocalAppData |
| Trạng thái hosting | Render suspended; Oracle P014 không deploy; P015 local đã được owner nghiệm thu |
| P015 archive | Native Node + frontend static + MongoDB/filesystem local trên Windows, loopback-only, Gemini qua Internet |

Không có endpoint cloud live nào hiện được coi là source of truth. Endpoint status chỉ
có giá trị khi local runtime cụ thể được khởi động và xác minh. Không suy đoán từ
`.env`, Render URL cũ hoặc tài liệu archive.

## Quy ước cập nhật

- Nếu thay API, schema, biến môi trường, model/SDK Gemini, queue, R2, chính sách quality hay UI state, cập nhật tối thiểu tài liệu liên quan trong thư mục này cùng thay đổi mã.
- Mô tả hành vi public phải dựa vào route/controller/public-view, không dựa vào field private trong MongoDB.
- Không ghi một kết quả smoke/canary cũ thành khẳng định production hiện tại. Ghi rõ đó là bằng chứng lịch sử và thời điểm nếu cần.
- Không tự chạy migration, smoke dùng Gemini, reconcile/purge R2, cài MongoDB local
  hoặc thay đổi dịch vụ chỉ để “cập nhật tài liệu”. Đây là thao tác vận hành chủ động.

## Trạng thái lịch sử ngắn gọn

P001–P007 đặt nền queue, R2, quality, warning, dashboard và priority. P008 từng thử
5 worker/100 MiB trên Render Free và gây tràn bộ nhớ; code hiện đã khóa 1–3 worker,
fallback 3, budget cloud 15 MiB và budget local 48 MiB. P009–P013 bổ sung folder/lazy loading, Gemini
3.5 quality pipeline, project scheduler, Mongo US East và containment retry storm.
Render stable trước P014 được khóa tại commit `e442641`, branch/tag
`archive/render-stable-2026-08-11` / `render-stable-2026-08-11`. P014 Oracle đóng vì
không tạo được tài khoản; snapshot chưa deploy nằm tại `748bdd4`, branch/tag archive
tương ứng. P015 được nghiệm thu và đóng ngày 23-08-2026; tag delivery bất biến là
`project-015-local-first-2026-08-23`, còn tag tổ chức hồ sơ archive là
`project-015-archive-2026-08-23`.
