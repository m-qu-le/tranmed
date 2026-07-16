# PROJECT 003 — Nâng chất lượng dịch sách y khoa chuyên sâu bằng Gemini 3.1 Flash-Lite

## 1. Thông tin dự án

| Thuộc tính | Giá trị |
| --- | --- |
| Mã kế hoạch | P003 |
| Ngày lập | 15-07-2026 |
| Trạng thái tổng | Chủ dự án đã chốt kiến trúc B4 và không yêu cầu blind review; bản production candidate là B4 được gia cố bằng context toàn PDF + coverage v2, còn canary/rollout production đang chờ |
| Mục tiêu chính | Nâng độ chính xác chuyên môn của bản dịch bệnh học, thần kinh, tim mạch, thận và các giáo trình y khoa chuyên sâu mà không đổi khỏi `gemini-3.1-flash-lite` |
| Model sản xuất | `gemini-3.1-flash-lite` |
| Nguồn API | 7 API key thuộc 7 tài khoản/project Free tier độc lập |
| Quota quan sát mỗi project | Khoảng 15 RPM, 250.000 input TPM và 500 RPD; phải đọc lại từ AI Studio trước rollout vì quota có thể thay đổi |
| Hạ tầng giữ nguyên | Vercel frontend, Render backend/worker, MongoDB, Cloudflare R2, Google GenAI SDK |
| Bộ dữ liệu thử nghiệm | 20 PDF thực tế trong `samplepdf/`, tổng 370 trang, khoảng 20,66 MB |
| Cấu hình chunk mục tiêu | 2 trang PDF/chunk |
| Ưu tiên | Chất lượng và khả năng kiểm chứng cao hơn tốc độ; số request không phải ràng buộc chính |

## 2. Cách theo dõi kế hoạch

Quy ước:

- `[ ]`: chưa làm.
- `[x]`: đã hoàn thành và có bằng chứng.
- `BLOCKED`: không thể tiếp tục nếu thiếu quyết định hoặc điều kiện bên ngoài.
- Mỗi bước chỉ được đánh dấu hoàn thành sau khi có test, benchmark, log hoặc bằng chứng production tương ứng.
- Mọi thay đổi kết quả benchmark, quyết định prompt và cấu hình production phải được ghi vào Nhật ký quyết định; không chỉ sửa code mà không cập nhật tài liệu này.
- Không commit API key, nội dung PDF có bản quyền, bản dịch benchmark thô hoặc URL có chữ ký.

## 3. Vấn đề cần giải quyết

Pipeline hiện tại:

- Cắt PDF cố định 3 trang/chunk.
- Gọi Flash-Lite một lần/chunk.
- Dùng `temperature: 0.1`, trái khuyến nghị hiện tại dành cho Gemini 3.
- Không đặt `thinkingLevel`, nên Flash-Lite dùng mặc định `minimal`.
- Chỉ kiểm tra `response.text` có rỗng hay không rồi lưu kết quả.
- Không lưu `finishReason`, token usage, model version hoặc kết quả kiểm định chất lượng.
- Retry 429 nhiều lần trên cùng key trước khi chuyển key, chưa tận dụng tốt 7 project độc lập.

Triệu chứng chính cần sửa là bản dịch không đủ chính xác ở sách chuyên sâu: thuật ngữ đa nghĩa, quan hệ sinh lý–bệnh lý, phủ định, mức độ chắc chắn, nguyên nhân–kết quả, độ chính xác của các thuật ngữ y khoa, diễn đạt học thuật. Mất nội dung hoặc ghép chunk rời rạc có xảy ra ít và không phải động lực chính của P003.

## 4. Các quyết định kiến trúc đã chốt

### 4.1. Không đổi model

- Toàn bộ pipeline sản xuất P003 dùng `gemini-3.1-flash-lite`.
- Không đưa Gemini Pro, Gemini Flash, Cloud Translation hoặc model bên thứ ba vào đường dịch chính.
- Benchmark có thể dùng khả năng đánh giá của Codex và người dùng, nhưng không dùng model khác để tạo bản dịch sản xuất.

### 4.2. Tất cả lượt suy luận sản xuất dùng `high`

- `thinkingConfig.thinkingLevel = HIGH` cho dịch, audit, revision, verification và repair.
- `includeThoughts = false`; chỉ lưu `thoughtsTokenCount`, không yêu cầu nội dung suy luận.
- Dùng `temperature = 1.0` hoặc bỏ trường temperature để nhận đúng mặc định 1.0 của Gemini 3; không tiếp tục dùng 0.1.
- Mọi response phải kiểm tra `finishReason`; `MAX_TOKENS` không được coi là thành công.

### 4.3. Cắt 2 trang/chunk, có context passport nhỏ cho toàn tài liệu

- Đổi `pagesPerChunk` từ 3 xuống 2.
- Tiếp tục gửi PDF native cho Gemini để tận dụng text layer, OCR, bảng và hình ảnh.
- Không thêm pipeline trích xuất toàn bộ sách thành block, không bắt đầu bằng `pdfjs`/OCR riêng và không tạo ID từng đoạn trong P003.
- Trước các chunk, quality v2 gửi nguyên PDF một lần qua Gemini Files API để tạo **context passport** có cấu trúc: chuyên ngành, thuật ngữ, viết tắt, quy tắc nhất quán và điểm rủi ro.
- Passport chỉ là trợ giúp ngắn và PDF 2 trang luôn là thẩm quyền cuối cùng; không biến passport thành bản dịch, glossary lớn hoặc nguồn sự thật độc lập.
- File Gemini là tạm thời: phải xóa ngay sau khi sinh passport. Chỉ passport đã kiểm schema và telemetry được lưu theo job để resume không gọi lại toàn PDF; API công khai không trả nội dung passport.

### 4.4. Không yêu cầu glossary đồ sộ

- Không bắt người dùng tự tạo glossary cho từng sách.
- Không gắn toàn bộ từ điển y khoa vào prompt.
- Passport v2 bị giới hạn kích thước và không tự khóa lỗi: mọi thuật ngữ vẫn phải được PDF chunk xác nhận khi dịch/audit/verify.
- Hướng mở rộng sau P003 là bộ nhớ nhỏ từ các sửa chữa đã được người dùng phê duyệt, chỉ truy xuất những mục thực sự xuất hiện trong chunk.

### 4.5. Pipeline chất lượng có cổng xác minh và vòng lặp hữu hạn

Mỗi job quality v2 bắt đầu bằng một giai đoạn và sau đó mỗi chunk chạy bốn giai đoạn bắt buộc:

```text
PDF toàn tài liệu
    |
    v
S0 DOCUMENT_CONTEXT — passport ngắn, File API tạm thời rồi xóa
    |
    v
PDF 2 trang + context passport
    |
    v
S1 TRANSLATE — dịch toàn văn Markdown, thinking high
    |
    v
S2 MEDICAL_AUDIT — so nguồn và bản dịch, JSON lỗi + checklist coverage có evidence, thinking high
    |
    v
S3 REVISE — chỉ áp dụng lỗi đã xác nhận, trả Markdown hoàn chỉnh, thinking high
    |
    v
S4 VERIFY — kiểm tra lại bản cuối, chỉ PASS khi checklist coverage COMPLETE, thinking high
```

Nếu S4 trả `FAIL`:

```text
S5 REPAIR — sửa có mục tiêu theo lỗi S4, thinking high
    |
    v
S6 REVERIFY — xác minh lần cuối, thinking high
```

- Chỉ cho phép tối đa một chu kỳ repair.
- Nếu S6 vẫn fail, lưu bản tốt nhất, đặt `qualityStatus = needs_review` và hoàn thành job với cảnh báo; không lặp vô hạn.
- S2 và S4 không được viết lại toàn văn nhằm giảm drift và giảm output token.
- Checklist coverage thiếu bằng chứng hoặc chưa đủ độ sâu không được nâng thành PASS: audit sẽ retry/rotate key; verify/reverify sẽ đặt chunk `needs_review`.

### 4.6. Bảy key là bảy quota pool theo project, nhưng không giả định luôn cộng tuyến tính

- Scheduler phân phối request vòng tròn giữa 7 key.
- 429 chuyển ngay sang key/project tiếp theo; không chờ ba lần trên cùng key.
- Chỉ backoff toàn pipeline khi đã thử hết key khả dụng.
- Giữ concurrency chunk toàn cục ở mức 2 trong rollout đầu; chưa tăng theo tổng RPM lý thuyết.
- Theo dõi usage theo key index, tuyệt đối không log giá trị key.

### 4.7. Tương thích và rollback

- Pipeline mới có feature flag/mode `legacy` và `quality`.
- Backend mới phải tiếp tục đọc kết quả/chunk P001–P002.
- Schema chỉ mở rộng additive; migration idempotent và có dry-run.
- Có thể rollback về pipeline một lượt mà không mất kết quả đã hoàn thành.

## 5. Chỉ tiêu thành công

P003 chỉ được coi là thành công nếu đạt đồng thời:

1. Bản `quality` tốt hơn baseline hiện tại trên bộ PDF mẫu về sai nghĩa y khoa, thuật ngữ theo ngữ cảnh, phủ định và quan hệ nhân quả.
2. Không tăng tỷ lệ bỏ sót nội dung, đổi số liệu, hỏng bảng/hình hoặc Markdown.
3. Không có chunk nào được coi thành công khi `finishReason = MAX_TOKENS`, response rỗng hoặc structured output sai schema.
4. Retry/restart tiếp tục đúng giai đoạn, không gọi lại các stage đã persist thành công.
5. Mỗi job có thể tải bản cuối dù một số chunk mang `needs_review`; UI phải cảnh báo rõ số chunk đó.
6. Với 20 PDF/370 trang, pipeline không vượt quota mỗi project khi phân phối đều và không gây circuit breaker giả.
7. Không làm hỏng upload R2, queue, cancellation, resume và streaming download từ P001–P002.
8. Không coi việc model tự tìm được ít lỗi là bằng chứng toàn chunk sạch; mỗi PASS v2 phải có coverage COMPLETE, và chỉ review chuyên môn độc lập mới là cổng chất lượng để rollout.

## 6. Bảng tiến độ tổng

| Giai đoạn | Nội dung | Trạng thái | Cổng nghiệm thu |
| --- | --- | --- | --- |
| G0 | Bảo toàn worktree và chốt baseline | Hoàn thành | Có nhánh P003, baseline test/build và manifest 20 PDF |
| G1 | Benchmark minimal/medium/high và pipeline nhiều lượt | Hoàn thành | Chủ dự án đã review finding thực tế và chốt B4; không tiếp tục blind review |
| G2 | Chuẩn hóa cấu hình Gemini, chunk 2 trang và telemetry | Hoàn thành | Một lượt high chạy ổn, metadata đầy đủ, MAX_TOKENS bị chặn |
| G3 | Schema/artifact và state machine theo stage | Hoàn thành | Resume được tại từng stage, migration additive đạt |
| G4 | Prompt và structured output cho audit/verify | Hoàn thành | JSON schema ổn định, không rewrite ở auditor |
| G5 | Revision, verification và repair hữu hạn | Hoàn thành | PASS/FAIL đúng, không lặp vô hạn, warning được lưu |
| G6 | Key rotation/quota/retry/cancellation | Hoàn thành | 429 chuyển key ngay; 7 key phân phối đều và an toàn |
| G7 | Queue, API, SSE và frontend progress chất lượng | Hoàn thành | UI hiển thị stage và warning; API cũ vẫn tương thích |
| G8 | Regression, tải, lỗi và benchmark 20 PDF | Đang thực hiện (local regression v2 đạt; benchmark live v2 và Render canary còn chờ) | Test tự động đạt; benchmark thật có bằng chứng |
| G9 | Rollout production và theo dõi | Đang thực hiện (4/11) | Canary đạt, bật quality an toàn, rollback đã kiểm chứng |

---

## G0 — Bảo toàn worktree và chốt baseline

Mục tiêu: bắt đầu P003 mà không ghi đè thay đổi P001–P002 hoặc dữ liệu mẫu của người dùng.

- [x] **P003-G0-S01 — Bảo toàn worktree.** Ghi nhận các file root đang bị xóa và `samplepdf/` đang untracked; không tự khôi phục, xóa hoặc commit thay đổi ngoài P003.
- [x] **P003-G0-S02 — Tạo nhánh.** Tạo `feature/project-003-translation-quality` từ commit ổn định sau khi xác nhận trạng thái P002.
- [x] **P003-G0-S03 — Ghi baseline kỹ thuật.** Lưu Node/npm, dependency, backend test, frontend test/lint/build, git commit và cấu hình model không chứa secret.
- [x] **P003-G0-S04 — Lập manifest mẫu.** Liệt kê 20 PDF, page count, size, chuyên khoa suy ra từ tên và SHA-256 cục bộ; manifest không chứa nội dung sách.
- [x] **P003-G0-S05 — Xác nhận bộ mẫu.** Tổng là 20 PDF, 370 trang và 191 chunk khi cắt riêng từng PDF thành nhóm 2 trang; nếu file thay đổi phải cập nhật manifest và số liệu.
- [x] **P003-G0-S06 — Bảo vệ dữ liệu benchmark.** Raw prompt/response và bản dịch thử đặt trong thư mục local ignored; chỉ commit manifest, rubric và báo cáo tổng hợp được phép chia sẻ.
- [x] **P003-G0-S07 — Ghi baseline vận hành.** Đo thời gian trung bình/chunk, lỗi 429, số call/chunk và tỷ lệ response không `STOP` của pipeline hiện tại.

## G1 — Benchmark để chốt cấu hình bằng dữ liệu thật

Mục tiêu: không mặc định `high` hoặc nhiều lượt chắc chắn tốt hơn; chủ động dùng API và 20 PDF thật để đo.

### Ma trận bắt buộc

| Mã | Chunk | Temperature | Thinking | Pipeline |
| --- | --- | --- | --- | --- |
| B0 | 3 trang | 0.1 | Mặc định/minimal | Một lượt hiện tại |
| B1 | 2 trang | 1.0 | minimal | Một lượt |
| B2 | 2 trang | 1.0 | medium | Một lượt |
| B3 | 2 trang | 1.0 | high | Một lượt |
| B4 | 2 trang | 1.0 | high | Translate → Audit → Revise → Verify; repair có điều kiện |
| B5 | 2 trang | 1.0 | high | Nhãn kỹ thuật thử nghiệm cho B4 đã gia cố: Document context → Translate → Audit/coverage → Revise → Verify/coverage; không phải phương án cần chấm mù riêng |

- [x] **P003-G1-S01 — Tạo benchmark runner.** Dùng cùng SDK/service adapter với production, nhận model config và PDF/page range; không copy logic gọi API sang script độc lập khó bảo trì.
- [x] **P003-G1-S02 — Chọn mẫu đại diện.** Mỗi PDF lấy một cặp 2 trang có nội dung; tài liệu dưới 2 trang dùng toàn bộ. Tránh trang trắng nhưng không né bảng/hình/thuật ngữ khó.
- [x] **P003-G1-S03 — Cố định input.** Mọi biến thể B1–B4 dùng đúng cùng byte PDF 2 trang và cùng system prompt nền; chỉ thay yếu tố đang đo.
- [x] **P003-G1-S04 — Chạy B0.** Ghi lại hành vi production cũ để có baseline thực, không dùng bản chạy lại này thay cho các bản dịch cũ nếu sau này người dùng cung cấp lại.
- [x] **P003-G1-S05 — Chạy B1–B3.** Phân phối request đều qua 7 project; lưu token, latency, finish reason, model version và lỗi.
- [x] **P003-G1-S06 — Chạy B4.** Lưu riêng output từng stage và kết quả PASS/FAIL/repair; đây là kiến trúc được chủ dự án chọn, còn production implementation dùng cùng flow với context/coverage v2 đã gia cố.
- [x] **P003-G1-S07 — Ẩn nhãn khi chấm.** Tạo bộ so sánh A/B không lộ minimal/medium/high/pipeline cho người đánh giá.
- [x] **P003-G1-S08 — Rubric y khoa.** Chấm `mistranslation`, `omission`, `addition`, `terminology`, `negation/modality`, `causal relation`, `number/unit`, `fluency`, `table/figure`, `Markdown`; critical error không được bù bằng văn phong.
- [x] **P003-G1-S09 — Đánh giá tự động giới hạn.** Code kiểm tra finish reason, JSON schema, độ dài bất thường và Markdown; không dùng chính Flash-Lite làm trọng tài duy nhất cho chất lượng của nó.
- [x] **P003-G1-S10 — Đánh giá chuyên môn.** Chủ dự án đã duyệt toàn bộ review-bundle critical/major và chỉ ra giới hạn của self-audit thưa trên sách chuyên sâu.
- [x] **P003-G1-S11 — Chốt phương án.** Chủ dự án chọn B4: high, translate → audit → revise → verify/repair; production candidate giữ thêm context toàn PDF và coverage v2 để khắc phục đúng các lỗi đã nhận xét.
- [x] **P003-G1-S12 — Quyết định blind review.** Chủ dự án xác nhận không cần tiếp tục bộ A–D; answer key cũ không phải cổng rollout. Chất lượng còn lại được kiểm qua canary thực và warning/page range.

## G2 — Cấu hình Gemini, chunk 2 trang và telemetry

Mục tiêu: tạo nền một lượt high đúng khuyến nghị và quan sát được trước khi thêm state machine.

- [x] **P003-G2-S01 — Cấu hình chunk.** Thay hằng số 3 trang bằng config mặc định 2; test page range cho PDF 1, 2, 3, lẻ và nhiều trang.
- [x] **P003-G2-S02 — Thinking high.** Thêm `thinkingConfig.thinkingLevel = HIGH`, `includeThoughts = false` cho quality mode.
- [x] **P003-G2-S03 — Temperature.** Bỏ `0.1`; quality mode dùng 1.0. Legacy mode giữ hành vi cũ chỉ phục vụ rollback/benchmark.
- [x] **P003-G2-S04 — Output budget.** Stage xuất toàn văn dùng mức đủ cho 2 trang và không vượt model limit; stage JSON dùng mức nhỏ hơn. Không coi output bị cắt là hợp lệ.
- [x] **P003-G2-S05 — Response validation.** Kiểm tra candidates, text, finish reason, safety/block reason và structured output trước khi persist.
- [x] **P003-G2-S06 — Usage metadata.** Thu `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `totalTokenCount`, `modelVersion`, latency và key index.
- [x] **P003-G2-S07 — Log an toàn.** Log job/chunk/stage/version/usage nhưng không log key, PDF base64, toàn bộ prompt hoặc toàn bộ bản dịch.
- [x] **P003-G2-S08 — Test SDK thực.** Một smoke call trên PDF mẫu xác nhận tên field đúng với `@google/genai` đang cài; không chỉ dựa vào type declaration.

## G3 — Schema artifact và state machine theo stage

Mục tiêu: mỗi stage có checkpoint bền vững để restart/retry không lãng phí request hoặc ghi đè kết quả.

- [x] **P003-G3-S01 — Version pipeline.** Job mới ghi `translationPipelineVersion` và mode; job legacy không có field vẫn đọc/hoàn thành như cũ.
- [x] **P003-G3-S02 — Mở rộng TranslationChunk.** Thêm page range, stage hiện tại, draft, audit report, revised/final content, verification report, repair count, quality status và usage theo stage.
- [x] **P003-G3-S03 — Enum stage.** Chuẩn hóa `pending`, `translated`, `audited`, `revised`, `verified`, `repaired`, `reverified`, `completed`, `needs_review`.
- [x] **P003-G3-S04 — Persist sau từng stage.** Upsert atomic kèm pipeline version; crash sau stage nào tiếp tục từ stage kế tiếp.
- [x] **P003-G3-S05 — Nội dung cuối tương thích.** Trường `content` vẫn chứa Markdown cuối để API preview/download hiện tại không phải ghép artifact trung gian.
- [x] **P003-G3-S06 — Dọn artifact.** Sau PASS, bỏ các bản full-text trung gian không cần thiết nhưng giữ báo cáo compact và usage; `needs_review` giữ đủ dữ liệu chẩn đoán.
- [x] **P003-G3-S07 — Migration.** Script additive/idempotent, dry-run/count/index; không rewrite toàn bộ chunk cũ.
- [x] **P003-G3-S08 — Version mismatch.** Artifact dở dang từ pipeline version khác không được trộn; khởi động lại chunk đó từ S1 nhưng không đụng chunk final đã hoàn thành.
- [x] **P003-G3-S09 — Test resume.** Giả lập restart/lỗi DB sau mọi stage và assert không gọi lại stage đã commit.

## G4 — Prompt và structured output cho audit/verify

Mục tiêu: reviewer tìm lỗi có bằng chứng thay vì viết lại theo cảm tính.

### Schema lỗi tối thiểu

```json
{
  "status": "PASS | FAIL",
  "errors": [
    {
      "category": "mistranslation | omission | addition | terminology | negation_modality | causal_relation | number_unit | table_figure | formatting",
      "severity": "critical | major | minor",
      "sourceExcerpt": "exact source excerpt",
      "targetExcerpt": "exact translated excerpt or empty for omission",
      "requiredCorrection": "specific correction",
      "explanation": "concise evidence-based reason"
    }
  ]
}
```

- [x] **P003-G4-S01 — Prompt nền.** Rút gọn yêu cầu trừu tượng, giữ mục tiêu học thuật, toàn văn, thuật ngữ y khoa Việt Nam và Markdown.
- [x] **P003-G4-S02 — Quy tắc chuyên môn.** Nhấn mạnh phủ định, mức độ chắc chắn, quan hệ nhân quả, tác nhân–đích, giải phẫu, thuốc, liều, số liệu và viết tắt.
- [x] **P003-G4-S03 — Few-shot.** Thêm số lượng nhỏ ví dụ Anh–Việt đã kiểm duyệt cho các lỗi khó; ví dụ không phụ thuộc một chuyên khoa duy nhất.
- [x] **P003-G4-S04 — Audit prompt.** Nhận PDF + draft, kiểm từng phần nguồn, chỉ báo lỗi có exact excerpt; không chấm văn phong nếu không làm sai nghĩa.
- [x] **P003-G4-S05 — Verify prompt.** Nhận PDF + bản revised/final, đánh giá độc lập và không dựa mù vào audit cũ.
- [x] **P003-G4-S06 — Structured output.** Dùng `responseMimeType: application/json` và JSON schema SDK; parse/validate bằng code trước khi sử dụng.
- [x] **P003-G4-S07 — Chống prompt injection từ sách.** Nội dung PDF là dữ liệu nguồn, không phải chỉ thị; model không làm theo câu lệnh nằm trong sách.
- [x] **P003-G4-S08 — Invalid audit.** JSON lỗi/sai schema được retry stage với key khác; không chuyển thẳng sang revision bằng dữ liệu hỏng.
- [x] **P003-G4-S09 — Test rubric.** Fixture lỗi có chủ đích cho omission, đảo phủ định, sai đơn vị, sai causal relation và lỗi thuật ngữ; audit phải bắt được theo ngưỡng đã chốt.

## G5 — Revision, verification và repair hữu hạn

Mục tiêu: sửa đúng lỗi đã nêu, hạn chế model viết lại phần vốn đúng và không tạo vòng lặp vô hạn.

- [x] **P003-G5-S01 — Revision prompt.** Nhận PDF + draft + audit; áp dụng mọi lỗi critical/major hợp lệ, giữ nguyên phần khác và trả toàn bộ Markdown.
- [x] **P003-G5-S02 — Empty audit.** Nếu audit PASS, S3 vẫn có thể được bỏ qua theo quyết định benchmark; mặc định ban đầu vẫn chạy S3 để pipeline đồng nhất cho tới khi có dữ liệu.
- [x] **P003-G5-S03 — Verify gate.** Chỉ `PASS` mới đặt `qualityStatus = passed`; mọi error critical/major làm `FAIL`.
- [x] **P003-G5-S04 — Minor-only policy.** Minor thuần văn phong không kích hoạt repair; lưu warning compact nếu cần.
- [x] **P003-G5-S05 — Repair prompt.** Chỉ sửa lỗi từ S4 trên bản revised, không quay về draft và không sáng tác thêm giải thích.
- [x] **P003-G5-S06 — Reverify.** Kiểm tra độc lập bản repaired; PASS thì hoàn thành, FAIL thì `needs_review`.
- [x] **P003-G5-S07 — Bounded loop.** `repairCount <= 1` được enforce bằng code/schema/test, không chỉ bằng prompt.
- [x] **P003-G5-S08 — Chọn bản tốt nhất.** Khi reverify fail, mặc định giữ bản repaired; nếu repair response không hợp lệ thì fallback revised.
- [x] **P003-G5-S09 — Completion.** Job completed khi mọi chunk có `passed` hoặc `needs_review`; tổng warning được lưu và phát qua SSE.
- [x] **P003-G5-S10 — Coverage guard.** Revision/repair phải giữ ít nhất 80% ký tự có nghĩa của bản trước; output co rút bị rotate như response invalid, và repair không phục hồi được phải fallback về revised đầy đủ với `needs_review`.

## G6 — Key rotation, quota, retry và cancellation

Mục tiêu: tận dụng 7 project Free tier mà không tạo retry chậm, vượt quota cục bộ hoặc gọi trùng stage.

- [x] **P003-G6-S01 — Round-robin theo request.** Mỗi stage reserve một key; không cần cùng key giữa các stage vì request stateless và luôn gửi đủ input.
- [x] **P003-G6-S02 — 429 immediate rotation.** Đánh dấu key cooling down và chuyển ngay key khác; không chờ 12/24/36 giây trên cùng key.
- [x] **P003-G6-S03 — Exhaustion policy.** Khi tất cả key 429, dùng Retry-After nếu có; nếu không có, exponential backoff + jitter và để queue retry bền vững.
- [x] **P003-G6-S04 — Auth/config.** 401/403 loại key khỏi vòng hiện tại; chỉ báo config failure khi mọi key đều bị từ chối.
- [x] **P003-G6-S05 — 5xx/network.** Retry hữu hạn, có thể chuyển key để loại trừ lỗi cục bộ nhưng không giả định đổi key luôn sửa được lỗi dịch vụ.
- [x] **P003-G6-S06 — Quota counters.** Theo dõi rolling RPM/TPM/RPD theo key index để quan sát, không coi counter cục bộ là nguồn sự thật tuyệt đối sau restart.
- [x] **P003-G6-S07 — Headroom.** Rollout đầu không chủ động vượt 12 RPM, 200k TPM hoặc 400 RPD/key dù ảnh cho thấy trần cao hơn.
- [x] **P003-G6-S08 — Cancellation.** Kiểm tra abort trước/sau mọi stage; cancel không bắt đầu stage mới và không ghi completed sau khi bị hủy.
- [x] **P003-G6-S09 — Circuit breaker.** Chỉ ngủ hệ thống khi toàn bộ key thực sự quota/unavailable; một key 429 không tăng failure toàn cục sai.
- [x] **P003-G6-S10 — Test 7 key.** Mock phân phối 700 request, 429 xen kẽ, key auth lỗi và toàn bộ key exhausted; không lộ secret trong log.

## G7 — Queue, API, SSE và frontend

Mục tiêu: người dùng thấy tiến độ chất lượng nhưng API kết quả cũ vẫn hoạt động.

- [x] **P003-G7-S01 — Chunk concurrency.** Giữ tối đa 2 chunk đang chạy; trong mỗi chunk, stage chạy tuần tự.
- [x] **P003-G7-S02 — Progress model.** Job trả `currentQualityStage`, số chunk passed, warning, completed và tổng chunk.
- [x] **P003-G7-S03 — SSE.** Phát stage bắt đầu/kết thúc, retry key, repair và needs-review bằng dữ liệu công khai, không gửi audit excerpt chứa nội dung sách nếu không cần.
- [x] **P003-G7-S04 — UI label.** Hiển thị `Đang dịch`, `Đang kiểm định`, `Đang hiệu chỉnh`, `Đang xác minh`, `Đang sửa lỗi` và `Hoàn thành có cảnh báo`.
- [x] **P003-G7-S05 — Result API.** Preview/copy/download chỉ trả final `content`; artifact audit có endpoint debug riêng hoặc không public trong v1.
- [x] **P003-G7-S06 — Warning UX.** Cho biết số chunk cần xem lại và page range tương ứng; không gọi bản dịch “đã kiểm chứng hoàn toàn”.
- [x] **P003-G7-S07 — Resume UX.** F5/reconnect đọc stage từ MongoDB, không reset progress về đầu.
- [x] **P003-G7-S08 — Legacy compatibility.** Job cũ không có quality fields vẫn hiển thị và download bình thường.
- [x] **P003-G7-S09 — Cancellation/delete.** Dọn artifact trung gian cùng TranslationChunk và source theo semantics P001–P002.

## G8 — Kiểm thử, benchmark đầy đủ và tiêu chí chất lượng

Mục tiêu: chứng minh pipeline mới tăng chất lượng mà không phá độ ổn định.

- [x] **P003-G8-S01 — Unit test config.** 2 trang/chunk, high thinking, temperature 1.0, output budget và response metadata.
- [x] **P003-G8-S02 — Unit test stage machine.** PASS trực tiếp, FAIL→repair→PASS, FAIL lần hai→needs_review, invalid JSON và MAX_TOKENS.
- [x] **P003-G8-S03 — Resume matrix.** Restart sau S1–S6, lỗi DB trước/sau persist, lease hết hạn và worker cũ không ghi đè worker mới.
- [x] **P003-G8-S04 — Error matrix.** 400/401/403/429/5xx/timeout/abort/safety/recitation/empty response/invalid schema.
- [x] **P003-G8-S05 — Regression P001–P002.** Upload batch R2, source resolver, queue claim, cancellation, cleanup, result streaming, frontend test/lint/build.
- [x] **P003-G8-S06 — Smoke một PDF.** Một trang thật từ `77 Allergy Assessment.pdf` đã chạy qua quality mode trong Mongo database cô lập: job `completed`, chunk `passed` sau một repair/reverify, preview và download trùng nhau, private report không lộ qua public summary, transient text đã xóa sau PASS, source R2 đã xóa và database smoke đã drop. UI quality đã được kiểm bằng frontend regression; báo cáo tổng hợp tại `cline_docs/project-003-quality-smoke-report.json`.
- [x] **P003-G8-S07 — Benchmark 20 PDF.** Codex chủ động gửi các PDF/page sample qua API theo manifest và ma trận đã chốt; không yêu cầu người dùng tự tạo sample text.
- [x] **P003-G8-S08 — Kiểm quota.** Ghi request/key, token/stage, 429, latency và RPD ước tính; xác nhận phân phối không dồn một project.
- [x] **P003-G8-S09 — Báo cáo chất lượng.** Tổng hợp lỗi theo category/severity và chuyên khoa; kèm ví dụ ngắn hợp lệ, không commit toàn bộ nội dung sách.
- [x] **P003-G8-S10 — Cổng chấp nhận phương án.** Chủ dự án đã duyệt review-bundle, chốt flow B4 và không yêu cầu blind review. Default quality được xác nhận bằng canary production; batch nhiều PDF về sau được chủ dự án chủ động loại khỏi phạm vi.
- [x] **P003-G8-S11 — Hiệu năng.** Phần live corpus đạt đủ 370 trang/191 chunk, 0 task failed; canary Render 77 trang/39 chunk hoàn tất trong 35 phút 36,847 giây với concurrency 2. Call chậm nhất 99.827 ms dưới timeout 180 giây; một lỗi schema giữa job đã resume từ artifact ở attempt 2 và hoàn tất đủ 39/39.
- [ ] **P003-G8-S12 — Tài nguyên.** Đo RAM/disk/Mongo growth khi giữ artifact, rồi xác nhận cleanup artifact sau PASS.

## G9 — Rollout production, theo dõi và đóng dự án

Mục tiêu: triển khai cuốn chiếu, có rollback và bằng chứng production.

- [x] **P003-G9-S01 — Backup/dry-run.** Đếm Job/TranslationChunk; backup nếu có dữ liệu cần giữ; chạy migration dry-run và verify index.
- [x] **P003-G9-S02 — Deploy backend additive.** Commit `9e06d43` đã lên `main`; Render restart ở `2026-07-16T14:19:40.509Z`, health/readiness đạt. Job production qua R2 chạy `legacy`, completed 1/1, preview khớp download, không có quality field, source cleanup và xóa job đạt.
- [x] **P003-G9-S03 — Deploy frontend.** Vercel production bundle `index-B6hsUl_3.js` chứa stage context mới, backend cũ/legacy vẫn hiển thị và download không đổi.
- [x] **P003-G9-S04 — Canary.** PDF ngắn và PDF dài production đều hoàn tất. Lượt dài 77 trang/39 chunk có context toàn tài liệu, coverage audit 39/39 COMPLETE, resume sau lỗi schema, 37 passed/2 needs-review, 7 key phân phối đều, preview/download trùng hash và source cleanup đạt.
- [x] **P003-G9-S05 — Batch 5 PDF (đã hủy theo quyết định chủ dự án).** Không chạy thêm vì thời gian/chi phí không còn tương xứng; canary PDF dài là lượt production cuối dùng để phân tích.
- [x] **P003-G9-S06 — Bật mặc định.** Commit `5d546a3` đã chuyển default sang `quality`; canary production xác nhận effective mode là `quality`.
- [ ] **P003-G9-S07 — Rollback drill.** Chuyển về legacy bằng config, xác nhận job quality đang dở không bị ghi sai và job mới vẫn chạy.
- [ ] **P003-G9-S08 — Theo dõi 24 giờ.** RPM/TPM/RPD, 429, token thinking/output, latency stage, needs_review, retry, Render RAM/disk/restart và Mongo growth.
- [ ] **P003-G9-S09 — Tối ưu sau dữ liệu.** Chỉ bỏ S3 khi audit PASS, thêm micro-glossary hoặc điều chỉnh prompt nếu số liệu chứng minh lợi ích; không thêm độ phức tạp theo cảm tính.
- [x] **P003-G9-S10 — Cập nhật docs.** Đồng bộ README, `.env.example`, tài liệu vận hành, prompt version, schema/migration và cách đọc warning.
- [ ] **P003-G9-S11 — Đóng dự án.** Chỉ hoàn thành khi mọi điều kiện mục 12 đạt và không còn blocker production.

## 7. Ma trận kiểm thử bắt buộc

| Nhóm | Tình huống | Kết quả bắt buộc |
| --- | --- | --- |
| PDF | 1 trang | Một chunk, không lỗi page range |
| PDF | 2 trang | Một chunk |
| PDF | 3 trang | Hai chunk 2+1 đúng thứ tự |
| PDF | Bảng/hình | Không bỏ caption; Markdown sử dụng được |
| Translate | STOP + text | Persist S1 và usage |
| Translate | MAX_TOKENS | Không persist như stage thành công |
| Audit | PASS | JSON hợp schema, không có error |
| Audit | FAIL | Có exact excerpts và correction |
| Audit | JSON hỏng | Retry stage, không chạy revision |
| Revision | Response rỗng | Giữ draft và retry, không ghi content rỗng |
| Verify | PASS | qualityStatus passed |
| Verify | FAIL | Chạy đúng một repair |
| Reverify | FAIL | needs_review, job vẫn có final content |
| Restart | Sau từng stage | Resume stage kế tiếp, không gọi trùng |
| Key | Một key 429 | Chuyển key ngay |
| Key | Tất cả key 429 | Backoff queue, không spin |
| Key | Một key 401 | Loại key đó, key khác tiếp tục |
| Cancel | Đang audit/revise | Không bắt đầu stage mới, cleanup đúng |
| Legacy | Chunk chỉ có content | Preview/download bình thường |
| R2 | Restart Render | Redownload source và resume stage |
| UI | needs_review | Hiển thị cảnh báo và page range |

## 8. Cấu hình dự kiến

Các tên cuối cùng có thể điều chỉnh theo convention hiện có, nhưng semantics phải giữ:

```dotenv
TRANSLATION_PIPELINE_MODE=legacy
PDF_PAGES_PER_CHUNK=2
GEMINI_THINKING_LEVEL=HIGH
QUALITY_MAX_REPAIR_CYCLES=1
```

- `legacy` là mặc định trong lần deploy backend đầu.
- Production chỉ chuyển sang `quality` sau benchmark/canary.
- Temperature của quality mode là 1.0 theo code; không cần env nếu không có nhu cầu vận hành thật.
- Quota limit không hard-code theo ảnh AI Studio; chỉ dùng headroom nội bộ và telemetry vì Google có thể thay đổi quota.

## 9. Bản đồ vùng mã dự kiến tác động

| Vùng | Thay đổi chính |
| --- | --- |
| Gemini service | Stage runner, prompt version, thinking high, structured audit/verify, telemetry, key rotation |
| PDF worker/splitter | Mặc định 2 trang và page-range metadata |
| TranslationChunk/Job schema | Pipeline version, stage artifact, quality status, warning/usage |
| Queue manager | Resume theo stage, completion có warning, cancellation và lease dài hơn |
| Controllers/SSE | Progress stage và quality summary, vẫn giữ result API cũ |
| Frontend | Nhãn stage, tiến độ và cảnh báo needs-review |
| Scripts/tests | Benchmark runner, manifest PDF, migration, fixtures và regression |

## 10. Chiến lược commit và rollback

Commit nhỏ theo cổng nghiệm thu, dự kiến:

1. `docs(p003): add translation quality project plan`
2. `test(p003): add benchmark manifest and harness`
3. `feat(p003): add gemini high-thinking telemetry and two-page chunks`
4. `feat(p003): persist translation quality stages`
5. `feat(p003): add medical audit and verification pipeline`
6. `feat(p003): improve multi-project key rotation`
7. `feat(p003): expose quality progress and warnings`
8. `test(p003): add staged-pipeline regression and benchmark report`
9. `docs(p003): record rollout evidence and operations`

Rollback:

- Chuyển `TRANSLATION_PIPELINE_MODE=legacy` để job mới dùng pipeline cũ.
- Không rollback schema additive trước khi xác nhận không còn code đọc field mới.
- Job quality đã hoàn thành vẫn tải từ `content` như cũ.
- Job quality đang dở giữ artifact để xử lý sau; rollback không tự xóa dữ liệu.

## 11. Nhật ký quyết định và bằng chứng

| Ngày | Mã | Quyết định/bằng chứng | Trạng thái |
| --- | --- | --- | --- |
| 15-07-2026 | D001 | Giữ `gemini-3.1-flash-lite`; không dùng model khác trong production | Đã chốt |
| 15-07-2026 | D002 | 7 API key thuộc 7 tài khoản/project Free tier; quota quan sát khoảng 15 RPM, 250k TPM, 500 RPD/project | Đã chốt theo ảnh AI Studio |
| 15-07-2026 | D003 | Request không phải ràng buộc chính; ưu tiên chất lượng | Đã chốt |
| 15-07-2026 | D004 | Dùng 2 trang/chunk | Đã chốt |
| 15-07-2026 | D005 | Tất cả stage quality dùng thinking high và temperature 1.0 | Đã chốt |
| 15-07-2026 | D006 | Bốn stage bắt buộc; một repair + reverify có điều kiện; không lặp vô hạn | Đã chốt |
| 15-07-2026 | D007 | Không trích xuất PDF thành block, không glossary đồ sộ, chưa ưu tiên cross-chunk context | Đã chốt |
| 15-07-2026 | E001 | `samplepdf/` có 20 PDF, 370 trang, 20,66 MiB; 191 chunk 2 trang vì mỗi PDF được cắt độc lập | Đã kiểm tra bằng manifest SHA-256 cục bộ; sửa ước tính cũ 185 chunk |
| 15-07-2026 | E002 | Bốn call/chunk cần khoảng 764 request; worst-case sáu call/chunk khoảng 1.146 request cho toàn bộ mẫu | Đã tính lại theo 191 chunk |
| 15-07-2026 | E003 | Baseline: backend 44/44 test; frontend 9/9 test, lint/build đạt; npm audit 0; Node 22.17.1, npm 10.9.2, `@google/genai` 1.52.0 | Chi tiết tại `cline_docs/project-003-baseline.md` |
| 15-07-2026 | E004 | Smoke B0–B4 trên trang mẫu AKI đạt: mọi call `STOP`; B4 audit FAIL 3 lỗi → revise → verify PASS, không cần repair | Metadata tại `cline_docs/project-003-benchmark-smoke.md`; raw artifact local ignored |
| 15-07-2026 | E005 | Regression sau adapter/runner: backend 54 test pass; frontend 9 test pass, lint/build đạt | stdout phiên local; không có regression P001–P002 được phát hiện |
| 15-07-2026 | E006 | G2 worker production cắt PDF AKI 14 trang thành 7 chunk `[2,2,2,2,2,2,2]`; ma trận unit 1/2/3/5/10 trang đạt | Worker Thread thật + backend 58 test pass |
| 15-07-2026 | E007 | `processTranslation` quality profile chạy thật 2 trang: `STOP`, 20.388 ms, 1.795 input/4.051 output/2.068 thought token; callback nhận đủ metadata | Nội dung dịch không được in/commit; chi tiết tại báo cáo smoke |
| 15-07-2026 | E008 | Benchmark B0–B4 đủ 20 PDF/100 artifact; B4 có 19 PASS, 1 `needs_review`, 4 repair/reverify; 174 attempt, 2 lỗi 429 được chuyển key, 4 schema-invalid được rotate/recover, không có 5xx/auth/non-STOP/empty | `cline_docs/project-003-benchmark-report.json`, `cline_docs/project-003-benchmark-review.md` và audit fixture 5/5 |
| 15-07-2026 | E009 | Regression cuối sau pipeline quality: backend 88 test pass; frontend 12 test pass, lint và production build đạt | Không phát hiện regression P001–P002; xem commit `24ab013` và tài liệu vận hành |
| 15-07-2026 | E010 | Production Mongo đã backup trước migration, backup giải nén/parse được; migration P003 additive/idempotent chạy với `modifiedCount=0`, index được đảm bảo và dry-run sau migration không đổi | Backup ngoài repo `Tran-backups/p003-before-migration-2026-07-15T18-30-09-916Z.ejson.gz`, SHA-256 `513a038a6f1dac6c98bab8830d97430db91f3fbe2bc4a8804a11e2879ad607c4` |
| 16-07-2026 | D008 | Giữ production mặc định `legacy`; chưa bật quality cho đến khi chủ dự án chốt phương án và rollout canary đạt | Quyết định an toàn tạm thời; chưa deploy/push trong phiên này |
| 16-07-2026 | E011 | Smoke end-to-end quality một PDF 1 trang dùng Mongo/R2 thật nhưng namespace cô lập: 6 stage persisted, PASS sau 1 repair, preview/download khớp, R2 source deleted, Mongo database dropped, tổng 90.270 ms | `cline_docs/project-003-quality-smoke-report.json`; không cần chạy lại khi quota đang thấp |
| 16-07-2026 | E012 | Case Asthma cho thấy repair cũ co từ khoảng 13,9 KB xuống 5,4 KB dù `STOP`; coverage guard 80% đã rotate output cụt, rerun giữ 13,7 KB và vẫn gắn `needs_review` cho 2 lỗi major | `cline_docs/project-003-asthma-independent-review.md`, benchmark report cập nhật và commit `8826ad0` |
| 16-07-2026 | E013 | Phân tích không gọi Gemini: B4 trung bình 62.389 ms/chunk, ngoại suy 191 chunk trên 2 lane khoảng 99,3 phút; request tối đa 27,5 giây; PDF lớn nhất làm RSS tăng tối đa 53,87 MiB; BSON terminal ước tính 3,76 MiB/corpus | `cline_docs/project-003-performance-resource.md`; số liệu Render/Mongo thực vẫn chờ canary |
| 16-07-2026 | E014 | Regression sau coverage guard/full-corpus/review harness: backend 99 test pass; frontend 12 test pass, lint/build đạt; dry-run dựng đủ 191 chunk và tách checkpoint dry-run khỏi live | Không gọi Gemini; `git diff --check` và kiểm tra cú pháp các script đạt |
| 16-07-2026 | E015 | Full-corpus live hoàn tất đủ 20 PDF/370 trang/191 chunk: 177 PASS, 14 `needs_review`, 50 repair; 864 call thành công/905 attempt, 0 task failed, stderr rỗng; coverage revise thấp nhất 91,8%, repair 98,4%; 1 critical và 15 major được đưa vào review queue theo file/trang | `cline_docs/project-003-full-corpus-report.json/.md`; raw artifact và nội dung sách chỉ ở `.p003-local/` ignored |
| 16-07-2026 | E016 | Tạo bộ duyệt local cho đủ 14 chunk `needs_review`: mỗi case có PDF nguồn đúng 2 trang, bản dịch cuối và phiếu chứa finding/evidence/ba lựa chọn; case critical được xếp số 01 | `.p003-local/review-bundle/00-REVIEW-INDEX.md`; 14/14 case, 42/42 file hợp lệ và toàn bộ bundle được Git ignore |
| 16-07-2026 | D017 | Review chủ dự án bác bỏ B4/full-corpus v1 như bằng chứng đủ để rollout: queue chỉ là những chunk cùng model tự gắn cờ, không chứng minh 177 PASS còn lại sạch; sách chuyên sâu cần ngữ cảnh toàn tài liệu và kiểm tra coverage chi tiết | Thay bằng v2: S0 context passport theo toàn PDF, checklist coverage bắt buộc và B5; giữ `legacy` làm production default |
| 16-07-2026 | E017 | Chủ dự án đã hoàn tất review-bundle và nêu rõ các finding 1–2 lỗi/chunk không đủ để khẳng định chất lượng. Blind review A–D được hoãn, không mở answer-key, cho đến khi có B5 | Nhận xét chuyên môn của chủ dự án là cổng chặn rollout; B4/full-corpus v1 chỉ được giữ làm đối chiếu lịch sử |
| 16-07-2026 | D018 | Chủ dự án chốt flow B4 và không tiếp tục blind review A–D. Context toàn PDF + coverage v2 được coi là gia cố của B4, không phải một phương án dịch cần lựa chọn riêng | Đóng G1-S10–S12 và G8-S10; tiếp tục canary/batch production trước khi bật mặc định |
| 16-07-2026 | E018 | Pre-deploy regression sau quyết định B4-v2 đạt: backend 103/103 test và audit 0 vulnerability; frontend 12/12 test, lint/build và audit đạt. Production preflight hiện tại trả health/readiness ready, Mongo/R2 available, cleanup/upload backlog 0 | Chưa deploy; dùng làm mốc so sánh sau khi push production |
| 16-07-2026 | E019 | Additive deploy `9e06d43` đạt: Render/Vercel nhận code mới; legacy production smoke qua prepare→R2 PUT→confirm, completed 1/1, preview/download cùng 79 ký tự, không có quality field, R2 delete succeeded và backlog 0; job/batch smoke đã được dọn | Đóng G9-S02/S03; hàng đợi production rỗng trước cửa sổ canary quality |
| 16-07-2026 | E020 | Canary quality ngắn đầu tiên phát hiện Gemini không chấp nhận `minItems/maxItems` trong response schema; commit `af2ee0d` bỏ keyword ở API schema nhưng giữ validator nghiệp vụ. Backend 104 test pass và canary ngắn sau fix completed 1/1 | Root cause đã sửa và deploy; source/job lỗi được dọn, backlog 0 |
| 16-07-2026 | E021 | Canary production dài 77 trang/39 chunk completed ở attempt 2 sau một `GEMINI_SCHEMA_INVALID` được resume: audit 84 finding/747 checkpoint, verify 19 finding/766 checkpoint, 37 passed/2 needs-review, preview/download 521.538 ký tự trùng hash, source deleted và backlog 0 | `cline_docs/project-003-production-long-canary-analysis.md`; 9/37 chunk passed còn minor theo policy hiện tại, không được gọi là hoàn toàn sạch lỗi |
| 16-07-2026 | D019 | Chủ dự án yêu cầu chỉ phân tích canary dài và bỏ thử batch nhiều PDF vì tốn quá nhiều thời gian | Đóng G9-S05 theo thay đổi phạm vi; không khởi chạy thêm runner/upload production |

## 12. Điều kiện hoàn thành PROJECT 003

- [x] Benchmark B0–B4 trên PDF thực đã hoàn thành và có báo cáo lịch sử v1.
- [x] Chủ dự án đã duyệt finding thực tế, chốt flow B4 và quyết định không cần blind review A–D.
- [x] Canary B4-v2 xác nhận context/coverage hoạt động trên PDF ngắn và dài; lỗi blocking hoặc coverage thiếu được đưa vào `needs_review` thay vì tự cho qua.
- [x] Không còn `temperature: 0.1` trong quality mode; mọi stage đúng thinking high.
- [x] PDF được cắt 2 trang và page order giữ nguyên.
- [x] Audit/verify dùng structured output được validate.
- [x] Mọi stage persist/resume an toàn qua restart.
- [x] `MAX_TOKENS`, response rỗng và JSON hỏng không bị coi là thành công.
- [x] Repair loop bị giới hạn và `needs_review` hoạt động.
- [x] 429 chuyển key ngay; quota/circuit breaker không bị tính sai.
- [x] Upload R2, queue, cancellation, cleanup, preview và download không regression.
- [x] Frontend hiển thị stage và cảnh báo chất lượng rõ ràng.
- [ ] Canary đạt; batch 5 PDF đã được chủ dự án loại khỏi phạm vi; theo dõi production 24 giờ chưa thực hiện.
- [x] README/tài liệu vận hành/migration/rollback đã đồng bộ.

## 13. Bàn giao cho các phiên làm việc sau — 16-07-2026

### 13.1. Trạng thái dừng

- Nhánh hiện hành: `feature/project-003-translation-quality`.
- Các mốc đã commit trước bàn giao: `14f083e`, `00479b0`, `30ef365`, `6bd70b6`, `24ab013`, `a0fc906`, `e1134fd`, `8826ad0`, `7c5c2c8`; báo cáo full-corpus và sổ bàn giao hoàn tất nằm trong thay đổi kế tiếp của nhánh.
- Backend/frontend P003 đã deploy; default và effective production mode là `quality`. Các commit rollout tới `af2ee0d` đã được push lên `main` và nhánh feature.
- Canary production dài đã hoàn tất; runner PID 4176 đã dừng, completion marker tồn tại và stderr rỗng. Job 77 trang/39 chunk đang được giữ trên production để chủ dự án xem kết quả; source R2 đã cleanup. Không có runner benchmark/canary nào còn chạy.
- Raw PDF, raw prompt/response và bản dịch benchmark vẫn ở thư mục local ignored; không commit dữ liệu sách.
- Bốn file root đang bị xóa là thay đổi ngoài P003 của chủ dự án và phải tiếp tục để nguyên, không restore/commit cùng P003: `.clinerules`, `Kiến trúc hệ thống ứng dụng dịch file .txt`, `Mô tả bản thân .txt`, `implementation_plan.md`.

### 13.2. Thay đổi cuối phiên cần được bảo toàn

- `med-translator-backend/scripts/smoke-project-003-quality.js`: smoke end-to-end dùng Mongo database ngẫu nhiên ngắn hơn giới hạn Atlas, R2 prefix riêng và cleanup trong `finally`.
- `med-translator-backend/package.json`: thêm lệnh `npm run smoke:p003-quality`.
- `cline_docs/project-003-quality-smoke-report.json`: chỉ chứa số liệu tổng hợp, xác nhận source R2 và database cô lập đã được dọn.
- Coverage guard production/benchmark, review độc lập Asthma và benchmark report cập nhật đã chốt ở commit `8826ad0`.
- `cline_docs/project-003-performance-resource.*`: số liệu hiệu năng, RAM và BSON không gọi Gemini.
- `med-translator-backend/scripts/benchmark-project-003-full-corpus.js`: runner 191 chunk có resume theo artifact; checkpoint live và dry-run tách riêng.
- `med-translator-backend/scripts/analyze-project-003-full-corpus.js`: chỉ tạo báo cáo sau khi checkpoint live đủ và không có task failed.
- `cline_docs/project-003-full-corpus-report.*`: báo cáo đủ 191 chunk và review queue critical/major không chứa excerpt.
- `med-translator-backend/scripts/create-project-003-review-bundle.js`: tái tạo bundle local từ report/artifact, xác minh SHA-256 nguồn và không đưa nội dung sách vào Git.
- `.p003-local/review-bundle/`: 14 phiếu người dùng cần điền; bắt đầu tại `00-REVIEW-INDEX.md`.
- `med-translator-backend/src/services/qualityDocumentContext*.js`: S0 tạo context passport toàn PDF một lần/job, persist an toàn để resume và xóa Gemini File tạm thời.
- `med-translator-backend/src/services/translationQuality.js`: audit/verify v2 bắt buộc evidence coverage; coverage chưa hoàn chỉnh không thể PASS.
- `med-translator-backend/scripts/benchmark-project-003.js`: thêm B5, không lưu passport hay nội dung sách vào artifact; chỉ lưu hash/telemetry context.
- `project 003.md`: cập nhật evidence E008–E016 và ghi chú bàn giao này.

### 13.3. Việc còn lại, theo thứ tự ưu tiên

1. Không tiếp tục blind review A–D và không mở answer key như một cổng bắt buộc; flow B4 đã được chủ dự án chọn.
2. Nếu còn cần đóng G8-S12, chỉ bổ sung RAM/disk Render; Mongo payload và cleanup đã có trong báo cáo canary dài. Không chạy thêm PDF để lấy số liệu này.
3. Backend/frontend additive, legacy smoke và default quality đã hoàn tất (G9-S02/S03/S06).
4. Canary quality B4-v2 PDF ngắn và dài đã hoàn tất; xem `cline_docs/project-003-production-long-canary-analysis.md` (G9-S04).
5. Không chạy batch 5 PDF: chủ dự án đã loại bước này khỏi phạm vi sau khi canary dài hoàn tất. Default `quality` đã được xác nhận trực tiếp trên production.
6. Thực hiện rollback drill về `legacy`, theo dõi production đủ 24 giờ, ghi RAM/disk/restart/Mongo growth và chỉ tối ưu theo số liệu (G9-S07–S09).
7. Đóng dự án G9-S11 khi các cổng canary/production đều đạt.

### 13.4. Cổng an toàn bắt buộc

- Không bật quality mặc định chỉ dựa trên self-judge của Flash-Lite.
- Không xóa schema/artifact additive khi rollback; job quality đang dở phải được giữ để resume sau.
- Không đưa raw benchmark hoặc secret/API key vào Git/log/báo cáo.
- Không chạy thêm API benchmark khi quota thấp; ưu tiên tái sử dụng telemetry đã có.
