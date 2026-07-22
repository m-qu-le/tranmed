# PROJECT 009 — Danh mục thư mục toàn cục và tải job theo thư mục

## 1. Thông tin kế hoạch

| Thuộc tính | Giá trị |
| --- | --- |
| Mã kế hoạch | P009 |
| Ngày lập | 22-07-2026 |
| Trạng thái | **HOÀN THÀNH — kiểm chứng bằng test local/mock ngày 22-07-2026** |
| Vấn đề | Sau F5 hoặc đồng bộ lại SSE, giao diện chỉ lấy một trang `GET /jobs` (tối đa 100 job). Các thư mục không có job trong trang đó biến mất, dù job vẫn tồn tại và worker vẫn dịch. `📌 Ưu tiên` vì thế không được ghim nếu các job ưu tiên nằm ở trang sau. |
| Mục tiêu | Luôn hiển thị ngay toàn bộ thư mục logic đang có job, kèm tổng số file; `📌 Ưu tiên` luôn đứng đầu khi còn ít nhất một job ưu tiên. Chỉ tải danh sách file của một thư mục khi người dùng mở thư mục đó. |
| Không đổi | MongoDB Job/UploadBatch, quy tắc priority/claim worker, upload R2, pipeline dịch, circuit breaker/ngủ đông và các API xóa hiện hữu. |
| Phạm vi test | Unit backend và component frontend với mock/stub. Không gọi Gemini, R2, MongoDB remote, PDF thật hay deployment. |

## 2. Phân tích nguyên nhân

`GET /jobs` là API lịch sử có phân trang cursor: backend trả tối đa 100 job theo `_id` tăng dần. Frontend dựng `groupedJobs` chỉ từ mảng `jobs` của trang hiện có. Trong khi đó `GET /jobs/stats` đã aggregate toàn bộ tên thư mục và tổng số file, frontend lại chỉ dùng dữ liệu này để ghi số lượng trên những thư mục đã render.

Hệ quả cần loại bỏ:

1. F5/SSE resync thay state `jobs` bằng trang đầu nên thư mục ở trang sau biến mất.
2. Thư mục `Ưu tiên` chỉ hiện khi ít nhất một job ưu tiên tình cờ nằm trong trang đã tải, trái với ý nghĩa nhóm ghim.
3. Nút thu gọn không có giá trị cho thư mục chưa được tải vào trang UI.
4. Nút tải xuống và dọn dẹp đang chỉ nhận `folderJobs` đã tải, nên có thể chỉ tác động một phần thư mục mà không thể hiện rõ giới hạn đó.

Thư mục ở đây là **nhóm logic của Job**, không phải entity độc lập: chỉ hiển thị thư mục có ít nhất một job. Khi không còn job, thư mục biến mất.

## 3. Hành vi đích và hợp đồng

### 3.1. Danh mục thư mục

1. Lần tải đầu và mỗi lần refresh stats nhận danh mục toàn cục gồm: tên thư mục, `priority`, tổng số file và số lượng theo trạng thái nếu có.
2. UI render toàn bộ header từ danh mục này, không suy ra danh mục từ trang `GET /jobs` tổng quát.
3. Nếu tổng priority > 0, header `📌 Ưu tiên` luôn là header đầu tiên; mọi folder thường sắp xếp theo `Intl.Collator('vi')` hiện có.
4. Các header thường mặc định thu gọn. Nhấn header sẽ tải trang đầu job của **riêng folder đó**, rồi mở danh sách; nhấn lại chỉ thu gọn, không xóa dữ liệu đã tải trong phiên.
5. Header phải hiển thị chính xác tổng số file toàn thư mục, và nếu mới tải một phần phải thể hiện `đã tải x/y` hoặc nút tải thêm ngay trong folder. Không dùng một nút “Tải thêm lịch sử” toàn cục để tìm thư mục.

### 3.2. API đọc theo thư mục

Thêm endpoint đọc-only, ưu tiên dạng:

```text
GET /folders/:folderName/jobs?cursor=<cursor>&limit=<1..100>
```

- Trả cùng public projection an toàn như `GET /jobs`, chỉ khác filter theo nhóm folder.
- Phân trang cursor phải có thứ tự ổn định và nhất quán. Chọn thứ tự file theo `createdAt`/`_id` và ghi rõ trong test; không dùng sort khác giữa trang đầu và trang sau.
- Folder `Ưu tiên` phải filter bằng `priority: 1` (có thể kèm `folderName: 'Ưu tiên'` để tương thích dữ liệu hiện có), không tin tham số UI để thay đổi semantics priority.
- Folder thường filter theo `folderName`; tên `Ưu tiên` vẫn là reserved name ở mọi luồng tạo job như P007.
- Validate `folderName`, `cursor`, `limit`; projection không lộ storage key, URL ký, source path hoặc secret.

Không tải toàn bộ Job khi mở ứng dụng: điều đó phá vỡ mục tiêu phân trang và sẽ tăng payload không giới hạn.

### 3.3. Thao tác theo thư mục

- `🧨 Xóa toàn bộ hàng đợi` giữ API server-side hiện có và phải áp dụng toàn thư mục, kể cả job chưa tải vào UI.
- `📥 Tải các file đã xong` và `🧹 Dọn dẹp` không được âm thầm chỉ tác động phần job đang cache. P009 phải chọn một contract rõ ràng trước khi triển khai:
  - truy vấn đầy đủ job phù hợp từ backend khi chạy thao tác; hoặc
  - đổi nhãn/confirm để nói rõ chỉ thao tác các file đã tải.
- Ưu tiên phương án server-authoritative/toàn thư mục nếu không làm tăng rủi ro xóa dữ liệu; không thêm thao tác xóa hàng loạt mới khi chưa xác nhận semantics cancel/processing hiện có.

## 4. Kế hoạch triển khai

### G0 — Khóa contract và baseline

- [x] `P009-G0-S01`: Đọc `AGENTS.md`, kiểm tra worktree; không đụng thay đổi ngoài P009.
- [x] `P009-G0-S02`: Rà toàn bộ caller của `getJobsSummary`, `getJobStats`, `groupedJobs`, `collapsedFolders`, download/dọn dẹp/xóa folder.
- [x] `P009-G0-S03`: Chốt public contract danh mục folder và API đọc theo folder; chốt phạm vi thật của download/dọn dẹp trước khi sửa UI.

**Cổng G0:** Không có API mơ hồ về priority, cursor, header rỗng hoặc phạm vi thao tác folder.

### G1 — Backend: danh mục và trang job folder-scoped

- [x] `P009-G1-S01`: Mở rộng dữ liệu stats/danh mục với metadata priority cần thiết; giữ tương thích dashboard đang dùng `pending/processing/completed/failed`.
- [x] `P009-G1-S02`: Thêm service/controller/route đọc job theo folder, validate input và tái sử dụng public projection thay vì copy-paste.
- [x] `P009-G1-S03`: Không thêm index: query mới chưa có bằng chứng cần index riêng và P009 không chạy `explain`/thay đổi index production.
- [x] `P009-G1-S04`: Rà trường hợp legacy thiếu `priority`, folder rỗng, folder thường có tên Unicode và folder `Ưu tiên`.

**Cổng G1:** API global luôn nhận ra folder ưu tiên còn job; endpoint folder không rò dữ liệu nhạy cảm và phân trang không trùng/mất item.

### G2 — Frontend: headers toàn cục và mở thư mục có lazy load

- [x] `P009-G2-S01`: Tạo danh sách folder từ stats/danh mục, union an toàn với job realtime/local vừa tạo trong lúc stats chưa refresh.
- [x] `P009-G2-S02`: Render `📌 Ưu tiên` đầu tiên nếu count > 0; các header folder thường theo collator hiện có; không render empty-state khi danh mục còn folder.
- [x] `P009-G2-S03`: Đổi collapse state từ cơ chế chỉ có ý nghĩa với `groupedJobs` sang trạng thái theo folder; mở folder lazy-load trang đầu và hiển thị loading/error có thể retry.
- [x] `P009-G2-S04`: Thêm pagination riêng cho từng folder và chỉ hiển thị “tải thêm” trong folder đó khi còn dữ liệu.
- [x] `P009-G2-S05`: Cập nhật local/SSE/delete để header count, folder cache và priority group không bị stale hoặc biến mất sai.
- [x] `P009-G2-S06`: Chỉnh các action folder theo contract G0; không hứa thao tác toàn thư mục nếu chỉ có dữ liệu trang hiện tại.

**Cổng G2:** F5 với hơn 100 job vẫn cho thấy toàn bộ header, `📌 Ưu tiên` đầu tiên và người dùng không cần tải lịch sử để phát hiện folder.

### G3 — Hồi quy và xác nhận

- [x] `P009-G3-S01`: Chạy backend test, frontend test, frontend lint/build theo scripts hiện có.
- [x] `P009-G3-S02`: Review diff, đặc biệt public projection, reserved priority, cancel/delete processing và không có fetch toàn lịch sử lúc startup.
- [x] `P009-G3-S03`: Ghi bằng chứng vào §6; chỉ đánh dấu hoàn thành khi các test bắt buộc xanh.

## 5. Ma trận kiểm thử bắt buộc

| Mã | Cấp | Tình huống | Kỳ vọng |
| --- | --- | --- | --- |
| `P009-T01` | Unit backend | Danh mục có 3 folder thường và priority ngoài trang 100 job tổng | Trả đủ 4 folder; priority metadata/count đúng. |
| `P009-T02` | Unit backend | `GET /folders/Ưu tiên/jobs` | Chỉ trả job `priority: 1`; không trả folder thường. |
| `P009-T03` | Unit backend | Cursor hai trang một folder | Thứ tự ổn định, không trùng/mất job, `nextCursor` đúng. |
| `P009-T04` | Unit backend | Tên folder Unicode, cursor/limit sai | Tên hợp lệ truy vấn đúng; input sai trả 400 công khai, không lộ internal error. |
| `P009-T05` | Unit backend | Job legacy thiếu priority | Được xem thường; không tạo nhầm group ưu tiên. |
| `P009-T06` | Component | F5: 100 job trang tổng không có priority, stats có priority | `📌 Ưu tiên` vẫn xuất hiện đầu tiên với tổng count đúng. |
| `P009-T07` | Component | Stats có nhiều folder, job cache chỉ thuộc một folder | Tất cả header đều thấy; chỉ folder đã mở mới có JobCard. |
| `P009-T08` | Component | Mở/đóng folder chưa cache | Mở gọi đúng endpoint folder một lần, loading rồi render; đóng không làm mất cache. |
| `P009-T09` | Component | Folder còn trang sau | Nút tải thêm chỉ thuộc folder đó và không làm fetch lịch sử/folder khác. |
| `P009-T10` | Component | Xóa hết job ưu tiên rồi refresh stats | Header priority biến mất; folder thường còn nguyên. |
| `P009-T11` | Regression | Upload priority trong phiên hiện tại, rồi F5/resync | Header priority và job vẫn phục hồi đúng; worker semantics không đổi. |
| `P009-T12` | Regression | Download/dọn dẹp folder có job chưa cache | Hành vi khớp chính xác contract G0, không âm thầm bỏ sót file. |

## 6. Nhật ký bằng chứng

| Mã | Ngày | Bước/test | Lệnh hoặc bằng chứng | Kết quả |
| --- | --- | --- | --- | --- |
| `P009-E01` | 22-07-2026 | Backend unit/regression | `med-translator-backend: npm test` | 133 pass. |
| `P009-E02` | 22-07-2026 | Frontend component/regression | `med-translator-frontend: npm test` | 30 pass. |
| `P009-E03` | 22-07-2026 | Frontend lint | `med-translator-frontend: npm run lint` | Pass. |
| `P009-E04` | 22-07-2026 | Frontend production build | `med-translator-frontend: npm run build` | Pass. |

## 7. Điều kiện nghiệm thu

P009 chỉ hoàn thành khi đồng thời thỏa:

1. Mọi thư mục còn ít nhất một job đều thấy ngay sau F5, bất kể tổng số job.
2. `📌 Ưu tiên` luôn là header đầu tiên khi còn job ưu tiên, kể cả khi job đó không nằm trong trang `GET /jobs` tổng quát.
3. Việc mở folder chỉ tải job của folder đó; giao diện không tải toàn bộ lịch sử lúc khởi động.
4. Collapse/expand hoạt động với mọi header và pagination theo từng folder không trùng/mất job.
5. Count trên header là count toàn thư mục, không phải count cache; actions folder không có phạm vi gây hiểu nhầm.
6. Worker priority, upload, hibernation, retry, delete/cancel và public-data boundary không hồi quy.
7. Toàn bộ `P009-T01…T12` cùng test/lint/build liên quan đều xanh, không dùng dịch vụ production làm bằng chứng.
