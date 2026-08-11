# P014 — Oracle onboarding và điều kiện A1 capacity

> **ARCHIVED — không tiếp tục thực hiện.** P014 đóng ngày 11-08-2026 vì không thể
> tạo/hoàn tất tài khoản Oracle Always Free. Xem `project-014-closure.md`.

## Mục đích

Tài liệu này định nghĩa **điểm bắt đầu đúng** trước cutover. Không tạo, sửa hoặc xóa
bất kỳ dữ liệu ứng dụng nào cho đến khi có VM A1 hoạt động.

## Thứ tự bắt buộc

1. Tạo/hoàn tất tài khoản Oracle Cloud Free Tier, xác thực số điện thoại và thẻ theo
   yêu cầu Oracle.
2. Chọn **US East** làm home region.
3. Vào Compute và thử tạo Always Free Ampere A1 với **2 OCPU, 6 GB RAM, 50 GB boot
   volume**.
4. Nếu tạo được VM, ghi nhận public IP và tiếp tục phần chuẩn bị VM.
5. Nếu Oracle báo không còn host capacity cho A1, dừng ở đây: chờ và thử lại định kỳ
   trong cùng US East. Không tạo paid instance, không đổi sang vùng khác và không
   bắt đầu purge/deploy.

Vì vậy, “chờ capacity” **không phải** bước đầu tiên. Nó chỉ là nhánh xử lý khi bước 3
thất bại do Oracle chưa có A1 capacity. Việc chọn home region cần cẩn trọng vì Always
Free compute bị gắn với home region và không thể chuyển vùng sau đó.

## Kiểm tra để không vô tình phát sinh phí

- Trước khi bấm tạo, xác nhận từng tài nguyên hiển thị nhãn **Always Free**.
- Không nâng cấp shape, boot volume, public IP hay dịch vụ mạng sang tài nguyên paid
  nếu console hiện cảnh báo phát sinh chi phí.
- Không tạo load balancer, database Oracle managed hay instance dự phòng cho P014.
- Ghi lại thời điểm khởi tạo và kiểm tra Billing/Cost Analysis sau khi VM chạy.

Oracle có thể thu hồi một Always Free instance bị xem là idle. Vì ứng dụng dùng ít
tài nguyên, monitoring/readiness và kiểm tra định kỳ là cần thiết; không được dựa vào
việc VM “luôn tồn tại” như một cam kết backup.

## Chuẩn bị VM sau khi cấp phát thành công

Các bước dưới đây là checklist triển khai tương lai, không phải lệnh để chạy ngay.

- Tạo một SSH key dành riêng cho quản trị VM, lưu private key cục bộ an toàn.
- Mở cloud security list/NSG chỉ cho `80/tcp`, `443/tcp`, `22/tcp`; giới hạn SSH theo
  IP quản trị nếu có IP tĩnh, nếu không dùng key-only login và firewall host.
- Cấu hình UFW tương ứng, tắt password SSH và không expose port backend Node ra
  Internet.
- Tạo thư mục vận hành, tách repository khỏi secret. Đề xuất:

  ```text
  /opt/studymed/app/       # clone repository
  /opt/studymed/secrets/   # env backend/gateway, mode 0600
  /opt/studymed/state/     # Docker persistent volumes
  ```

- Cài Docker Engine + Compose plugin; kiểm tra Docker daemon khởi động cùng máy.
- Tạo DuckDNS token file ở `/opt/studymed/secrets/`, cài systemd timer cập nhật IP.
  Token này không nằm trong Git repository hoặc GitHub Actions.
- Tạo bản ghi DuckDNS `tranmed-api.duckdns.org`, kiểm tra nó trỏ đúng public IP VM
  trước khi yêu cầu Caddy xin chứng chỉ TLS.

## Hạ tầng ứng dụng dự kiến

| Thành phần | Cách chạy | Lý do |
| --- | --- | --- |
| Caddy | Docker container, public port 80/443 | TLS, static frontend, Basic Auth, proxy API |
| Frontend | Vite build static do Caddy phục vụ | Cùng origin với API, không còn phụ thuộc Vercel runtime |
| Backend | Node/Express Docker container, internal network | Không lộ port ứng dụng trực tiếp |
| Caddy certificates | Docker named volume | Không xin lại certificate mỗi lần deploy |
| Backend temp files | Docker volume/bind mount có giới hạn/cleanup | PDF được tải và cắt tạm thời |

## Mốc dừng an toàn

- **Chưa có A1 capacity:** chỉ retry allocation; mọi hệ thống cũ và dữ liệu giữ
  nguyên (dù Render hiện đang suspended).
- **A1 đã có nhưng DuckDNS/TLS chưa đúng:** không đổi frontend production hoặc purge
  dữ liệu; xử lý DNS/TLS trước.
- **Có dấu hiệu cấu hình paid:** dừng và xác minh console trước khi tiếp tục.
