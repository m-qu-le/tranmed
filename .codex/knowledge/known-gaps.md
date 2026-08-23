# Giới hạn, rủi ro và quyết định còn hiệu lực

Danh sách này mô tả những gì hệ thống **chưa** đảm bảo. Không dùng nó để nới quality guard, bỏ qua test hay khẳng định một miễn trừ lịch sử đã được khắc phục.

## Chất lượng dịch và review

- Quality pipeline là self-audit bằng AI. `passed` chỉ nghĩa là final verify report trả PASS với coverage complete theo validator; nó không chứng minh bản dịch y khoa không còn sai sót.
- `needs_review` là tín hiệu phải có người có chuyên môn đối chiếu PDF gốc, bản dịch, phạm vi trang và header P004. Người dùng vẫn có thể tải Markdown cuối, nên warning không được bị ẩn hoặc diễn giải thành “đã xác minh hoàn toàn”.
- Context passport cải thiện nhất quán xuyên chunk nhưng không phải glossary/translation memory tuyệt đối. Chunk PDF vẫn là bằng chứng quyết định.
- P010 đã có smoke/key/runtime telemetry nhưng không hoàn tất reviewer corpus chuyên môn độc lập, quan sát production đủ 24 giờ hoặc rollback drill production. Đây là rủi ro owner đã chấp nhận khi đóng P010, không phải validation đã chạy.
- Text output 65,536 token giảm nguy cơ cắt ngắn nhưng có thể làm request dài hơn timeout 180 giây. Không tự giảm thinking/chunk guard để che timeout; điều tra PDF/chunk/load/quota trước.

## Năng lực runtime

- Source-size budget vẫn chỉ là proxy bảo thủ. Local P015 bổ sung RSS/available-RAM/
  system-CPU governor, nhưng Node heap limit không bao phủ Buffer/native/worker memory
  và threshold phải được benchmark trên máy owner.
- Local default giữ 1–3 source lanes, source budget 48 MiB, serialize PDF parse/copy và
  materialize một chunk/lane. Điều này giảm peak memory, không phải chứng minh file
  159 MB luôn xử lý được trên máy 8 GB RAM.
- Gemini AbortSignal không đảm bảo Google ngừng tính usage nếu request đã đến dịch vụ. Circuit breaker/key scheduler giảm retry vô ích nhưng không loại bỏ chi phí đó.

## P015 đã đóng — giới hạn còn hiệu lực

- Render đang suspended; không có production backend đang hoạt động được xác minh.
- P014 Oracle đã đóng mà không deploy. Không sử dụng Docker/Caddy/Oracle snapshot như
  runtime hiện hành.
- Code có `RUNTIME_MODE`, loopback-only `APP_HOST`, `DATA_ROOT`, local storage adapter,
  governor và launcher/PID lock/safe drain. Cloud vẫn phải đặt explicit
  `RUNTIME_MODE=cloud`.
- MongoDB local, `.env.local`, launcher và workload thật đã được owner nghiệm thu ngày
  23-08-2026 với PDF khoảng 10 MB, batch, sleep/restart và Chrome/VS Code song song.
  Không có benchmark timing/RSS chi tiết, nên không suy diễn kết quả này thành bảo đảm
  hiệu năng cho mọi loại PDF hoặc phần cứng khác.
- Owner không cần fallback web và đã loại rollback rehearsal khỏi tiêu chí P015. Render
  suspended và ref P014/Render được giữ làm lịch sử bất biến, không phải phương án
  khôi phục đã được kiểm chứng.

## Sản phẩm và an toàn truy cập

- Không có authentication/authorization người dùng. Cloud deployment phải tiếp tục
  giữ CORS/rate limit/validation/redaction. P015 chỉ được miễn auth khi đã chứng minh
  mọi socket bind loopback; mở LAN/public là dự án security riêng.
- Không có quota/user isolation. MongoDB/R2 share dữ liệu công việc theo deployment; vì vậy không mở rộng thành dịch vụ đa người dùng/nhạy cảm mà không thiết kế auth, ownership, retention/audit và abuse controls.
- Priority là tuyệt đối: nếu priority job đến liên tục, normal job có thể starve vô hạn. Chỉ đổi sang quota/fairness sau khi có yêu cầu sản phẩm rõ ràng, vì đây là thay đổi scheduling semantics.
- Frontend chưa có e2e thực cho SSE reconnect, cancel mid-flight, retry/abandon R2 và File System Access download. Unit/component test không thay thế browser/network verification ở các luồng này.

## Vận hành và lifecycle dữ liệu

- SSE có thể mất/reorder. HTTP resync là bắt buộc; không thêm feature phụ thuộc hoàn toàn vào event stream.
- Source R2 của failed job được giữ có hạn để retry. Điều đó là trade-off recovery vs retention; cần cấu hình R2 lifecycle là safety net phù hợp với `R2_SOURCE_RETENTION_DAYS`, nhưng app cleanup vẫn là cơ chế chính.
- Source cleanup có retry, nhưng retry backlog/R2 outage có thể khiến object tồn tại lâu hơn dự kiến. Theo dõi `storage.cleanupBacklog`, source cleanup SSE/metrics và R2 lifecycle khi vận hành.
- Maintenance pause chỉ sống trong process và không phải distributed deploy lock.
  Sau P013 nó safe-drain Gemini tại ranh giới stage, nhưng vẫn không ngăn browser đã
  có presigned URL upload và không thay thế kiểm `maintenanceState=drained`, active
  stage/job cùng Mongo processing trước deploy.
- Metrics hiện in-memory và reset khi process restart; không có observability
  retention/alerting dài hạn. `/metrics` hữu ích cho snapshot, không phải time-series
  source of truth.
- P013 chứng minh production phục hồi với 0/225 response 429 sau bản vá, nhưng không
  xác định được quota dimension upstream đã gây burst ban đầu. Circuit giảm
  amplification khi tái phát; nó không tạo thêm quota và không chứng minh source/IP
  enforcement nếu chỉ nhìn một response generic.
- Hồ sơ vận hành gần nhất ghi Atlas IP Access List `0.0.0.0/0` và user
  `tranmed_app` có `readWriteAnyDatabase@admin`; trạng thái này chưa được re-verify
  ngày 11-08-2026. Nếu cloud mode được dùng lại, kiểm tra và thu hẹp trước deploy.
- Git checkpoint chỉ bảo vệ code. Atlas/R2 cũ và database/source/result local tương
  lai không được backup bởi branch/tag; owner đã chấp nhận không backup work history,
  nhưng UI/runbook không được gọi dữ liệu local là recoverable.

## Khoản nợ mã nguồn

- `frontend/src/App.jsx` lớn, nhiều inline style và `alert/confirm`. Chỉ tách khi có ranh giới behavior/test rõ; đừng làm refactor rộng cùng sửa tính năng nhỏ.
- Preview/copy ghép result trong memory; download API stream chunk, nhưng trải nghiệm browser/folder download tài liệu rất lớn vẫn có giới hạn RAM/I/O.
- API summary pagination dùng ObjectId cursor và folder lazy-load. Mọi tính năng bulk/dashboard mới phải phân biệt page đã tải với toàn bộ collection/folder.
- Legacy path vẫn tồn tại để rollback/tương thích. Khi thay đổi schema/result/API, phải duy trì khả năng đọc job legacy hoặc có migration/compatibility plan được phê duyệt.

## Không tự nối thêm phạm vi

Authentication cho LAN/public, human-review workflow, glossary/translation memory,
distributed worker coordination, fairness priority và monitoring/alerting dài hạn là
các dự án riêng. P015 resource governor/launcher/local storage/database là phạm vi đã
được chốt, nhưng không âm thầm triển khai chúng trong patch tài liệu/bug khác.
