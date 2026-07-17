## File này sẽ ghi lại các lỗi phát sinh trong quá trình sử dụng trang web và các cải tiến tôi mong muốn có trong tương lai

1. Hiện tại trên giao diện chính đang có 3 khung thông tin là: Batch đang upload lên R2; File đã an toàn trên Cloud và File Render đang dịch; Trong ô File Render đang dịch thì số được hiển thị to là số file đang được dịch, ví dụ: 474 File Render đang dịch (Chờ 473 · xử lý 1 · xong 32 · lỗi 0) nhưng tôi muốn chỉnh số hiển thị to là số file đã xong ví dụ: 32 File đã xong (chờ 473 xử lý 1 lỗi 0)

2. Hệ thống bây giờ có chịu được việc xử lý 2 file cùng 1 lúc không? Nếu có thì để số file xử lý là 2 đi, chứ 1 thì thời gian xử lý hết hàng đợi hơi lâu

3. Trong giao diện trang web, nếu tôi vừa tải lên thư mục (1 hoặc nhiều) thì sẽ hiện ra khung ☁️ Tiến độ lưu lên Cloud (0 batch chưa an toàn) trong khung này sẽ có thông tin về các thư mục đã tải lên cùng với nút (ẩn) với từng thư mục. Nhưng hiện tại nút ẩn này có giao diện chưa đẹp và tôi muốn có thêm nút ẩn tất cả để dễ dàng xóa thông tin trong khung đó.

4. Tôi mới phát hiện ra lỗi mới: khu vực số lượng file đang dịch, file đã xong thực ra không cho ra số liệu thực sự mà nó bị ảnh hưởng với danh sách file được hiển thị trong trang. Ví dụ khi tôi ấn vào trang và chưa ấn tải thêm lịch sử thì nó sẽ hiện 100 File Render đang dịch (Chờ 100 · xử lý 0 · xong 0 · lỗi 0); khi tôi chọn tải thêm một lần thì nó hiện 200 File Render đang dịch (Chờ 200 · xử lý 0 · xong 0 · lỗi 0); chỉ khi tôi tải hết lịch sử thì thông tin ở khung đó mới hiển thị đúng.