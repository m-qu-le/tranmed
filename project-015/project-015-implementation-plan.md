# P015 — Kế hoạch triển khai một lần

## Nguyên tắc bàn giao

P015 có một bản bàn giao hoàn chỉnh, không đưa owner qua nhiều bản local thử nghiệm.
Các workstream dưới đây có thể được phát triển riêng để review, nhưng chỉ cutover khi
toàn bộ chức năng đã tích hợp và qua một đợt nghiệm thu cuối.

## Workstream 1 — Bảo toàn lịch sử Git

- Xác minh branch/tag Render và P014 trên origin theo `project-015-git-recovery.md`.
- Tạo/push `feature/project-015-local-first` từ `main` sau commit hồ sơ P015.
- Không phát triển local trực tiếp trên archive branch hoặc tag.
- Ghi baseline test trước thay đổi: backend, frontend test/lint/build.

## Workstream 2 — Bê nguyên ứng dụng về local

1. Thêm config `APP_HOST`, `RUNTIME_MODE` và `DATA_ROOT`; local bắt buộc host
   `127.0.0.1` và từ chối `0.0.0.0` nếu chưa bật explicit LAN mode.
2. Build frontend production và để Express phục vụ static SPA cùng origin.
3. Giữ toàn bộ API, SSE, priority, retry/resume, quality pipeline, result/download và
   Gemini quota/circuit đang có trên Render.
4. Frontend upload trực tiếp tới localhost. File được ghi qua `.part`, kiểm tra
   magic bytes/size/hash rồi atomic rename vào data root trên ổ D.
5. Thêm storage adapter `local`; cleanup chỉ được thao tác bên dưới data root đã
   resolve và từ chối symlink/junction/path traversal.
6. Cài MongoDB Community bind loopback, dùng database P015 mới, rỗng và giới hạn
   WiredTiger cache. Không import/xóa Atlas hoặc R2 production.
7. Giữ `cloud` adapter/config trong code để sau này tạo branch deploy web, nhưng nó
   không nằm trên runtime local mặc định.

## Workstream 3 — Giữ đủ throughput mà máy vẫn mượt

1. Giữ ba source lane như Render và `PARALLEL_SOURCE_BUDGET_MB=48` cho workload PDF
   khoảng 10 MB; PDF lớn hơn budget được chạy đơn độc.
2. Serialize thao tác parse/split PDF để không để hai worker CPU-heavy giành cả hai core.
3. Mở rộng resource snapshot bằng available RAM và sampled CPU; thêm state machine
   `normal → pressured → suspended → recovering` có hysteresis.
4. Khi pressure, ngừng claim lane mới nhưng cho Gemini stage đang chạy persist an
   toàn. Hard pressure terminate PDF split và đánh dấu resource-blocked, không retry storm.
5. Node chạy với old-space target 1,5–2 GB và Windows priority `BelowNormal`.
6. Thay quota disk 400 MB bằng free-space gate, giữ tối thiểu 10 GB trống trên ổ D.
7. `MAX_FILE_SIZE_MB=159`; UI cảnh báo file trên 25 MB có thể cần chạy đơn độc hoặc
   bị resource governor từ chối nếu cấu trúc PDF làm RAM tăng quá cao.

## Workstream 4 — Trải nghiệm như một ứng dụng local

1. Tạo launcher Windows có PID lock, start Mongo + backend, chờ readiness rồi mở UI.
2. Launcher không đưa secret vào command line, chạy backend `BelowNormal`, xoay log
   và có lệnh stop rõ ràng.
3. Shutdown handler dừng claim, persist/suspend ở stage boundary, đóng Mongo và cleanup
   temp an toàn.
4. Sau sleep/restart, recover lease, quota/circuit/timer rồi mới claim job.

## Một đợt nghiệm thu cuối

- Chạy toàn bộ backend tests và frontend test/lint/build.
- Upload/dịch một PDF đại diện khoảng 10 MB qua UI tới kết quả/download hoàn chỉnh.
- Upload một batch nhiều PDF khoảng 10 MB để chứng minh ba lane và resource governor.
- Dừng ứng dụng giữa job, khởi động lại và xác minh không lặp stage đã persist.
- Dùng Chrome/VS Code trong lúc dịch; xác nhận RSS/CPU/disk không vượt gate và máy
  không lag rõ rệt.
- Xác nhận app vẫn hoạt động khi Atlas/R2/Render không khả dụng.
- Rehearse tạo branch web mới từ tag Render mà không sửa/xóa P015 data.

Sau khi tất cả pass, tạo shortcut chính thức và cutover local. Không xóa Atlas/R2 hoặc
lịch sử Render; cleanup cloud là quyết định destructive riêng ngoài P015.
