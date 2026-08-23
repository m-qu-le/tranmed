# P015 — Cài đặt và chạy local-first

## Trạng thái bàn giao mã nguồn

P015 đã có local runtime trong branch `feature/project-015-local-first`: API chỉ bind
`127.0.0.1`, frontend production được Express phục vụ cùng origin, PDF upload trực
tiếp vào `DATA_ROOT`, queue MongoDB local và Gemini scheduler/quality pipeline cũ được
giữ nguyên. Cloud mode vẫn tồn tại nhưng phải đặt rõ `RUNTIME_MODE=cloud`.

## Trạng thái máy owner — 11-08-2026

- MongoDB Community 8.3.7 đã cài thành Windows Service `MongoDB`, tự khởi động,
  chỉ bind `127.0.0.1:27017`; không tạo firewall inbound rule.
- WiredTiger cache được đặt `0.5 GB`. Database runtime là `studymed_p015` trên
  MongoDB local, không trỏ Atlas.
- `.env.local` đã được tạo với guard local. Gemini credentials tiếp tục được đọc từ
  `.env` hiện hữu, không bị sao chép; launcher tự tạo maintenance token ngẫu nhiên
  khi chạy lần đầu.
- Launcher đã build SPA và đạt `GET /api/readiness = ready` ở
  `http://127.0.0.1:8080`.
- Đã thử dừng an toàn khi queue rỗng và khởi động lại: PID lock được dọn, MongoDB vẫn
  chạy như dịch vụ nền, và readiness sau restart tiếp tục là `ready`.

Local dùng ba worker. Code có source budget mặc định 48 MiB; máy owner đang dùng 50 MiB.
RAM trống/RSS chỉ hiện trong status để quan sát, không chặn claim hoặc stage; CPU pressure
vẫn tạm dừng claim mới để Windows không bị chiếm hết CPU.

## Cài một lần

1. Cài MongoDB Community theo Windows Service tên `MongoDB`. Cấu hình service chỉ bind
   `127.0.0.1`; không bật LAN và không tạo firewall inbound rule.
2. Chỉnh MongoDB WiredTiger cache ở mức khởi đầu 0,25–0,5 GB trước workload thật.
   Database local dùng riêng `studymed_p015`; không import/trỏ vào Atlas.
3. Tạo `med-translator-backend/.env.local` bằng cách copy
   `.env.local.example`. Trên máy owner hiện tại, Gemini key/project ID vẫn ở `.env`
   và `MAINTENANCE_CONTROL_TOKEN` được launcher tự tạo ngẫu nhiên. File local này
   không được commit.
4. Đảm bảo ổ D còn tối thiểu 10 GB trống. Mặc định source/temp/log nằm ở
   `D:\StudyMedData`, tách hoàn toàn khỏi repository.

## Chạy và dừng

- Chạy `Start StudyMed Local.cmd` hoặc
  `med-translator-backend/scripts/Start-StudyMedLocal.ps1`. Launcher build SPA,
  khởi động MongoDB nếu chính launcher đã mở nó, giữ PID lock, chạy Node
  `BelowNormal` với old-space 1.5 GB, chờ `/api/readiness` rồi hiển thị dashboard
  dịch trong CMD. Nhấn `Q` chỉ đóng dashboard; backend vẫn chạy.
- Dùng `Open StudyMed Local.cmd` khi muốn mở UI trong trình duyệt mặc định. File này
  chỉ mở UI khi backend local đã ready, không tự khởi động service.
- Dừng bằng `Stop StudyMed Local.cmd`. Lệnh gửi token trong HTTP header (không ở
  command line), dừng claim mới, chờ stage đang chạy persist ở ranh giới an toàn rồi
  tắt app. `-Force` chỉ dùng khi chấp nhận recovery lease sau lần chạy kế tiếp.

Không dùng `taskkill`/đóng terminal để dừng bình thường. Đóng dashboard CMD cũng không
dừng backend; dùng `Stop StudyMed Local.cmd` để shutdown an toàn. Lock cũ chỉ được
launcher xóa khi PID đã không còn tồn tại.

## Guard có hiệu lực

- `RUNTIME_MODE=local` chỉ nhận `APP_HOST=127.0.0.1`; `0.0.0.0` bị từ chối.
- Upload tối đa 159 MB. Backend stream vào `.part`, kiểm `%PDF-`, SHA-256/kích thước,
  rồi atomic rename vào `DATA_ROOT\sources`; path traversal, symlink/junction và
  delete ngoài data root bị từ chối.
- Dung lượng trống của ổ data luôn phải còn 10 GB. Batch local upload tuần tự để không
  cạnh tranh I/O với máy owner.
- Ba source lane được giữ; thao tác parse/copy PDF được serialize toàn cục và PDF worker
  chỉ materialize một chunk khi cần.
- Resource governor theo state `normal → pressured → recovering`: chỉ CPU sustained
  pressure mới dừng claim job mới; RAM/RSS không phải gate. `GET /api/translate/status`
  công khai reason mà không chứa nội dung file/secret.

## Nghiệm thu owner — 23-08-2026

Owner đã xác nhận launcher/readiness, một PDF khoảng 10 MB, batch nhiều PDF,
sleep/restart giữa job và Chrome/VS Code song song đều hoạt động bình thường. Đây là
nghiệm thu vận hành trên máy owner; không có benchmark timing/RSS chi tiết đính kèm.
Không chạy thêm smoke Gemini có tính phí chỉ để đóng dự án.
