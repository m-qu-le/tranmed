# PROJECT 004 — Chèn cảnh báo kiểm soát chất lượng vào đầu bản dịch Markdown

## 1. Thông tin dự án

| Thuộc tính | Giá trị |
| --- | --- |
| Mã kế hoạch | P004 |
| Ngày lập | 17-07-2026 |
| Trạng thái tổng | **HOÀN THÀNH — đã triển khai và đạt toàn bộ test/mock P004** |
| Nguồn yêu cầu | Mục 4 trong `log_vận_hành.md`, được làm rõ qua trao đổi với chủ dự án |
| Mục tiêu chính | Giúp người đọc biết chính xác phần nào của từng bản dịch cần đối chiếu với PDF gốc mà không phải mở từng card trên web để dò cảnh báo |
| Phương án đã chốt | Không tạo một báo cáo Markdown lớn theo thư mục; tự chèn khối cảnh báo dễ đọc vào đầu từng file Markdown có chunk `needs_review` |
| Kênh phải nhất quán | Preview trên web, Copy Markdown và file `.md` tải xuống |
| Dữ liệu nguồn | `verificationReport`, `reverifyReport`, page range, repair count và nguyên nhân lỗi kỹ thuật được lưu trên `TranslationChunk` |
| Ràng buộc kiểm thử | Chỉ dùng unit test, mock và fixture dữ liệu thuần; không dùng PDF thật, Gemini thật, R2 thật, MongoDB production hay deploy canary trong P004 |
| Hạ tầng giữ nguyên | React/Vite frontend, Express backend, MongoDB, Cloudflare R2, Render và pipeline quality `p003-v3` |

## 2. Cách theo dõi kế hoạch

Quy ước:

- `[ ]`: chưa thực hiện.
- `[x]`: đã hoàn thành và có bằng chứng được ghi trong tài liệu này.
- `BLOCKED`: không thể tiếp tục nếu thiếu quyết định hoặc điều kiện bên ngoài.
- Mỗi bước có mã theo dạng `P004-Gx-Syy` để có thể tham chiếu trong commit, pull request, log và phiên review.
- Chỉ đánh dấu một bước hoàn thành sau khi tiêu chí nghiệm thu của bước đó đạt.
- Thay đổi quyết định sản phẩm, cấu trúc dữ liệu công khai hoặc định dạng cảnh báo phải được ghi vào Nhật ký quyết định.
- Không dùng PDF thật hoặc gọi dịch vụ thật để đóng cổng test của P004. Nếu người dùng phát hiện vấn đề khi sử dụng thực tế, ghi lại thành bằng chứng vận hành và mở bước sửa riêng.
- Không commit API key, URL có chữ ký, nội dung PDF hoặc bản dịch thực tế của người dùng.

## 3. Vấn đề cần giải quyết

Hiện tại một file quality có thể hoàn tất với cảnh báo dạng:

```text
Kiểm soát chất lượng: 5/5 chunk hoàn tất · 3 đạt · 2 cần xem lại
Phần 2: trang 3–4
Phần 5: trang 9
```

Thông báo này cho biết phạm vi trang nhưng chưa cho người đọc biết:

- Vì sao chunk cần xem lại.
- Lỗi thuộc loại nào và nghiêm trọng đến đâu.
- Đoạn nguồn và đoạn dịch nào liên quan.
- Hệ thống đã thử sửa bao nhiêu lần.
- Chunk thất bại do lỗi nội dung, coverage chưa đủ hay đầu ra kỹ thuật không hợp lệ.

Khi có hàng trăm file, việc quay lại giao diện và mở từng card để dò là không thuận tiện. Ý tưởng ban đầu là tạo một báo cáo lớn cho cả thư mục, nhưng quyết định cuối cùng là đặt cảnh báo ngay trong chính bản dịch. Khi người dùng đọc đến file đó, thông tin đối chiếu đã đi cùng file và không phụ thuộc vào việc giao diện còn giữ lịch sử batch hay không.

## 4. Hiện trạng kỹ thuật

### 4.1. Dữ liệu hệ thống đã biết

Mỗi quality chunk hiện có thể lưu:

- `chunkIndex`, `pageStart`, `pageEnd` và `repairCount`.
- `qualityStatus = passed | needs_review`.
- `verificationReport` và `reverifyReport` với `status`, `errors` và `coverage`.
- Mỗi lỗi có `category`, `severity`, `sourceExcerpt`, `targetExcerpt`, `requiredCorrection` và `explanation`.
- Mỗi coverage checkpoint có `focus`, `sourceExcerpt`, `targetExcerpt` và `result`.

Job hiện chỉ tổng hợp `qualityWarnings` gồm số chunk và khoảng trang. Public API cố ý không trả báo cáo kiểm định nội bộ. Preview/Copy gọi API result; download dùng endpoint stream Markdown riêng.

### 4.2. Khoảng trống cần bổ sung

- Nhánh repair nhận output bị chặn, bị cắt, rỗng hoặc sai schema hiện chuyển chunk sang `needs_review` nhưng làm mất mã nguyên nhân sau khi chuyển trạng thái.
- Logic dựng kết quả đang nằm ở nhiều đường trả dữ liệu, nên nếu chèn cảnh báo riêng lẻ sẽ dễ làm Preview, Copy và Download khác nhau.
- Chưa có bộ chuyển category, severity và coverage kỹ thuật thành tiếng Việt dễ hiểu.
- Không được ghi trực tiếp header vào `TranslationChunk.content`, vì nội dung đó còn là artifact chuẩn để resume, ghép kết quả và tránh chèn lặp khi gọi API nhiều lần.

## 5. Ý nghĩa cảnh báo

### 5.1. Mức độ lỗi

| Mức độ | Ý nghĩa trình bày cho người đọc | Ví dụ |
| --- | --- | --- |
| `critical` | Lỗi có khả năng làm đảo ngược hoặc thay đổi nghiêm trọng thông tin y khoa, quyết định điều trị hay mức an toàn | Sai phủ định, sai liều/đơn vị, đảo chiều khuyến cáo, đổi quan hệ nguyên nhân–kết quả |
| `major` | Lỗi quan trọng có thể khiến người đọc hiểu sai nội dung chuyên môn nhưng chưa đủ căn cứ để xếp vào mức nguy hiểm nhất | Dịch sai thuật ngữ trọng tâm, bỏ một mệnh đề quan trọng, gán sai tác nhân–đích |
| `minor` | Sai lệch nhỏ vẫn cần sửa để bản dịch chính xác; không dùng cho khác biệt thuần sở thích văn phong | Thuật ngữ chưa chuẩn, lỗi định dạng hoặc diễn đạt gây lệch nghĩa nhẹ |

Mức độ do báo cáo kiểm định tạo ra là tín hiệu hỗ trợ rà soát, không phải kết luận lâm sàng. Header phải nói rõ người dùng vẫn cần đối chiếu PDF gốc.

### 5.2. Coverage

Coverage là bảng điểm danh nội dung theo thứ tự nguồn, không phải tỷ lệ phần trăm chính xác của toàn PDF. Hệ thống tạo các checkpoint cho những yếu tố có mặt trong chunk như:

- Ý nghĩa chính và thuật ngữ.
- Số, liều và đơn vị.
- Phủ định và mức độ chắc chắn.
- Quan hệ nguyên nhân–kết quả.
- Khuyến cáo lâm sàng.
- Bảng, hình và chú thích.

`COMPLETE` chỉ có nghĩa là báo cáo xác minh đã kiểm đủ số checkpoint tối thiểu, đánh dấu toàn bộ chunk đã được rà và không còn lỗi có bằng chứng. `INCOMPLETE` hoặc danh sách checkpoint quá ngắn nghĩa là hệ thống chưa đủ bằng chứng để tự xác nhận chunk đã được kiểm hết. Đây là lý do cần xem lại, kể cả khi chưa chỉ ra được một lỗi dịch cụ thể.

## 6. Phạm vi và quyết định đã chốt

### 6.1. Trong phạm vi

- Chỉ áp dụng cho job quality đã `completed` và có ít nhất một chunk `needs_review`.
- Dựng một header cảnh báo Markdown ở thời điểm trả kết quả.
- Hiển thị cùng nội dung trong Preview, Copy Markdown và Download.
- Diễn giải toàn bộ thông tin hữu ích hệ thống đang biết: trang, loại lỗi, mức độ, giải thích, yêu cầu sửa, trích đoạn nguồn/đích, coverage và số vòng sửa.
- Bổ sung lưu nguyên nhân có cấu trúc cho lỗi kỹ thuật ở bước repair.
- Giữ cảnh báo ngắn hiện tại trên card để người dùng nhận ra file có vấn đề trước khi mở.
- Bảo toàn khả năng đọc job/chunk legacy và dữ liệu P003 đã tồn tại.

### 6.2. Ngoài phạm vi

- Không tạo báo cáo tổng hợp theo tên thư mục hoặc upload batch.
- Không tự động sửa lại file sau khi người dùng tải xuống.
- Không thêm màn hình review, nút xác nhận thủ công hoặc cơ chế lưu quyết định của người dùng.
- Không thay đổi prompt, quality gate, số vòng repair, chunk size hoặc model Gemini.
- Không xử lý ba yêu cầu giao diện/vận hành khác trong `log_vận_hành.md`.
- Không benchmark với PDF thật và không gọi Gemini/R2/MongoDB production.

## 7. Hành vi đầu ra mục tiêu

Một file có cảnh báo sẽ bắt đầu bằng cấu trúc tương đương:

```markdown
# ⚠️ Lưu ý kiểm soát chất lượng

> Bản dịch đã hoàn thành nhưng còn 2/5 phần cần đối chiếu thủ công với PDF gốc. Thông tin dưới đây là hỗ trợ rà soát, không phải kết luận chuyên môn cuối cùng.

## Phần 2 — trang 3–4

- Kết quả: Cần xem lại sau 2 vòng sửa.
- Lý do: Xác minh cuối vẫn phát hiện lỗi nội dung.

### Lỗi 1 — Nghiêm trọng: Thiếu nội dung

- Giải thích: Bản dịch bỏ sót mệnh đề mô tả chống chỉ định.
- Cần sửa: Bổ sung đầy đủ mệnh đề bị thiếu và giữ đúng ý phủ định.
- Nguồn PDF: “...”
- Bản dịch hiện tại: “Không tìm thấy đoạn tương ứng trong bản dịch.”

### Coverage

- Trạng thái: Chưa đủ bằng chứng xác nhận đã kiểm hết chunk.
- Checkpoint lỗi — Phủ định/mức độ chắc chắn
  - Nguồn PDF: “...”
  - Bản dịch hiện tại: “...”

---

# Nội dung bản dịch

...
```

Quy tắc định dạng:

- Header luôn đứng trước nội dung dịch và chỉ xuất hiện một lần trong mỗi lần dựng kết quả.
- Các phần cảnh báo sắp theo `chunkIndex`; lỗi và checkpoint giữ thứ tự trong báo cáo cuối.
- Trang đơn hiển thị `trang 9`; khoảng trang hiển thị `trang 3–4`; thiếu page range thì dùng `Phần N`.
- Chỉ dùng `reverifyReport` mới nhất nếu có; nếu không có thì dùng `verificationReport`.
- Không hiển thị finding từ audit ban đầu nếu finding đó đã được sửa và xác minh cuối không còn báo lại.
- `targetExcerpt` rỗng ở lỗi omission được diễn giải là không tìm thấy đoạn tương ứng, không in chuỗi rỗng khó hiểu.
- Trích đoạn được chuẩn hóa thành văn bản ngắn an toàn cho Markdown; không cho nội dung báo cáo tự tạo heading, HTML hoặc code block ngoài ý muốn.
- Không in raw prompt, metadata token, key index, stack trace, nội dung suy luận hoặc mã lỗi kỹ thuật thô.
- Nếu báo cáo cũ thiếu trường tùy chọn, dùng câu fallback rõ ràng thay vì làm hỏng download.

## 8. Thiết kế dữ liệu và luồng xử lý

### 8.1. Dữ liệu additive cho lỗi kỹ thuật

Bổ sung một object nullable trên `TranslationChunk`, tên dự kiến `qualityReviewReason`:

```text
qualityReviewReason:
  kind: repair_output_invalid
  stage: repair
  errorCode: GEMINI_OUTPUT_TRUNCATED | GEMINI_BLOCKED | GEMINI_RESPONSE_INVALID | GEMINI_SCHEMA_INVALID
  occurredAt: Date
```

Quy tắc:

- Chỉ ghi khi lỗi kỹ thuật trực tiếp khiến chunk chuyển `needs_review`.
- Không lưu raw error message nếu message có nguy cơ chứa nội dung response.
- Renderer dùng bảng ánh xạ nội bộ để chuyển `errorCode` thành diễn giải tiếng Việt.
- Job/chunk cũ không có object này vẫn đọc bình thường; renderer suy luận từ báo cáo cuối và dùng fallback nếu không đủ dữ liệu.
- Không cần migration bắt buộc vì thay đổi additive và nullable.

### 8.2. Nguồn sự thật của header

Theo thứ tự ưu tiên:

1. Chỉ lấy các chunk có `qualityStatus = needs_review`.
2. Dùng `reverifyReport` nếu có, nếu không dùng `verificationReport`.
3. Dùng `qualityReviewReason` để bổ sung lý do kỹ thuật cuối cùng.
4. Dùng `content` hiện tại làm tham chiếu tính số checkpoint coverage tối thiểu khi cần giải thích checklist quá ngắn.
5. Nếu không có báo cáo hoặc reason, hiển thị cảnh báo tổng quát rằng hệ thống không đủ dữ liệu để tự xác nhận; không tự bịa nguyên nhân.

### 8.3. Dựng kết quả mà không làm bẩn artifact

Tạo một helper/service thuần nhận `{ job, reviewChunks }` và trả về chuỗi header hoặc chuỗi rỗng. Hai endpoint hiện có cùng gọi helper:

- API result: lấy các chunk cần thiết, dựng `header + nội dung dịch`, trả cho Preview và Copy Markdown.
- API download: dựng và `write` header trước, sau đó tiếp tục stream từng chunk content như hiện tại.

Không cập nhật `TranslationChunk.content`, không cache header trong job và không nối header vào kết quả nhiều lần. Nhờ đó retry/resume pipeline và dữ liệu dịch chuẩn không thay đổi.

### 8.4. Ánh xạ nội dung cho người đọc

Category được dịch thống nhất:

| Mã | Nhãn tiếng Việt |
| --- | --- |
| `mistranslation` | Dịch sai nghĩa |
| `omission` | Thiếu nội dung |
| `addition` | Thêm nội dung không có trong nguồn |
| `terminology` | Thuật ngữ chưa chính xác |
| `negation_modality` | Sai phủ định hoặc mức độ chắc chắn |
| `causal_relation` | Sai quan hệ nguyên nhân–kết quả |
| `number_unit` | Sai số liệu hoặc đơn vị |
| `table_figure` | Sai hoặc thiếu nội dung bảng/hình |
| `formatting` | Lỗi định dạng ảnh hưởng nội dung |

Coverage focus cũng được ánh xạ sang tiếng Việt. Giá trị lạ từ dữ liệu cũ dùng nhãn `Vấn đề chưa phân loại`, không gây lỗi endpoint.

## 9. Chỉ tiêu thành công

P004 được coi là hoàn thành khi đạt đồng thời:

1. Mọi job quality hoàn thành có `needs_review` nhận đúng một header cảnh báo khi Preview, Copy hoặc Download.
2. Header chỉ nêu lỗi còn tồn tại trong báo cáo xác minh cuối, không đưa lại lỗi audit đã được sửa.
3. Người đọc biết phần/trang, loại và mức độ lỗi, diễn giải, yêu cầu sửa, trích đoạn có sẵn, coverage và số vòng sửa.
4. Lỗi kỹ thuật dẫn đến `needs_review` được diễn giải dễ hiểu nhưng không lộ raw response hoặc thông tin nhạy cảm.
5. Job quality đạt toàn bộ và job legacy trả nội dung byte-for-byte như trước.
6. Preview/Copy và Download có cùng header và cùng nội dung dịch theo thứ tự chunk.
7. Không thay đổi `TranslationChunk.content`, không ảnh hưởng resume/retry và không chèn lặp.
8. Toàn bộ logic mới được kiểm bằng test thuần/mocked data; không cần PDF hoặc dịch vụ thật.

## 10. Bảng tiến độ tổng

| Giai đoạn | Nội dung | Trạng thái | Cổng nghiệm thu |
| --- | --- | --- | --- |
| G0 | Chốt yêu cầu, bảo toàn worktree và baseline | Hoàn thành | Tài liệu P004 được tạo; baseline test hiện tại được ghi nhận |
| G1 | Chuẩn hóa mô hình cảnh báo và Markdown renderer | Hoàn thành | Renderer thuần bao phủ mọi loại report và fallback |
| G2 | Giữ nguyên nhân lỗi kỹ thuật trên chunk | Hoàn thành | Invalid repair persist reason an toàn và resume tương thích |
| G3 | Tích hợp API result và download | Hoàn thành | Preview/Copy/Download nhất quán, legacy không đổi |
| G4 | Hoàn thiện trải nghiệm frontend | Hoàn thành | Card giữ warning ngắn; preview render header dễ đọc và accessible |
| G5 | Unit test, regression và build | Hoàn thành | Tất cả test logic/mock, lint và build đạt; không gọi dịch vụ thật |
| G6 | Review, tài liệu vận hành và đóng dự án | Hoàn thành | Checklist nghiệm thu đạt, quyết định và bằng chứng được cập nhật |

---

## G0 — Chốt yêu cầu, bảo toàn worktree và baseline

Mục tiêu: xác định đúng phạm vi và không ghi đè các thay đổi hiện có trong repository.

- [x] **P004-G0-S01 — Chốt phương án sản phẩm.** Bỏ phương án báo cáo lớn theo thư mục; chọn header theo từng file.
- [x] **P004-G0-S02 — Chốt mức chi tiết.** Có trích đoạn nguồn/đích và diễn giải đầy đủ thông tin hệ thống biết; không xuất log thô.
- [x] **P004-G0-S03 — Chốt kênh hiển thị.** Preview, Copy Markdown và Download phải nhất quán.
- [x] **P004-G0-S04 — Tạo hồ sơ dự án.** Tạo `project 004.md` với mã bước, cổng nghiệm thu và nhật ký quyết định.
- [x] **P004-G0-S05 — Ghi baseline repository.** Ghi commit hiện tại, Node/npm, backend test, frontend test/lint/build; không sửa các thay đổi ngoài P004.
- [x] **P004-G0-S06 — Trace caller.** Xác nhận mọi đường ghép/trả Markdown để không bỏ sót endpoint hoặc tạo hai implementation khác nhau.
- [x] **P004-G0-S07 — Chốt fixture thuần.** Tạo object fixture nhỏ cho PASS, FAIL theo từng category, coverage thiếu, invalid repair và legacy.

## G1 — Chuẩn hóa mô hình cảnh báo và Markdown renderer

Mục tiêu: một hàm thuần duy nhất biến dữ liệu quality thành Markdown dễ hiểu.

- [x] **P004-G1-S01 — Tạo ánh xạ nhãn.** Map category, severity, coverage focus và error code sang tiếng Việt; có fallback cho dữ liệu lạ.
- [x] **P004-G1-S02 — Chọn báo cáo cuối.** Ưu tiên reverify rồi verification; không dùng audit làm lỗi tồn tại.
- [x] **P004-G1-S03 — Phân loại lý do.** Phân biệt verification fail, coverage incomplete/checklist thiếu, invalid repair và dữ liệu cảnh báo cũ không đầy đủ.
- [x] **P004-G1-S04 — Dựng phần tổng quan.** Ghi số chunk đạt/cần xem lại và nhắc đối chiếu PDF gốc.
- [x] **P004-G1-S05 — Dựng từng chunk.** Ghi phần/trang, repair count, lý do cuối, danh sách lỗi và coverage.
- [x] **P004-G1-S06 — Chuẩn hóa excerpt.** Giữ nội dung có ích nhưng vô hiệu hóa Markdown control ngoài ý muốn; omission rỗng có câu diễn giải.
- [x] **P004-G1-S07 — Bảo đảm idempotent.** Renderer không sửa input, không lưu header và mỗi lần gọi trả cùng kết quả.
- [x] **P004-G1-S08 — Unit test renderer.** Dùng fixture thuần kiểm thứ tự, wording, fallback, escaping và trường hợp không cần header.

## G2 — Giữ nguyên nhân lỗi kỹ thuật trên chunk

Mục tiêu: không mất thông tin khi repair trả output không hợp lệ và chunk phải chuyển `needs_review`.

- [x] **P004-G2-S01 — Mở rộng schema additive.** Thêm `qualityReviewReason` nullable với kind, stage, errorCode và occurredAt.
- [x] **P004-G2-S02 — Truyền nguyên nhân qua pipeline.** Khi bắt invalid repair, giữ error code an toàn thay vì chỉ `{ invalid: true }`.
- [x] **P004-G2-S03 — Persist cùng transition.** Ghi reason nguyên tử khi chuyển chunk sang `needs_review`.
- [x] **P004-G2-S04 — Không lưu dữ liệu thô.** Xác nhận schema/transition không lưu prompt, response, stack hoặc API key.
- [x] **P004-G2-S05 — Tương thích resume.** Chunk terminal cũ vẫn được dùng; chunk dở không bị reset chỉ vì thiếu field P004.
- [x] **P004-G2-S06 — Unit test state machine.** Mock executor/model để kiểm từng error code, transition và dữ liệu persisted; không gọi Gemini.

## G3 — Tích hợp API result và download

Mục tiêu: mọi cách lấy bản dịch dùng cùng một header nhưng vẫn giữ streaming download.

- [x] **P004-G3-S01 — Tạo projection tối thiểu.** Chỉ query field cần cho header, không trả report qua public summary/SSE.
- [x] **P004-G3-S02 — Tích hợp API result.** Ghép header trước result/chunks cho Preview và Copy.
- [x] **P004-G3-S03 — Tích hợp download stream.** Write header một lần rồi stream chunk content theo thứ tự hiện tại.
- [x] **P004-G3-S04 — Xử lý legacy result.** Nếu job cũ dùng `job.result`, chỉ thêm header khi thực sự có quality warning và dữ liệu chunk tương ứng.
- [x] **P004-G3-S05 — Xử lý dữ liệu cũ.** Missing report/reason tạo cảnh báo tổng quát, không trả 500.
- [x] **P004-G3-S06 — Kiểm tính nhất quán.** Cùng job fixture phải cho phần header giống hệt giữa result và download.
- [x] **P004-G3-S07 — Kiểm không chèn lặp.** Gọi endpoint nhiều lần không thay đổi DB và không nhân đôi header.

## G4 — Hoàn thiện trải nghiệm frontend

Mục tiêu: thông tin mới dễ nhận biết nhưng không làm card danh sách quá dài.

- [x] **P004-G4-S01 — Giữ card gọn.** Card tiếp tục hiển thị tổng số chunk và page range như hiện tại.
- [x] **P004-G4-S02 — Preview header.** Xác nhận ReactMarkdown hiển thị heading, blockquote, danh sách và separator đúng.
- [x] **P004-G4-S03 — Copy nhất quán.** Copy lấy chính chuỗi result đã có header, không tự dựng cảnh báo ở client.
- [x] **P004-G4-S04 — Accessibility.** Heading có thứ bậc hợp lý; cảnh báo không chỉ dựa vào màu hoặc emoji.
- [x] **P004-G4-S05 — Frontend unit test.** Mock API result có/không có header và kiểm Preview/Copy; không cần backend hay PDF thật.

## G5 — Unit test, regression và build

Mục tiêu: kiểm logic đủ chặt trong phạm vi không dùng tài liệu/dịch vụ thật đã được chủ dự án chấp nhận.

- [x] **P004-G5-S01 — Category/severity matrix.** Test đủ 9 category, 3 severity và fallback unknown.
- [x] **P004-G5-S02 — Coverage matrix.** Test COMPLETE, INCOMPLETE, checkpoint error, checklist thiếu số lượng và missing coverage cũ.
- [x] **P004-G5-S03 — Technical reason matrix.** Test blocked, truncated, empty/invalid response và schema invalid.
- [x] **P004-G5-S04 — Output compatibility.** PASS quality và legacy giữ nguyên nội dung; warning job có đúng một header.
- [x] **P004-G5-S05 — Controller mock test.** Mock model/cursor để kiểm result và streaming download mà không khởi động Mongo/R2.
- [x] **P004-G5-S06 — Backend regression.** Chạy test backend hiện có; không chạy script smoke/benchmark có dịch vụ thật.
- [x] **P004-G5-S07 — Frontend regression.** Chạy unit test, lint và production build frontend.
- [x] **P004-G5-S08 — Rà soát bảo mật.** Test excerpt lạ không chèn HTML/Markdown ngoài ý muốn và output không chứa raw diagnostic nhạy cảm.
- [x] **P004-G5-S09 — Ghi bằng chứng.** Ghi lệnh, số test pass/fail và kết quả build vào Nhật ký bằng chứng.

## G6 — Review, tài liệu vận hành và đóng dự án

Mục tiêu: bàn giao thay đổi có thể tự kiểm tra khi người dùng bắt đầu dùng file thật.

- [x] **P004-G6-S01 — Review diff.** Xác nhận thay đổi tối thiểu, không tạo abstraction dư thừa và không chạm pipeline dịch ngoài việc giữ reason.
- [x] **P004-G6-S02 — Cập nhật README.** Mô tả file cảnh báo, ý nghĩa severity/coverage và giới hạn của tự động kiểm định.
- [x] **P004-G6-S03 — Hướng dẫn review thực tế.** Nêu cách tìm PDF gốc theo tên file, trang, source excerpt và target excerpt.
- [x] **P004-G6-S04 — Ghi giới hạn test.** Nêu rõ P004 không dùng PDF/Gemini/R2/Mongo production theo quyết định chủ dự án.
- [x] **P004-G6-S05 — Theo dõi phản hồi sử dụng.** Nếu file thật lộ wording khó hiểu, thiếu excerpt hoặc lệch trang, ghi issue mới với job/chunk metadata đã ẩn nội dung nhạy cảm.
- [x] **P004-G6-S06 — Đóng checklist.** Mọi chỉ tiêu thành công và test logic đạt; cập nhật trạng thái tổng thành hoàn thành.

## 11. Ma trận tình huống đầu ra

| Tình huống | Header | Nội dung phải nêu |
| --- | --- | --- |
| Job legacy completed | Không | Nội dung cũ không đổi |
| Quality completed, tất cả passed | Không | Nội dung dịch không đổi |
| Verify FAIL, hết vòng sửa | Có | Lỗi cuối, severity, category, correction và excerpt |
| Reverify FAIL, hết vòng sửa | Có | Báo cáo reverify mới nhất, không dùng lỗi verify cũ đã hết |
| Coverage `INCOMPLETE` | Có | Chưa đủ bằng chứng coverage và checkpoint lỗi có sẵn |
| Coverage `COMPLETE` nhưng checklist quá ngắn | Có | Số checkpoint hiện có so với mức tối thiểu cần có |
| Repair output invalid | Có | Diễn giải nguyên nhân kỹ thuật và các lỗi nội dung dẫn tới repair nếu còn báo cáo |
| Report cũ thiếu field | Có | Warning tổng quát và mọi thông tin còn đọc được |
| Nhiều warning chunk | Có | Sắp theo phần/trang, mỗi chunk tách rõ |
| Gọi API/download lặp lại | Có đúng một lần | Không sửa DB, không chèn lặp |

## 12. Rủi ro và biện pháp kiểm soát

| Rủi ro | Biện pháp |
| --- | --- |
| Header làm thay đổi artifact dịch dùng cho resume | Chỉ dựng lúc trả output; không persist vào `content` |
| Preview và download khác nhau | Một renderer chung; contract test hai endpoint |
| Báo lại lỗi đã được sửa | Chỉ dùng report xác minh cuối cùng |
| Dữ liệu cũ làm endpoint lỗi | Field additive, null-safe và fallback wording |
| Excerpt làm hỏng Markdown | Chuẩn hóa/escape trước khi render |
| Log kỹ thuật gây khó hiểu hoặc lộ dữ liệu | Chỉ lưu code an toàn và ánh xạ sang lời giải thích |
| Header quá dài | Chỉ có trên file cần review; giữ đầy đủ evidence theo quyết định chủ dự án |
| Người đọc coi cảnh báo AI là kết luận chuyên môn | Ghi disclaimer và yêu cầu đối chiếu PDF gốc |
| Unit test không bắt được lỗi tài liệu thật | Ghi rõ giới hạn; tiếp nhận review sử dụng thực tế thành issue sau P004 |

## 13. Nhật ký quyết định

| Ngày | Mã | Quyết định | Trạng thái |
| --- | --- | --- | --- |
| 17-07-2026 | D001 | Không tạo báo cáo Markdown lớn cho cả thư mục | Đã chốt |
| 17-07-2026 | D002 | Chèn cảnh báo vào đầu từng file có `needs_review` | Đã chốt |
| 17-07-2026 | D003 | Hiển thị giống nhau trong Preview, Copy và Download | Đã chốt |
| 17-07-2026 | D004 | Có trích đoạn nguồn/đích và diễn giải đầy đủ thông tin hệ thống biết | Đã chốt |
| 17-07-2026 | D005 | Không xuất log kỹ thuật thô; chuyển thành lời giải thích phù hợp người đọc | Đã chốt |
| 17-07-2026 | D006 | Không dùng file PDF thật hoặc dịch vụ thật trong bước test P004 | Đã chốt |
| 17-07-2026 | D007 | Người dùng sẽ review khi sử dụng thực tế và báo lại nếu có vấn đề | Đã chốt |
| 17-07-2026 | D008 | Chuẩn hóa excerpt về một dòng và giới hạn 500 ký tự; có thể tăng/cấu hình hóa nếu review thực tế cần thêm ngữ cảnh | Đã chốt |

## 14. Nhật ký bằng chứng

| Ngày | Mã | Bằng chứng | Kết quả |
| --- | --- | --- | --- |
| 17-07-2026 | E001 | Kiểm tra schema `TranslationChunk`, quality state machine, public quality view, result/download controller và frontend `JobCard` | Xác nhận report chi tiết đã persist nhưng public warning hiện chỉ có phần/trang; invalid repair chưa giữ error code |
| 17-07-2026 | E002 | Chủ dự án chọn header theo file, có evidence, hiển thị ở Preview/Copy/Download và không dùng test PDF thật | Phạm vi P004 đã decision-complete |
| 17-07-2026 | E003 | Baseline commit `5edce7aa58f067d3685a51b9eda23db43a25317a`, Node `v22.17.1`, npm `10.9.2`; `npm test` backend và `npm test; npm run lint; npm run build` frontend | Backend 94/94 pass; frontend 12/12 pass; lint/build pass trước thay đổi P004 |
| 17-07-2026 | E004 | Unit test renderer/state/schema/controller và frontend Preview/Copy bằng fixture/mock thuần | Bao phủ 9 category, 3 severity, coverage fallback, 4 mã repair invalid, escaping, final-report priority, idempotency và result/download equality |
| 17-07-2026 | E005 | Regression cuối: `npm test` backend; `npm test; npm run lint; npm run build` frontend | Backend 104/104 pass; frontend 13/13 pass; lint pass; Vite production build pass; không gọi dịch vụ thật |

## 15. Tiêu chí đóng dự án

- [x] Tất cả bước bắt buộc G0–G6 hoàn thành hoặc được chủ dự án miễn rõ ràng trong Nhật ký quyết định.
- [x] Backend unit/regression test đạt mà không gọi dịch vụ thật.
- [x] Frontend unit test, lint và build đạt.
- [x] Quality PASS và legacy output không đổi.
- [x] Quality warning output có đúng một header đầy đủ và dễ hiểu.
- [x] Không có raw prompt/response, API key, stack trace hoặc nội dung suy luận trong header.
- [x] README và tài liệu này phản ánh đúng hành vi cuối cùng.
- [x] Phản hồi từ việc dùng file thật, nếu có, được ghi thành issue mới thay vì âm thầm đổi tiêu chí P004.
