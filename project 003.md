# PROJECT 003 — Nâng chất lượng dịch sách y khoa chuyên sâu bằng Gemini 3.1 Flash-Lite

## 1. Thông tin dự án

| Thuộc tính | Giá trị |
| --- | --- |
| Mã kế hoạch | P003 |
| Ngày lập | 15-07-2026 |
| Trạng thái tổng | Đang thực hiện G0; đã tạo nhánh, ghi baseline và manifest mẫu |
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

### 4.3. Cắt 2 trang/chunk, không xây bộ trích xuất PDF mới

- Đổi `pagesPerChunk` từ 3 xuống 2.
- Tiếp tục gửi PDF native cho Gemini để tận dụng text layer, OCR, bảng và hình ảnh.
- Không thêm pipeline trích xuất toàn bộ sách thành block, không bắt đầu bằng `pdfjs`/OCR riêng và không tạo ID từng đoạn trong P003.
- Không triển khai ngữ cảnh xuyên chunk ở phiên bản đầu; chỉ xem xét lại nếu benchmark cho thấy lỗi nhất quán thuật ngữ là đáng kể.

### 4.4. Không yêu cầu glossary đồ sộ

- Không bắt người dùng tự tạo glossary cho từng sách.
- Không gắn toàn bộ từ điển y khoa vào prompt.
- Chưa thêm bước tự sinh glossary trước khi có bằng chứng benchmark; cùng một model có thể tạo thuật ngữ sai và tự khóa lỗi.
- Hướng mở rộng sau P003 là bộ nhớ nhỏ từ các sửa chữa đã được người dùng phê duyệt, chỉ truy xuất những mục thực sự xuất hiện trong chunk.

### 4.5. Pipeline chất lượng có cổng xác minh và vòng lặp hữu hạn

Mỗi chunk chạy bốn giai đoạn bắt buộc:

```text
PDF 2 trang
    |
    v
S1 TRANSLATE — dịch toàn văn Markdown, thinking high
    |
    v
S2 MEDICAL_AUDIT — so nguồn và bản dịch, chỉ trả JSON lỗi, thinking high
    |
    v
S3 REVISE — chỉ áp dụng lỗi đã xác nhận, trả Markdown hoàn chỉnh, thinking high
    |
    v
S4 VERIFY — kiểm tra lại bản cuối, chỉ trả PASS/FAIL + JSON lỗi, thinking high
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

## 6. Bảng tiến độ tổng

| Giai đoạn | Nội dung | Trạng thái | Cổng nghiệm thu |
| --- | --- | --- | --- |
| G0 | Bảo toàn worktree và chốt baseline | Đang thực hiện (6/7) | Có nhánh P003, baseline test/build và manifest 20 PDF |
| G1 | Benchmark minimal/medium/high và pipeline nhiều lượt | Chưa làm | Có báo cáo so sánh mù, chốt cấu hình bằng bằng chứng |
| G2 | Chuẩn hóa cấu hình Gemini, chunk 2 trang và telemetry | Chưa làm | Một lượt high chạy ổn, metadata đầy đủ, MAX_TOKENS bị chặn |
| G3 | Schema/artifact và state machine theo stage | Chưa làm | Resume được tại từng stage, migration additive đạt |
| G4 | Prompt và structured output cho audit/verify | Chưa làm | JSON schema ổn định, không rewrite ở auditor |
| G5 | Revision, verification và repair hữu hạn | Chưa làm | PASS/FAIL đúng, không lặp vô hạn, warning được lưu |
| G6 | Key rotation/quota/retry/cancellation | Chưa làm | 429 chuyển key ngay; 7 key phân phối đều và an toàn |
| G7 | Queue, API, SSE và frontend progress chất lượng | Chưa làm | UI hiển thị stage và warning; API cũ vẫn tương thích |
| G8 | Regression, tải, lỗi và benchmark 20 PDF | Chưa làm | Test tự động đạt; benchmark thật có bằng chứng |
| G9 | Rollout production và theo dõi | Chưa làm | Canary đạt, bật quality an toàn, rollback đã kiểm chứng |

---

## G0 — Bảo toàn worktree và chốt baseline

Mục tiêu: bắt đầu P003 mà không ghi đè thay đổi P001–P002 hoặc dữ liệu mẫu của người dùng.

- [x] **P003-G0-S01 — Bảo toàn worktree.** Ghi nhận các file root đang bị xóa và `samplepdf/` đang untracked; không tự khôi phục, xóa hoặc commit thay đổi ngoài P003.
- [x] **P003-G0-S02 — Tạo nhánh.** Tạo `feature/project-003-translation-quality` từ commit ổn định sau khi xác nhận trạng thái P002.
- [x] **P003-G0-S03 — Ghi baseline kỹ thuật.** Lưu Node/npm, dependency, backend test, frontend test/lint/build, git commit và cấu hình model không chứa secret.
- [x] **P003-G0-S04 — Lập manifest mẫu.** Liệt kê 20 PDF, page count, size, chuyên khoa suy ra từ tên và SHA-256 cục bộ; manifest không chứa nội dung sách.
- [x] **P003-G0-S05 — Xác nhận bộ mẫu.** Tổng là 20 PDF, 370 trang và 191 chunk khi cắt riêng từng PDF thành nhóm 2 trang; nếu file thay đổi phải cập nhật manifest và số liệu.
- [x] **P003-G0-S06 — Bảo vệ dữ liệu benchmark.** Raw prompt/response và bản dịch thử đặt trong thư mục local ignored; chỉ commit manifest, rubric và báo cáo tổng hợp được phép chia sẻ.
- [ ] **P003-G0-S07 — Ghi baseline vận hành.** Đo thời gian trung bình/chunk, lỗi 429, số call/chunk và tỷ lệ response không `STOP` của pipeline hiện tại.

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

- [ ] **P003-G1-S01 — Tạo benchmark runner.** Dùng cùng SDK/service adapter với production, nhận model config và PDF/page range; không copy logic gọi API sang script độc lập khó bảo trì.
- [ ] **P003-G1-S02 — Chọn mẫu đại diện.** Mỗi PDF lấy một cặp 2 trang có nội dung; tài liệu dưới 2 trang dùng toàn bộ. Tránh trang trắng nhưng không né bảng/hình/thuật ngữ khó.
- [ ] **P003-G1-S03 — Cố định input.** Mọi biến thể B1–B4 dùng đúng cùng byte PDF 2 trang và cùng system prompt nền; chỉ thay yếu tố đang đo.
- [ ] **P003-G1-S04 — Chạy B0.** Ghi lại hành vi production cũ để có baseline thực, không dùng bản chạy lại này thay cho các bản dịch cũ nếu sau này người dùng cung cấp lại.
- [ ] **P003-G1-S05 — Chạy B1–B3.** Phân phối request đều qua 7 project; lưu token, latency, finish reason, model version và lỗi.
- [ ] **P003-G1-S06 — Chạy B4.** Lưu riêng output từng stage và kết quả PASS/FAIL/repair.
- [ ] **P003-G1-S07 — Ẩn nhãn khi chấm.** Tạo bộ so sánh A/B không lộ minimal/medium/high/pipeline cho người đánh giá.
- [ ] **P003-G1-S08 — Rubric y khoa.** Chấm `mistranslation`, `omission`, `addition`, `terminology`, `negation/modality`, `causal relation`, `number/unit`, `fluency`, `table/figure`, `Markdown`; critical error không được bù bằng văn phong.
- [ ] **P003-G1-S09 — Đánh giá tự động giới hạn.** Code kiểm tra finish reason, JSON schema, độ dài bất thường và Markdown; không dùng chính Flash-Lite làm trọng tài duy nhất cho chất lượng của nó.
- [ ] **P003-G1-S10 — Đánh giá chuyên môn.** Codex lập báo cáo sơ bộ; chủ dự án duyệt ít nhất các trường hợp khác biệt lớn/critical trước khi chốt production.
- [ ] **P003-G1-S11 — Chốt bằng chứng.** Chỉ giữ B4 làm mặc định nếu giảm lỗi critical và không tăng omission; nếu B4 không hơn B3 đáng kể, giảm pipeline thay vì giữ phức tạp vô ích.

## G2 — Cấu hình Gemini, chunk 2 trang và telemetry

Mục tiêu: tạo nền một lượt high đúng khuyến nghị và quan sát được trước khi thêm state machine.

- [ ] **P003-G2-S01 — Cấu hình chunk.** Thay hằng số 3 trang bằng config mặc định 2; test page range cho PDF 1, 2, 3, lẻ và nhiều trang.
- [ ] **P003-G2-S02 — Thinking high.** Thêm `thinkingConfig.thinkingLevel = HIGH`, `includeThoughts = false` cho quality mode.
- [ ] **P003-G2-S03 — Temperature.** Bỏ `0.1`; quality mode dùng 1.0. Legacy mode giữ hành vi cũ chỉ phục vụ rollback/benchmark.
- [ ] **P003-G2-S04 — Output budget.** Stage xuất toàn văn dùng mức đủ cho 2 trang và không vượt model limit; stage JSON dùng mức nhỏ hơn. Không coi output bị cắt là hợp lệ.
- [ ] **P003-G2-S05 — Response validation.** Kiểm tra candidates, text, finish reason, safety/block reason và structured output trước khi persist.
- [ ] **P003-G2-S06 — Usage metadata.** Thu `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `totalTokenCount`, `modelVersion`, latency và key index.
- [ ] **P003-G2-S07 — Log an toàn.** Log job/chunk/stage/version/usage nhưng không log key, PDF base64, toàn bộ prompt hoặc toàn bộ bản dịch.
- [ ] **P003-G2-S08 — Test SDK thực.** Một smoke call trên PDF mẫu xác nhận tên field đúng với `@google/genai` đang cài; không chỉ dựa vào type declaration.

## G3 — Schema artifact và state machine theo stage

Mục tiêu: mỗi stage có checkpoint bền vững để restart/retry không lãng phí request hoặc ghi đè kết quả.

- [ ] **P003-G3-S01 — Version pipeline.** Job mới ghi `translationPipelineVersion` và mode; job legacy không có field vẫn đọc/hoàn thành như cũ.
- [ ] **P003-G3-S02 — Mở rộng TranslationChunk.** Thêm page range, stage hiện tại, draft, audit report, revised/final content, verification report, repair count, quality status và usage theo stage.
- [ ] **P003-G3-S03 — Enum stage.** Chuẩn hóa `pending`, `translated`, `audited`, `revised`, `verified`, `repaired`, `reverified`, `completed`, `needs_review`.
- [ ] **P003-G3-S04 — Persist sau từng stage.** Upsert atomic kèm pipeline version; crash sau stage nào tiếp tục từ stage kế tiếp.
- [ ] **P003-G3-S05 — Nội dung cuối tương thích.** Trường `content` vẫn chứa Markdown cuối để API preview/download hiện tại không phải ghép artifact trung gian.
- [ ] **P003-G3-S06 — Dọn artifact.** Sau PASS, bỏ các bản full-text trung gian không cần thiết nhưng giữ báo cáo compact và usage; `needs_review` giữ đủ dữ liệu chẩn đoán.
- [ ] **P003-G3-S07 — Migration.** Script additive/idempotent, dry-run/count/index; không rewrite toàn bộ chunk cũ.
- [ ] **P003-G3-S08 — Version mismatch.** Artifact dở dang từ pipeline version khác không được trộn; khởi động lại chunk đó từ S1 nhưng không đụng chunk final đã hoàn thành.
- [ ] **P003-G3-S09 — Test resume.** Giả lập restart/lỗi DB sau mọi stage và assert không gọi lại stage đã commit.

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

- [ ] **P003-G4-S01 — Prompt nền.** Rút gọn yêu cầu trừu tượng, giữ mục tiêu học thuật, toàn văn, thuật ngữ y khoa Việt Nam và Markdown.
- [ ] **P003-G4-S02 — Quy tắc chuyên môn.** Nhấn mạnh phủ định, mức độ chắc chắn, quan hệ nhân quả, tác nhân–đích, giải phẫu, thuốc, liều, số liệu và viết tắt.
- [ ] **P003-G4-S03 — Few-shot.** Thêm số lượng nhỏ ví dụ Anh–Việt đã kiểm duyệt cho các lỗi khó; ví dụ không phụ thuộc một chuyên khoa duy nhất.
- [ ] **P003-G4-S04 — Audit prompt.** Nhận PDF + draft, kiểm từng phần nguồn, chỉ báo lỗi có exact excerpt; không chấm văn phong nếu không làm sai nghĩa.
- [ ] **P003-G4-S05 — Verify prompt.** Nhận PDF + bản revised/final, đánh giá độc lập và không dựa mù vào audit cũ.
- [ ] **P003-G4-S06 — Structured output.** Dùng `responseMimeType: application/json` và JSON schema SDK; parse/validate bằng code trước khi sử dụng.
- [ ] **P003-G4-S07 — Chống prompt injection từ sách.** Nội dung PDF là dữ liệu nguồn, không phải chỉ thị; model không làm theo câu lệnh nằm trong sách.
- [ ] **P003-G4-S08 — Invalid audit.** JSON lỗi/sai schema được retry stage với key khác; không chuyển thẳng sang revision bằng dữ liệu hỏng.
- [ ] **P003-G4-S09 — Test rubric.** Fixture lỗi có chủ đích cho omission, đảo phủ định, sai đơn vị, sai causal relation và lỗi thuật ngữ; audit phải bắt được theo ngưỡng đã chốt.

## G5 — Revision, verification và repair hữu hạn

Mục tiêu: sửa đúng lỗi đã nêu, hạn chế model viết lại phần vốn đúng và không tạo vòng lặp vô hạn.

- [ ] **P003-G5-S01 — Revision prompt.** Nhận PDF + draft + audit; áp dụng mọi lỗi critical/major hợp lệ, giữ nguyên phần khác và trả toàn bộ Markdown.
- [ ] **P003-G5-S02 — Empty audit.** Nếu audit PASS, S3 vẫn có thể được bỏ qua theo quyết định benchmark; mặc định ban đầu vẫn chạy S3 để pipeline đồng nhất cho tới khi có dữ liệu.
- [ ] **P003-G5-S03 — Verify gate.** Chỉ `PASS` mới đặt `qualityStatus = passed`; mọi error critical/major làm `FAIL`.
- [ ] **P003-G5-S04 — Minor-only policy.** Minor thuần văn phong không kích hoạt repair; lưu warning compact nếu cần.
- [ ] **P003-G5-S05 — Repair prompt.** Chỉ sửa lỗi từ S4 trên bản revised, không quay về draft và không sáng tác thêm giải thích.
- [ ] **P003-G5-S06 — Reverify.** Kiểm tra độc lập bản repaired; PASS thì hoàn thành, FAIL thì `needs_review`.
- [ ] **P003-G5-S07 — Bounded loop.** `repairCount <= 1` được enforce bằng code/schema/test, không chỉ bằng prompt.
- [ ] **P003-G5-S08 — Chọn bản tốt nhất.** Khi reverify fail, mặc định giữ bản repaired; nếu repair response không hợp lệ thì fallback revised.
- [ ] **P003-G5-S09 — Completion.** Job completed khi mọi chunk có `passed` hoặc `needs_review`; tổng warning được lưu và phát qua SSE.

## G6 — Key rotation, quota, retry và cancellation

Mục tiêu: tận dụng 7 project Free tier mà không tạo retry chậm, vượt quota cục bộ hoặc gọi trùng stage.

- [ ] **P003-G6-S01 — Round-robin theo request.** Mỗi stage reserve một key; không cần cùng key giữa các stage vì request stateless và luôn gửi đủ input.
- [ ] **P003-G6-S02 — 429 immediate rotation.** Đánh dấu key cooling down và chuyển ngay key khác; không chờ 12/24/36 giây trên cùng key.
- [ ] **P003-G6-S03 — Exhaustion policy.** Khi tất cả key 429, dùng Retry-After nếu có; nếu không có, exponential backoff + jitter và để queue retry bền vững.
- [ ] **P003-G6-S04 — Auth/config.** 401/403 loại key khỏi vòng hiện tại; chỉ báo config failure khi mọi key đều bị từ chối.
- [ ] **P003-G6-S05 — 5xx/network.** Retry hữu hạn, có thể chuyển key để loại trừ lỗi cục bộ nhưng không giả định đổi key luôn sửa được lỗi dịch vụ.
- [ ] **P003-G6-S06 — Quota counters.** Theo dõi rolling RPM/TPM/RPD theo key index để quan sát, không coi counter cục bộ là nguồn sự thật tuyệt đối sau restart.
- [ ] **P003-G6-S07 — Headroom.** Rollout đầu không chủ động vượt 12 RPM, 200k TPM hoặc 400 RPD/key dù ảnh cho thấy trần cao hơn.
- [ ] **P003-G6-S08 — Cancellation.** Kiểm tra abort trước/sau mọi stage; cancel không bắt đầu stage mới và không ghi completed sau khi bị hủy.
- [ ] **P003-G6-S09 — Circuit breaker.** Chỉ ngủ hệ thống khi toàn bộ key thực sự quota/unavailable; một key 429 không tăng failure toàn cục sai.
- [ ] **P003-G6-S10 — Test 7 key.** Mock phân phối 700 request, 429 xen kẽ, key auth lỗi và toàn bộ key exhausted; không lộ secret trong log.

## G7 — Queue, API, SSE và frontend

Mục tiêu: người dùng thấy tiến độ chất lượng nhưng API kết quả cũ vẫn hoạt động.

- [ ] **P003-G7-S01 — Chunk concurrency.** Giữ tối đa 2 chunk đang chạy; trong mỗi chunk, stage chạy tuần tự.
- [ ] **P003-G7-S02 — Progress model.** Job trả `currentQualityStage`, số chunk passed, warning, completed và tổng chunk.
- [ ] **P003-G7-S03 — SSE.** Phát stage bắt đầu/kết thúc, retry key, repair và needs-review bằng dữ liệu công khai, không gửi audit excerpt chứa nội dung sách nếu không cần.
- [ ] **P003-G7-S04 — UI label.** Hiển thị `Đang dịch`, `Đang kiểm định`, `Đang hiệu chỉnh`, `Đang xác minh`, `Đang sửa lỗi` và `Hoàn thành có cảnh báo`.
- [ ] **P003-G7-S05 — Result API.** Preview/copy/download chỉ trả final `content`; artifact audit có endpoint debug riêng hoặc không public trong v1.
- [ ] **P003-G7-S06 — Warning UX.** Cho biết số chunk cần xem lại và page range tương ứng; không gọi bản dịch “đã kiểm chứng hoàn toàn”.
- [ ] **P003-G7-S07 — Resume UX.** F5/reconnect đọc stage từ MongoDB, không reset progress về đầu.
- [ ] **P003-G7-S08 — Legacy compatibility.** Job cũ không có quality fields vẫn hiển thị và download bình thường.
- [ ] **P003-G7-S09 — Cancellation/delete.** Dọn artifact trung gian cùng TranslationChunk và source theo semantics P001–P002.

## G8 — Kiểm thử, benchmark đầy đủ và tiêu chí chất lượng

Mục tiêu: chứng minh pipeline mới tăng chất lượng mà không phá độ ổn định.

- [ ] **P003-G8-S01 — Unit test config.** 2 trang/chunk, high thinking, temperature 1.0, output budget và response metadata.
- [ ] **P003-G8-S02 — Unit test stage machine.** PASS trực tiếp, FAIL→repair→PASS, FAIL lần hai→needs_review, invalid JSON và MAX_TOKENS.
- [ ] **P003-G8-S03 — Resume matrix.** Restart sau S1–S6, lỗi DB trước/sau persist, lease hết hạn và worker cũ không ghi đè worker mới.
- [ ] **P003-G8-S04 — Error matrix.** 400/401/403/429/5xx/timeout/abort/safety/recitation/empty response/invalid schema.
- [ ] **P003-G8-S05 — Regression P001–P002.** Upload batch R2, source resolver, queue claim, cancellation, cleanup, result streaming, frontend test/lint/build.
- [ ] **P003-G8-S06 — Smoke một PDF.** Chạy quality mode trên một tài liệu ngắn, kiểm DB artifact, UI, download và cleanup R2.
- [ ] **P003-G8-S07 — Benchmark 20 PDF.** Codex chủ động gửi các PDF/page sample qua API theo manifest và ma trận đã chốt; không yêu cầu người dùng tự tạo sample text.
- [ ] **P003-G8-S08 — Kiểm quota.** Ghi request/key, token/stage, 429, latency và RPD ước tính; xác nhận phân phối không dồn một project.
- [ ] **P003-G8-S09 — Báo cáo chất lượng.** Tổng hợp lỗi theo category/severity và chuyên khoa; kèm ví dụ ngắn hợp lệ, không commit toàn bộ nội dung sách.
- [ ] **P003-G8-S10 — Cổng chấp nhận.** Chủ dự án duyệt các khác biệt critical/major và quyết định bật quality mode; không rollout chỉ dựa trên self-judge của Flash-Lite.
- [ ] **P003-G8-S11 — Hiệu năng.** Đo thời gian/chunk và toàn bộ 370 trang; xác nhận 4–6 stage không làm Render timeout hoặc lease hết hạn.
- [ ] **P003-G8-S12 — Tài nguyên.** Đo RAM/disk/Mongo growth khi giữ artifact, rồi xác nhận cleanup artifact sau PASS.

## G9 — Rollout production, theo dõi và đóng dự án

Mục tiêu: triển khai cuốn chiếu, có rollback và bằng chứng production.

- [ ] **P003-G9-S01 — Backup/dry-run.** Đếm Job/TranslationChunk; backup nếu có dữ liệu cần giữ; chạy migration dry-run và verify index.
- [ ] **P003-G9-S02 — Deploy backend additive.** Để mode mặc định `legacy`, smoke API/schema/SSE và một job legacy trước khi bật quality.
- [ ] **P003-G9-S03 — Deploy frontend.** UI mới phải tương thích backend cũ trong cửa sổ deploy và không làm mất download hiện tại.
- [ ] **P003-G9-S04 — Canary.** Bật quality cho một PDF ngắn, sau đó một PDF dài; theo dõi stage, quota, lease, artifact và cleanup.
- [ ] **P003-G9-S05 — Batch 5 PDF.** Chạy đa chuyên khoa, xác nhận phân phối key, warning, resume và bản tải xuống.
- [ ] **P003-G9-S06 — Bật mặc định.** Chỉ chuyển mode mặc định sang quality sau canary đạt và benchmark được duyệt.
- [ ] **P003-G9-S07 — Rollback drill.** Chuyển về legacy bằng config, xác nhận job quality đang dở không bị ghi sai và job mới vẫn chạy.
- [ ] **P003-G9-S08 — Theo dõi 24 giờ.** RPM/TPM/RPD, 429, token thinking/output, latency stage, needs_review, retry, Render RAM/disk/restart và Mongo growth.
- [ ] **P003-G9-S09 — Tối ưu sau dữ liệu.** Chỉ bỏ S3 khi audit PASS, thêm micro-glossary hoặc điều chỉnh prompt nếu số liệu chứng minh lợi ích; không thêm độ phức tạp theo cảm tính.
- [ ] **P003-G9-S10 — Cập nhật docs.** Đồng bộ README, `.env.example`, tài liệu vận hành, prompt version, schema/migration và cách đọc warning.
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

## 12. Điều kiện hoàn thành PROJECT 003

- [ ] Benchmark B0–B4 trên PDF thực đã hoàn thành và có báo cáo.
- [ ] Chủ dự án xác nhận quality mode cải thiện rõ các đoạn chuyên sâu đại diện.
- [ ] Không còn `temperature: 0.1` trong quality mode; mọi stage đúng thinking high.
- [ ] PDF được cắt 2 trang và page order giữ nguyên.
- [ ] Audit/verify dùng structured output được validate.
- [ ] Mọi stage persist/resume an toàn qua restart.
- [ ] `MAX_TOKENS`, response rỗng và JSON hỏng không bị coi là thành công.
- [ ] Repair loop bị giới hạn và `needs_review` hoạt động.
- [ ] 429 chuyển key ngay; quota/circuit breaker không bị tính sai.
- [ ] Upload R2, queue, cancellation, cleanup, preview và download không regression.
- [ ] Frontend hiển thị stage và cảnh báo chất lượng rõ ràng.
- [ ] Canary, batch 5 PDF và theo dõi production 24 giờ đạt.
- [ ] README/tài liệu vận hành/migration/rollback đã đồng bộ.
