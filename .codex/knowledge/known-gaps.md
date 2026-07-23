# Giới hạn, rủi ro và quyết định còn hiệu lực

Danh sách này mô tả những gì hệ thống **chưa** đảm bảo. Không dùng nó để nới quality guard, bỏ qua test hay khẳng định một miễn trừ lịch sử đã được khắc phục.

## Chất lượng dịch và review

- Quality pipeline là self-audit bằng AI. `passed` chỉ nghĩa là final verify report trả PASS với coverage complete theo validator; nó không chứng minh bản dịch y khoa không còn sai sót.
- `needs_review` là tín hiệu phải có người có chuyên môn đối chiếu PDF gốc, bản dịch, phạm vi trang và header P004. Người dùng vẫn có thể tải Markdown cuối, nên warning không được bị ẩn hoặc diễn giải thành “đã xác minh hoàn toàn”.
- Context passport cải thiện nhất quán xuyên chunk nhưng không phải glossary/translation memory tuyệt đối. Chunk PDF vẫn là bằng chứng quyết định.
- P010 đã có smoke/key/runtime telemetry nhưng không hoàn tất reviewer corpus chuyên môn độc lập, quan sát production đủ 24 giờ hoặc rollback drill production. Đây là rủi ro owner đã chấp nhận khi đóng P010, không phải validation đã chạy.
- Text output 65,536 token giảm nguy cơ cắt ngắn nhưng có thể làm request dài hơn timeout 180 giây. Không tự giảm thinking/chunk guard để che timeout; điều tra PDF/chunk/load/quota trước.

## Năng lực runtime

- Source-size budget chỉ là proxy bảo thủ cho memory, không đo RSS/CPU/Gemini load. P008 từng làm Render Free (512 MB/0.1 CPU theo hồ sơ lịch sử) tràn bộ nhớ ở cấu hình 5 worker/100 MiB.
- Code fallback 5/100 tồn tại để cho phép cấu hình, không phải recommended production. Runtime worker/budget phải được quyết định từ status, giới hạn hạ tầng và kiểm chứng mới.
- Không có load test đủ lớn, theo dõi concurrency dài hạn, metric RAM/CPU chính thức hay canary hai PDF lớn sau P008. Nếu cần nâng capacity, mở công việc riêng với đo đạc, staged rollout và rollback.
- Gemini AbortSignal không đảm bảo Google ngừng tính usage nếu request đã đến dịch vụ. Circuit breaker/key scheduler giảm retry vô ích nhưng không loại bỏ chi phí đó.

## Sản phẩm và an toàn truy cập

- Không có authentication/authorization người dùng theo quyết định hiện tại. Endpoint public phải tiếp tục giữ CORS allow-list, upload rate limit, size/PDF validation, public-view redaction và không log dữ liệu nhạy cảm.
- Không có quota/user isolation. MongoDB/R2 share dữ liệu công việc theo deployment; vì vậy không mở rộng thành dịch vụ đa người dùng/nhạy cảm mà không thiết kế auth, ownership, retention/audit và abuse controls.
- Priority là tuyệt đối: nếu priority job đến liên tục, normal job có thể starve vô hạn. Chỉ đổi sang quota/fairness sau khi có yêu cầu sản phẩm rõ ràng, vì đây là thay đổi scheduling semantics.
- Frontend chưa có e2e thực cho SSE reconnect, cancel mid-flight, retry/abandon R2 và File System Access download. Unit/component test không thay thế browser/network verification ở các luồng này.

## Vận hành và lifecycle dữ liệu

- SSE có thể mất/reorder. HTTP resync là bắt buộc; không thêm feature phụ thuộc hoàn toàn vào event stream.
- Source R2 của failed job được giữ có hạn để retry. Điều đó là trade-off recovery vs retention; cần cấu hình R2 lifecycle là safety net phù hợp với `R2_SOURCE_RETENTION_DAYS`, nhưng app cleanup vẫn là cơ chế chính.
- Source cleanup có retry, nhưng retry backlog/R2 outage có thể khiến object tồn tại lâu hơn dự kiến. Theo dõi `storage.cleanupBacklog`, source cleanup SSE/metrics và R2 lifecycle khi vận hành.
- Maintenance pause chỉ sống trong process. Nó không phải distributed deploy lock, không ngăn browser đã có presigned URL upload, và không thay thế kiểm active jobs trước deploy.
- Metrics hiện in-memory và reset khi Render restart; không có backend observability retention/alerting dài hạn. `/metrics` hữu ích cho snapshot, không phải time-series source of truth.

## Khoản nợ mã nguồn

- `frontend/src/App.jsx` lớn, nhiều inline style và `alert/confirm`. Chỉ tách khi có ranh giới behavior/test rõ; đừng làm refactor rộng cùng sửa tính năng nhỏ.
- Preview/copy ghép result trong memory; download API stream chunk, nhưng trải nghiệm browser/folder download tài liệu rất lớn vẫn có giới hạn RAM/I/O.
- API summary pagination dùng ObjectId cursor và folder lazy-load. Mọi tính năng bulk/dashboard mới phải phân biệt page đã tải với toàn bộ collection/folder.
- Legacy path vẫn tồn tại để rollback/tương thích. Khi thay đổi schema/result/API, phải duy trì khả năng đọc job legacy hoặc có migration/compatibility plan được phê duyệt.

## Không tự nối thêm phạm vi

Authentication, human-review workflow, glossary/translation memory, distributed worker coordination, fairness priority, monitoring/alerting dài hạn, load benchmark hoặc capacity rollout là các dự án riêng. Không âm thầm đưa chúng vào patch sửa tài liệu/bug nhỏ.
