# PROJECT 015 — StudyMed Local-first

| Thuộc tính | Giá trị |
| --- | --- |
| Mã dự án | `P015` |
| Ngày mở | 11-08-2026 |
| Trạng thái | **KẾ HOẠCH — CHƯA TRIỂN KHAI** |
| Mục tiêu | Chạy frontend, API và worker trên máy Windows của owner, giữ máy phản hồi tốt và không phụ thuộc hosting web |
| Nhánh triển khai dự kiến | `feature/project-015-local-first` |
| Nền code | Render stable `e442641` |
| Kiến trúc | [project-015-architecture.md](project-015-architecture.md) |
| Kế hoạch triển khai | [project-015-implementation-plan.md](project-015-implementation-plan.md) |
| Vận hành local | [project-015-operations.md](project-015-operations.md) |
| Khôi phục web/Git | [project-015-git-recovery.md](project-015-git-recovery.md) |

## 1. Mục tiêu sản phẩm

Owner mở StudyMed trên chính máy tính, tải PDF từ ổ đĩa, để ứng dụng dịch trong nền
và tiếp tục dùng Chrome/VS Code hoặc ứng dụng văn phòng mà không bị lag rõ rệt. Máy
có thể tắt/ngủ; queue phải tiếp tục an toàn sau lần khởi động kế tiếp.

“Local” trong P015 có nghĩa frontend, Node API, PDF worker, source file và database
công việc mới có thể chạy/lưu trên máy. Gemini vẫn là dịch vụ Internet, nên P015
không phải chế độ dịch offline.

## 2. Hardware baseline ngày 11-08-2026

| Tài nguyên | Quan sát |
| --- | --- |
| Máy | ASUS VivoBook X515EAU/R565EA |
| CPU | Intel Core i3-1115G4, 2 core / 4 logical processor |
| RAM | 8 GB lắp đặt, khoảng 7,7 GB hệ thống báo cáo |
| Ổ C | 118,5 GB, còn khoảng 17,1 GB |
| Ổ D | 118,4 GB, còn khoảng 30,0 GB |
| Runtime | Node/npm và Git có sẵn; Docker/MongoDB local chưa cài |

P015 dùng native Node trên Windows. Không cài Docker Desktop cho baseline vì overhead
không có lợi trên máy 8 GB RAM.

## 3. Bất biến an toàn

- Chỉ listen trên `127.0.0.1`; không expose API ra LAN/Internet.
- Giữ tối đa ba source lane như Render để không làm mất năng lực hiện có. PDF splitting
  được serialize và resource governor có quyền tạm giảm admission khi máy bị áp lực.
- Giới hạn 50% RAM của owner là trần tuyệt đối, không phải mục tiêu sử dụng thường xuyên.
- P013 quota/circuit và quality pipeline hiện hành vẫn là safety authority; migration
  local không reset hoặc nới Gemini scheduler.
- Không chạy purge P014. Cloud data cũ không bị xóa trong P015 nếu chưa có yêu cầu
  riêng và xác nhận destructive mới.
- P015 phát triển trên branch riêng; checkpoint Render không được sửa hoặc force-push.

## 4. Phạm vi bản P015 đầu tiên

P015 không chia thành nhiều bản nâng cấp nhỏ. Bản bàn giao đầu tiên phải chuyển trọn
năng lực ứng dụng từ Render về máy:

- frontend production, API, queue, priority, retry/resume, quality pipeline, SSE và
  download kết quả đều chạy local;
- browser upload thẳng vào backend localhost, source nằm trên ổ D;
- MongoDB local mới giữ queue/state; Atlas/R2 không nằm trên runtime mặc định;
- giữ tối đa ba source lane như Render, với PDF split tuần tự và admission thích nghi
  để ưu tiên độ mượt của Windows;
- giới hạn upload local là 159 MB để giữ hàng rào sản phẩm hiện có, nhưng workload
  nghiệm thu chính là PDF thực tế khoảng 10 MB;
- một launcher Windows chịu trách nhiệm start/stop, readiness, process priority và
  ngăn chạy trùng instance.

Cloud mode vẫn được giữ trong code như đường quay lại web, không phải một bước phải
chạy trước local mode.

## 5. Tiêu chí hoàn thành

- Một launcher khởi động đúng một instance, mở UI localhost và có thể dừng an toàn.
- Không route nào lắng nghe ngoài loopback; Windows Firewall không cần public inbound rule.
- Upload local không dùng Render, Koyeb, Vercel hoặc R2 trong đường chạy mặc định.
- Toàn bộ tính năng đang có trên Render vẫn hiện diện; không dùng bản local rút gọn.
- Restart/sleep không làm lặp stage đã persist hoặc làm mất source của job đang chạy.
- Khi áp lực RAM/CPU tăng, worker ngừng nhận job mới và tự resume; UI vẫn phản hồi.
- Một PDF đại diện khoảng 10 MB và một batch nhiều PDF cùng cỡ hoàn tất trong trần
  tài nguyên, đồng thời máy vẫn dùng Chrome/VS Code bình thường.
- Có smoke test một PDF nhỏ và rollback rehearsal từ checkpoint Render.

## 6. Ngoài phạm vi ban đầu

- Truy cập từ điện thoại/máy khác trong LAN.
- Public domain, HTTPS, remote access hoặc nhiều người dùng.
- Thay Gemini bằng model local/offline.
- Tối ưu cho workload PDF rất lớn hiếm gặp; file trên 25 MB được chạy đơn độc và có
  cảnh báo tài nguyên, dù upload gate vẫn cho phép tối đa 159 MB.
