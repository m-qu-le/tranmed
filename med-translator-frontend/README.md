# StudyMed Translator — Frontend

React/Vite client cho hệ thống dịch PDF y khoa. Frontend upload PDF trực tiếp lên Cloudflare R2 với concurrency 4, xác nhận từng lô qua backend và chỉ báo có thể đóng máy sau khi toàn batch đã an toàn trên Cloud.

## Chạy local

```powershell
Copy-Item .env.example .env.local
npm install
npm run dev
```

`VITE_API_URL` phải bao gồm `/api/translate`, ví dụ `http://localhost:8080/api/translate`.

## Kiểm tra

```powershell
npm test
npm run lint
npm run build
```

Không F5 hoặc đóng tab khi còn batch chưa được backend xác nhận `canCloseClient=true`. Khi banner “Đã lưu an toàn trên Cloud” xuất hiện, có thể đóng máy; Render tiếp tục dịch và giao diện sẽ phục hồi batch/job từ MongoDB khi mở lại.

Với quality mode P003, card công việc hiển thị stage `Đang đọc ngữ cảnh toàn tài liệu`, `Đang dịch`, `Đang kiểm định`, `Đang hiệu chỉnh`, `Đang xác minh`, `Đang sửa lỗi` hoặc `Đang xác minh lại`. Chỉ chunk có báo cáo cuối PASS và coverage đầy đủ mới được tính `passed`; mọi lỗi kể cả minor được sửa tối đa hai vòng. Job có chunk không vượt qua coverage/reverify vẫn tải được bản cuối nhưng hiện `Hoàn thành có cảnh báo`, số chunk cần xem lại và phạm vi trang. Với P004, API đặt cùng một header rà soát ở đầu chuỗi dùng cho Preview, Copy Markdown và Download; frontend không tự dựng hoặc lưu header. Đây là cảnh báo kiểm tra thủ công, không phải tuyên bố bản dịch đã được kiểm chứng hoàn toàn.

SSE chỉ nhận stage, số đếm, key index/retry và page range công khai. Draft, audit excerpt và bản dịch trung gian không được gửi ra frontend. Khi F5 hoặc SSE reconnect, ứng dụng đọc lại stage đã persist từ `/jobs` thay vì reset tiến độ.

Dashboard P005 đọc tổng bốn trạng thái từ `/jobs/stats`; nút “Tải thêm lịch sử” chỉ phân trang danh sách và không làm đổi card tổng. Khung Cloud cho phép “Ẩn” hoặc “Ẩn tất cả” đối với batch đã có `canCloseClient=true`. Thao tác này chỉ lưu `batchId` vào `studymed.hiddenUploadBatchIds.v1` trong trình duyệt, không gọi API xóa và không ảnh hưởng job/object R2. Muốn hiện lại các batch trên trình duyệt đó, xóa key local storage này rồi tải lại trang.
