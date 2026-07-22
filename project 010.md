# Project 010 — Nâng cấp Gemini 3.1 Flash-Lite lên Gemini 3.5 Flash-Lite

## 1. Mục tiêu và quyết định

Nâng backend StudyMed Translator từ `gemini-3.1-flash-lite` lên model GA
`gemini-3.5-flash-lite` mà không thay đổi kiến trúc queue, lưu trữ R2, MongoDB,
API frontend hoặc các artifact đã hoàn thành.

Quyết định kỹ thuật đã chốt:

| Hạng mục | Giá trị sau P010 | Lý do |
|---|---|---|
| Model | `gemini-3.5-flash-lite` | Model thay thế chính thức cho 3.1 Flash-Lite; hỗ trợ PDF, Files API, structured output và thinking. |
| Thinking quality pipeline | `HIGH`, không trả thoughts | Giữ chiều sâu suy luận cho dịch/kiểm định y khoa; 3.5 Flash-Lite hỗ trợ mức này. |
| `maxOutputTokens` — translate/revise/repair | `65536` | Ưu tiên tránh cắt ngắn bản dịch dài khi dùng thinking `HIGH`. |
| `maxOutputTokens` — document context/audit/verify/reverify JSON | `16384` | JSON kiểm định có schema, không cần mở rộng; trần chặt giúp output ổn định. |
| `temperature`, `topP`, `topK` | Không gửi | Google đã deprecate; hiện bị bỏ qua và model thế hệ sau có thể trả HTTP 400. |
| API style | Giữ `models.generateContent` | Luồng hiện tại là một turn PDF, không cần chuyển Interactions API trong P010. |

P010 không xét giá model. Việc thay đổi RPM/TPM/RPD chỉ thực hiện nếu hạn mức thực tế
của project/API key khác với giả định hiện hành.

## 2. Phạm vi và bất biến

### Trong phạm vi

- Cấu hình model mặc định, `.env.example` và hướng dẫn vận hành.
- Payload `generationConfig` gửi Gemini.
- Phiên bản `@google/genai` theo khuyến nghị tương thích của Google.
- Unit test, smoke test thật và canary PDF y khoa.
- Theo dõi telemetry model/version, finish reason, JSON schema, coverage và timeout.

### Ngoài phạm vi

- Không đổi Mongo schema, R2 layout, API REST frontend hoặc prompt nghiệp vụ. Pipeline version tăng từ `p003-v3` lên `p010-v1` chỉ để reset artifact quality dở dang, tránh một chunk tiếp tục giữa hai model.
- Không sửa lại kết quả, artifact hay báo cáo lịch sử trong `archive/`.
- Không chuyển model giữa một job đang chạy.
- Không nâng concurrency chỉ vì đổi model.

### Điều kiện bất biến bắt buộc

1. Không công khai API key, PDF, prompt hoặc artifact nội bộ trong log/public API.
2. Audit/verify chỉ được PASS khi JSON hợp lệ và coverage `COMPLETE`.
3. Revision/repair vẫn phải qua guard giữ tối thiểu 80% nội dung có nghĩa.
4. Mọi job quality dở dang phải có thể resume an toàn từ stage đã persist.
5. Không deploy khi queue vẫn còn job `processing`.

## 3. Hiện trạng cần nâng cấp

| ID | Thành phần | Hiện trạng | Thay đổi P010 |
|---|---|---|---|
| P010-C01 | `src/config/env.js` | Fallback `gemini-3.1-flash-lite` | Đổi fallback thành `gemini-3.5-flash-lite`. |
| P010-C02 | `.env.example` | Khai báo model 3.1 | Đổi thành 3.5 để môi trường mới không quay về model cũ. |
| P010-C03 | `src/services/translationProfiles.js` | Gửi `temperature` cho legacy và quality; output quality 32768 | Xóa `temperature`; nâng output text quality lên 65536. |
| P010-C04 | `src/services/qualityGeminiExecutors.js` | Mọi stage gửi `temperature: 1`; output text 32768 | Xóa `temperature`; text stage 65536; JSON stage giữ 16384. |
| P010-C05 | `package.json`/lockfile | `@google/genai` 1.52.0 | Nâng lên v2 hoặc mới hơn sau khi kiểm tra breaking change; không dùng `^1.x` cho việc này. |
| P010-C06 | Backend tests | Assert rằng `temperature` tồn tại | Đổi assert để xác nhận `temperature` không được gửi; xác nhận output ceiling mới. |
| P010-C07 | README vận hành | Chưa nêu model P010 | Ghi model mặc định, quy trình canary và rollback. |

Frontend không gọi Gemini trực tiếp; không có thay đổi frontend dự kiến.

## Tiến độ thực hiện

| Task | Trạng thái | Ghi chú |
|---|---|---|
| P010-G0-S01 đến S03 | Đã thực hiện cục bộ | Baseline ghi nhận Node 22; test Retry-After đã được làm deterministic bằng clock giả thay vì phụ thuộc `Date.now()`. |
| P010-G1-S01 đến S04 | Đã thực hiện cục bộ | SDK nâng lên 2.13.0, Node 22 tương thích; backend đạt 133/133 và frontend đạt 30/30 test. |
| P010-G2-S01 đến S06 | Đã thực hiện cục bộ | Model/config/test/README đã được cập nhật; pipeline version là `p010-v1`. |
| P010-G3-S02 đến S04 | Đã đạt trong môi trường cục bộ/API thật | 24/24 key trong `.env` mới tương thích payload P010. `smoke:p010-gemini` xác nhận text 65536, JSON schema 16384, thinking HIGH và Gemini Files API PDF đều trả `STOP` từ model 3.5. Smoke quality end-to-end đạt và được lưu tại `project-010-quality-smoke-report.json`. |
| P010-G4 đến G6 | Chờ canary/deploy | Cần corpus đã được reviewer duyệt và quyền thao tác môi trường Render production. |

### Kết quả kiểm chứng trước redeploy — 22/07/2026

- `.env` cục bộ: hợp lệ, model `gemini-3.5-flash-lite`, 24 key, quality mode, thinking `HIGH`, timeout 180 giây.
- Key compatibility: 24/24 trả đúng `modelVersion=gemini-3.5-flash-lite` và `finishReason=STOP` với payload text P010.
- Contract smoke: text 65536, structured JSON 16384 và Gemini Files API PDF đều đạt.
- Quality smoke end-to-end: `document_context → translate → medical_audit → revise → verify → completed`; quality `passed`, không repair, không `needs_review`.
- Báo cáo smoke: model cấu hình và model thực tế đều là `gemini-3.5-flash-lite`; pipeline `p010-v1`; preview/download đều HTTP 200 và khớp nội dung.
- Test isolation: `test/setup-env.js` đặt rõ các giá trị mặc định kiểm thử trước khi đọc `.env`, nên biến production vừa tải từ Render không làm thay đổi kỳ vọng unit test; file `.env` không bị sửa.
- Final gate: backend 133/133, frontend 30/30, `git diff --check` không có lỗi và không còn runner kiểm thử chạy nền.
- Cleanup: R2 source đã xóa, Gemini File tạm đã xóa, Mongo database cô lập đã drop.
- Trạng thái rollout: sẵn sàng cho maintenance pause và redeploy; chưa xác nhận production sau deploy.

## 4. Kế hoạch theo giai đoạn

Mỗi giai đoạn chỉ được chuyển sang giai đoạn kế tiếp khi toàn bộ tiêu chí đạt đã thỏa.
Mỗi task cần một commit hoặc một nhóm commit riêng có message chứa ID task để truy vết.

### Giai đoạn 0 — Baseline và khóa thay đổi

**Mục đích:** chứng minh trạng thái trước nâng cấp và tránh kết quả lai model.

| Task | Công việc | Bằng chứng hoàn thành |
|---|---|---|
| P010-G0-S01 | Ghi nhận commit SHA, `node --version`, `npm --version`, phiên bản SDK cài thực tế và `GEMINI_MODEL` đã được che giá trị nếu cần. | Baseline trong PR/deployment note, không có secret. |
| P010-G0-S02 | Chạy `npm test` ở backend và `npm test` ở frontend. | Log pass/fail và số test. |
| P010-G0-S03 | Chạy lại riêng test scheduler nếu có lỗi Retry-After không ổn định. | Xác định pass ổn định hoặc mở ticket riêng; không gộp lỗi flaky vào P010. |
| P010-G0-S04 | Kiểm tra queue production; lên lịch maintenance pause. | Xác nhận không còn job `processing` trước deploy. |

**Gate đạt:** test baseline xanh; các thay đổi ngoài P010 được tách riêng; có cửa sổ deploy.

**Dừng nếu:** test baseline lỗi tái lập, hoặc có job đang xử lý mà chưa thể pause an toàn.

### Giai đoạn 1 — Nâng SDK có kiểm soát

**Mục đích:** dùng SDK được Google khuyến nghị cho model mới trước khi đổi model production.

| Task | Công việc | Kiểm tra |
|---|---|---|
| P010-G1-S01 | Đọc breaking changes của `@google/genai` v2 phù hợp với `GoogleGenAI`, `models.generateContent`, `files.upload/get/delete` và `abortSignal`. | Danh sách API đang dùng và tác động. |
| P010-G1-S02 | Nâng dependency/lockfile lên v2 hoặc phiên bản mới hơn đã chọn. | `npm ls @google/genai --depth=0` trả đúng version. |
| P010-G1-S03 | Sửa tối thiểu các lời gọi bị breaking change, nếu có. | Không thay đổi prompt/schema/pipeline ngoài tương thích SDK. |
| P010-G1-S04 | Chạy toàn bộ test backend/frontend. | Tất cả test pass. |

**Gate đạt:** không còn lỗi import/type/runtime với 4 API SDK đang dùng; test xanh.

**Rollback:** khôi phục dependency/lockfile về version baseline, chưa đổi `GEMINI_MODEL`.

### Giai đoạn 2 — Thay đổi cấu hình và request contract

**Mục đích:** áp dụng contract đúng của Gemini 3.5 Flash-Lite.

| Task | Công việc | Kiểm tra tự động tối thiểu |
|---|---|---|
| P010-G2-S01 | Đổi model fallback và `.env.example` sang `gemini-3.5-flash-lite`. | Test hoặc kiểm tra config xác nhận default mới. |
| P010-G2-S02 | Xóa toàn bộ `temperature` ở mọi request path (legacy, quality text, quality JSON). | Test adapter assert config không có key `temperature`. |
| P010-G2-S03 | Đặt text stage `maxOutputTokens: 65536`. | Test profile/executor assert giá trị 65536. |
| P010-G2-S04 | Giữ JSON stage `maxOutputTokens: 16384`, `responseMimeType: application/json`, `responseJsonSchema` và validator nghiệp vụ. | Test audit/verify/reverify assert config JSON không đổi ngoài `temperature`. |
| P010-G2-S05 | Giữ `thinkingLevel: HIGH`, `includeThoughts: false`. | Test quality executor assert hai field tồn tại. |
| P010-G2-S06 | Cập nhật README và ghi rõ biến Render bắt buộc. | Review tài liệu. |

**Gate đạt:**

- Không còn `temperature`, `topP`, `topK`, `thinkingBudget` hoặc `candidateCount` trong payload runtime.
- Request text có trần 65536; request JSON vẫn 16384.
- Các test config/adapter/executor pass.

**Dừng nếu:** SDK/model trả lỗi 400 về field config hoặc enum thinking.

### Giai đoạn 3 — Smoke test API thật trong môi trường kiểm soát

**Mục đích:** xác nhận model ID mới hoạt động với key, PDF, Files API và schema thật.

| Task | Công việc | Tiêu chí đạt |
|---|---|---|
| P010-G3-S01 | Đặt tạm `GEMINI_MODEL=gemini-3.5-flash-lite` trong môi trường kiểm thử kín. | Không commit `.env` hay log key. |
| P010-G3-S02 | Chạy script kiểm tra key với model mới. | Các key hợp lệ nhận response; 401/403/429 được phân loại đúng. |
| P010-G3-S03 | Chạy smoke quality trên một PDF y khoa nhỏ, đại diện 1–2 trang. | Đủ stages; `finishReason=STOP`; `modelVersion` phản ánh 3.5; JSON parse/schema pass. |
| P010-G3-S04 | Kiểm tra File API context được xóa trong `finally`. | Không còn file context tạm sau success và error. |
| P010-G3-S05 | Cố ý dùng fixture JSON lỗi/cắt output để xác nhận retry, rotate key và `needs_review` không đổi hành vi. | Không có PASS giả. |

**Gate đạt:** không có `GEMINI_CONFIG`, không có HTTP 400 do generation config, không có regression schema/coverage, latency thấp hơn timeout 180 giây.

**Dừng nếu:** `MAX_TOKENS` vẫn xuất hiện ở text stage 65536, JSON không khớp schema, File API lỗi, hoặc timeout lặp lại.

### Giai đoạn 4 — Canary chất lượng và đối chiếu chuyên môn

**Mục đích:** đo chất lượng dịch y khoa, không chỉ kiểm tra endpoint.

| Task | Công việc | Tiêu chí đạt |
|---|---|---|
| P010-G4-S01 | Chọn corpus canary nhỏ, đã khử thông tin nhạy cảm: bệnh học, thần kinh, tim mạch, thận; có bảng, đơn vị, viết tắt và thuật ngữ. | Mỗi nhóm có ít nhất một PDF đối chiếu. |
| P010-G4-S02 | Chạy cùng corpus với baseline 3.1 đã lưu và 3.5 mới. | Kết quả gắn rõ model/version. |
| P010-G4-S03 | Reviewer đối chiếu PDF gốc, bản dịch và report audit/verify. | Không tăng lỗi nghiêm trọng; không mất đoạn; đơn vị/liều/tên thuốc chính xác. |
| P010-G4-S04 | Tổng hợp telemetry theo stage: latency, token, finish reason, schema invalid, coverage incomplete, repair count, needs-review. | Không có regression vận hành chưa được chấp thuận. |

**Gate đạt:** reviewer chấp thuận corpus; không có lỗi nghiêm trọng mới; tỷ lệ `needs_review` và retry không xấu hơn baseline một cách có ý nghĩa.

**Dừng nếu:** mất nội dung, sai liều/đơn vị/thuật ngữ y khoa, hoặc model tạo output dài gây timeout/hàng đợi tích tụ.

### Giai đoạn 5 — Deploy production có khả năng rollback

**Mục đích:** chuyển model mà không tạo job lai hoặc mất khả năng phục hồi.

1. Thông báo cửa sổ deploy và không nhận batch mới nếu cần.
2. Dùng **Tạm dừng để redeploy**; đợi `activeJobs = 0` và không còn job `processing`.
3. Đặt rõ trên Render: `GEMINI_MODEL=gemini-3.5-flash-lite`.
4. Deploy đúng artifact đã qua G0–G4.
5. Kiểm tra `/api/readiness`, `/api/translate/status`, `/api/translate/metrics` và một job canary sau deploy.
6. Theo dõi tối thiểu một chu kỳ queue hoặc 24 giờ vận hành thực tế, tùy điều kiện nào dài hơn.

**Gate hoàn tất:** model telemetry là 3.5; queue hồi phục bình thường; không có lỗi config, 400 generation config hoặc tăng đột biến `needs_review`/timeout.

**Rollback:** pause queue, đặt `GEMINI_MODEL=gemini-3.1-flash-lite`, redeploy artifact/SDK baseline nếu lỗi do SDK. Không cần migration database và không rewrite job đã hoàn thành.

### Giai đoạn 6 — Đóng P010

| Task | Công việc | Bằng chứng |
|---|---|---|
| P010-G6-S01 | Tổng kết metrics trước/sau theo model. | Báo cáo không chứa key/PDF/prompt nội bộ. |
| P010-G6-S02 | Ghi nhận version SDK, model, ngày deploy và commit deploy. | Release note. |
| P010-G6-S03 | Đóng hoặc tách ticket về flaky Retry-After test nếu còn. | Ticket/link commit riêng. |
| P010-G6-S04 | Lưu quyết định giữ 65536 text / 16384 JSON và lý do. | Cập nhật tài liệu vận hành. |

## 5. Ma trận kiểm thử bắt buộc

| Loại | Lệnh/hình thức | Mục tiêu |
|---|---|---|
| Backend unit | `npm test` trong `med-translator-backend` | Adapter, schema, scheduler, quality pipeline, resume/retry. |
| Frontend unit | `npm test` trong `med-translator-frontend` | Xác nhận UI không regression dù không gọi Gemini trực tiếp. |
| Key smoke | `npm run test:keys` với model mới | Xác minh model ID/key/API access. |
| P003 smoke | `npm run smoke:p003-quality` | PDF thật, File API, text output, structured JSON, cleanup. |
| Canary chuyên môn | Corpus đã duyệt + reviewer | Đúng thuật ngữ, liều, đơn vị, không mất nội dung. |
| Rollback drill | Đổi biến model và redeploy trong môi trường thử | Không cần migration, queue resume an toàn. |

## 6. Chỉ số theo dõi và ngưỡng cảnh báo

Theo từng `stage`, log/metrics chỉ dùng metadata công khai đã có: model version, latency,
finish reason, token usage, key index và error code. Không log nội dung PDF hay API key.

| Chỉ số | Cảnh báo | Hành động |
|---|---|---|
| `finishReason=MAX_TOKENS` ở text stage | Xuất hiện bất kỳ lần nào sau khi đã đặt 65536 | Giữ job retryable; kiểm tra PDF/chunking/thinking và timeout. |
| HTTP 400/GEMINI_CONFIG | Xuất hiện sau deploy | Rollback hoặc sửa generation config trước khi tiếp tục. |
| JSON schema invalid | Tăng so với baseline | Dừng rollout; đối chiếu SDK/schema/model response. |
| `coverage=INCOMPLETE` / `needs_review` | Tăng bất thường | Reviewer kiểm tra corpus; không tự nới guard. |
| Latency > 180 giây | Timeout lặp lại | Đánh giá nâng timeout hoặc giảm chunk/page; không hạ tiêu chuẩn y khoa mù quáng. |
| 429 | Tăng nhưng quota không đổi | Kiểm tra headroom scheduler và quota project thực tế. |

## 7. Rủi ro đã biết

1. **SDK v2 có breaking change.** Giảm rủi ro bằng G1 tách riêng, chạy test trước khi đổi model.
2. **Thay đổi hành vi model.** Dù API tương thích, bản dịch và JSON có thể khác; G4 là gate bắt buộc.
3. **Output 65536 có thể kéo dài request.** Đây là quyết định có chủ đích để chống cắt ngắn; theo dõi timeout thay vì coi model mới tự động nhanh hơn.
4. **Job lai model khi deploy vội.** Chặn bằng maintenance pause và `activeJobs = 0`.
5. **Test Retry-After có dấu hiệu không ổn định.** Tách khỏi P010 nếu lỗi không tái lập; không che lỗi bằng retry CI vô hạn.

## 8. Điều kiện hoàn thành P010

P010 chỉ hoàn thành khi tất cả điều kiện sau đúng:

- Production dùng rõ ràng `gemini-3.5-flash-lite`.
- Không gửi sampling parameter đã deprecate.
- Text stage dùng output ceiling 65536; JSON stage giữ 16384.
- Backend/frontend test, smoke API và canary chuyên môn đều đạt.
- Không có migration database; rollback về 3.1 đã được diễn tập hoặc có bằng chứng cấu hình rõ ràng.
- Có release note với commit, phiên bản SDK, thời gian deploy và kết quả theo dõi hậu deploy.
