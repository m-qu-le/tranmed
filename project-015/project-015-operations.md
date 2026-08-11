# P015 — Vận hành local trên Windows

## Startup profile

- Chạy native Node, production frontend build; không dùng Vite dev server thường trực.
- Backend bind `127.0.0.1` và chỉ mở browser sau `/api/readiness` thành công.
- Process backend dùng priority `BelowNormal`; một PID lock ngăn launcher trùng.
- Secret nằm trong local env file đã gitignore, không đặt trong shortcut hoặc command
  line để tránh lộ qua process list.
- Data root đề xuất `D:\StudyMedData`, tách khỏi repository để đổi branch không đụng dữ liệu.

Task Scheduler tự khởi động lúc đăng nhập là tùy chọn sau khi manual start/stop đạt
gate. Không chạy app trên pin theo mặc định nếu owner muốn tránh nhiệt/hao pin.

## Shutdown, sleep và mất điện

Shutdown bình thường đi qua maintenance drain. Nếu Windows sleep hoặc process bị kill,
lease/token trong database quyết định recovery; stage chỉ được chạy lại khi artifact
chưa persist. Temp `.part` không được coi là source hợp lệ.

Sau wake/restart:

1. Kiểm tra data root và database.
2. Cleanup orphan temp theo grace period.
3. Recover lease hết hạn.
4. Re-arm quota/circuit/retry timers.
5. Chỉ claim job khi resource governor ở `normal`.

## Bảo vệ máy người dùng

- Trần 50% RAM áp dụng cho toàn bộ runtime P015; target vận hành thấp hơn trần.
- Khi Chrome/VS Code hoặc hệ thống tạo CPU pressure, worker tự pause nhận việc mới.
- Không xóa giới hạn dung lượng; thay bằng disk reserve theo dung lượng thật.
- Log có rotation và tổng quota; không để file log tăng không giới hạn trên ổ D.
- Windows Defender có thể scan PDF/temp và gây CPU; chỉ cân nhắc exclusion cho đúng
  data root sau đánh giá security, không loại trừ cả ổ D hoặc repository.

## Dữ liệu và phục hồi

P015 không tự xóa cloud data cũ. Database local mới và source local không phải backup.
Nếu owner vẫn chọn không backup kết quả, UI/tài liệu phải ghi rõ dữ liệu mất khi ổ đĩa
hỏng. Git chỉ bảo vệ code, không bảo vệ PDF, queue hoặc kết quả local.

Không dùng `git reset --hard` để đổi giữa local và web. Dừng app, xác nhận working tree
sạch rồi tạo working directory/branch riêng từ checkpoint mong muốn.
