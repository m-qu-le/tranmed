# Frontend: upload, trạng thái và kết quả

Frontend là React 19/Vite. `src/App.jsx` hiện là nơi tập trung phần lớn state/UI; `src/api/client.js` chuẩn hóa base URL và direct R2 PUT; `src/cloudUploader.js` chứa giao thức cloud batch có thể test độc lập.

## Kết nối backend

`VITE_API_URL` phải là base đã gồm `/api/translate`. Nếu không có biến này, client fallback `https://tranmed.onrender.com/api/translate`. Axios API timeout 30 giây; PUT R2 timeout 15 phút. `putPdfToR2` từ chối URL không HTTPS hoặc không kết thúc bằng `.r2.cloudflarestorage.com`, vì frontend chỉ được PUT vào URL do backend cấp.

## Cloud uploader và close-safe

1. Người dùng chọn từ 1 đến 500 PDF cho batch thường hoặc vùng **Hàng đợi ưu tiên**. Backend cũng chặn manifest quá 500 file, file vượt `MAX_FILE_SIZE_MB`, và tổng batch vượt 2 GiB. Batch thường dùng folder người dùng nhập; batch priority luôn gửi `priority: true` và hiển thị group `Ưu tiên`.
2. UI tạo UUID `clientBatchId` và `clientUploadId` cho từng file; các ID giữ idempotency khi prepare/retry.
3. `uploadBatchToCloud()` gọi prepare, PUT trực tiếp lên R2 tối đa 4 file đồng thời và confirm theo block tối đa 10 job IDs.
4. Mỗi operation retry tối đa 3 lần với backoff 300/600 ms cho lỗi network, 408, 429, 5xx. 400/401/403 từ R2 được xem là URL signature hết hạn: gọi prepare lại để lấy URL mới cho item đó.
5. Sau upload, frontend đọc lại batch. Chỉ `canCloseClient=true` nghĩa là backend đã xác nhận tất cả item hoặc skipped; lúc đó mới báo **Đã lưu an toàn trên Cloud** và người dùng mới có thể F5/đóng tab/đóng máy.
6. Item thất bại hoặc confirm lỗi phải giữ trạng thái lỗi; frontend không được giả đã an toàn. Backend có endpoint abandon để dọn item hỏng khi luồng UI gọi nó.

Không preempt một browser upload đang chạy: priority task mới được xếp local và sẽ bắt đầu sau task local hiện tại. Đây là khác với **worker claim priority** ở backend, vốn ưu tiên tuyệt đối giữa job pending eligible.

### Ẩn batch local

Nút “Ẩn/Ẩn tất cả” chỉ khả dụng cho batch close-safe. Nó lưu `batchId` vào local storage key `studymed.hiddenUploadBatchIds.v1`, không gọi API xóa, không hủy job và không xóa R2. Xóa local-storage key rồi reload sẽ hiện lại batch trên trình duyệt đó.

## Đồng bộ trạng thái

- Initial load đọc `/status`, `/jobs/stats`, `/jobs/terminal-failures`, `/upload-batches`; UI bổ sung job summary theo folder khi người dùng mở folder.
- SSE mở `EventSource(${API_BASE_URL}/stream)`. Server gửi connected, public job/log/system/batch/cleanup events và heartbeat. SSE chỉ cải thiện độ tươi; nó không có đủ state để khôi phục giao diện.
- Khi SSE reconnect, frontend gọi lại status/batches/stats/terminal failures. Job state persist ở MongoDB là nguồn sự thật; không reset thanh tiến độ chỉ vì kết nối bị mất.
- Dashboard phải lấy bốn total (`pending`, `processing`, `completed`, `failed`) và danh mục folder từ `/jobs/stats`. “Tải thêm” folder chỉ tải page danh sách, không được cộng/trừ dashboard total.

## Thư mục, priority và lazy loading

P009 chuyển danh sách job sang folder catalog toàn cục. Folder được render collapsed mặc định và chỉ GET `/folders/:folderName/jobs` khi mở, rồi tiếp tục bằng `nextCursor`. Priority folder được backend nhận diện từ `priority=1`, không phải từ display name, và luôn ghim trước folder thường khi còn job priority. Tên `Ưu tiên` là reserved: UI thường không được dùng nó để tạo hàng thường.

Card/hành động folder chỉ thao tác trên page đã load. Download folder tải các job completed hiện có trong page; xóa/dọn folder gọi API backend có semantics toàn folder. Nếu thay UI này, tránh suy luận “tất cả job” từ một page lazy-loaded.

## Quality UI và kết quả

- Card hiển thị public stages: document context, translate, audit, revise, verify, repair/reverify; không tự đánh giá semantic quality từ frontend.
- Chỉ backend quyết định `passed`: final report `PASS` và coverage đầy đủ. `needs_review` vẫn là job completed, cho phép preview/copy/download final Markdown và phải hiển thị cảnh báo + page range.
- Preview/copy lazy-fetch `/jobs/:jobId/result`. Download dùng `/jobs/:jobId/download`, có thể stream qua File System Access API khi browser hỗ trợ; cả ba phải dùng chính response backend đã prepend header P004, không tự dựng/lưu header.
- Filename Windows được sanitize và collision case-insensitive xử lý bằng `_2`, `_3`, …; stream/writable phải đóng trong `finally`.
- SSE/public result không chứa draft translation, full audit/reverify report, document passport, PDF, Gemini key hay prompt. Không thêm chúng vào React state/log browser.

## Điều khiển vận hành hiển thị trong UI

- UI cho phép xem danh sách terminal failures và gọi `/jobs/retry-terminal`. Chỉ failed job còn R2 source ready và thuộc loại retryable mới quay về pending; file đã bị dọn cần upload lại PDF gốc.
- Nút **Tạm dừng để redeploy** yêu cầu người vận hành nhập `MAINTENANCE_CONTROL_TOKEN`, gửi riêng trong `X-Maintenance-Token`, rồi chờ status có `worker.activeJobs=0` trước deploy. Token không lưu local storage, không đưa vào `VITE_*` và không hiển thị/log.
- Khi status maintenance paused, UI phải chặn bắt đầu upload mới. Huỷ pause dùng endpoint cancel với token.

## Test và khoản nợ

Chạy `npm test`, `npm run lint`, `npm run build` trong `med-translator-frontend`. Test hiện có bao phủ API client, cloud uploader (batch/concurrency/retry/confirm) và App behaviors; vẫn thiếu e2e browser thực cho SSE reconnect, cancel trong flight, File System Access và collision download.

`App.jsx` lớn, nhiều inline style và `alert`/`confirm`; đây là khoản nợ đã biết, không phải lý do để tách abstraction/đổi UI ngoài phạm vi task. Bất kỳ refactor nào vẫn phải giữ close-safe, HTTP resync, public-data boundary, priority semantics và lazy folder pagination.
