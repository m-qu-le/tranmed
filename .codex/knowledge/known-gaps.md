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
- Code hiện nhận 1–3 source job, fallback 3 và source budget fallback 15 MiB (accepted
  10–100). Đây là cloud baseline, chưa phải local resource profile P015.
- Runtime resource snapshot hiện chỉ quan sát process RSS/event-loop/Mongo latency;
  chưa throttle theo available RAM/system CPU, chưa enforce trần 50% RAM và chưa
  serialize PDF split. Node heap limit cũng không bao phủ Buffer/native/worker memory.
- PDF worker đọc toàn file rồi giữ các chunk buffers. Upload cap code hiện 350 MB,
  trong khi workload P015 được chốt quanh 10 MB và target upload gate là 159 MB;
  target này chưa được triển khai hoặc chứng minh cho PDF sát trần.
- Gemini AbortSignal không đảm bảo Google ngừng tính usage nếu request đã đến dịch vụ. Circuit breaker/key scheduler giảm retry vô ích nhưng không loại bỏ chi phí đó.

## Chuyển đổi P015 chưa hoàn thành

- Render đang suspended; không có production backend đang hoạt động được xác minh.
- P014 Oracle đã đóng mà không deploy. Không sử dụng Docker/Caddy/Oracle snapshot như
  runtime hiện hành.
- P015 mới có plan tại commit `3b0d9a4`. Code chưa có `RUNTIME_MODE`, `APP_HOST`,
  `DATA_ROOT`, local storage adapter, MongoDB local profile, resource governor,
  launcher/PID lock hoặc graceful Windows shutdown flow.
- Backend vẫn bind `0.0.0.0`, validate R2 là required và frontend vẫn fallback Render.
  Chạy code hiện tại trên laptop không tương đương P015 và có thể expose API ra LAN.
- Máy chưa cài MongoDB local. Cài/config service, loopback binding, cache cap và data
  root là thay đổi hệ thống cần được thực hiện trong P015, không tự làm khi đọc docs.

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
