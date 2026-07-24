# Báo cáo audit luồng dịch StudyMed Translator — baseline lịch sử trước P011/P013

> **Trạng thái tài liệu:** đầu vào lịch sử cho P011. Các vấn đề quota dead-time và
> project-group scheduler đã được P011 xử lý; nút thắt MongoDB liên vùng được P012 xử
> lý bằng controlled cold start tại US East; retry amplification/circuit/maintenance
> được P013 sửa tại `0f739b1`. Không dùng snapshot hoặc câu “code hiện tại” dưới đây
> để suy luận kiến trúc/production hiện hành. Trạng thái active nằm tại
> `project-011.md`; cách P013 thay đổi giả định P011 nằm tại
> `project-011-p013-compatibility-report.md`.

**Ngày audit:** 23/07/2026

**Mốc code lịch sử:** trước `ab15301` và trước containment P013 `0f739b1`

**Phạm vi:** backend, queue, PDF splitting, quality pipeline, Gemini scheduler/limiter, retry, dữ liệu vận hành production và test hiện có.

**Nguyên tắc:** audit chỉ đọc; không sửa code production, không thay cấu hình, không gọi Gemini thử nghiệm và không làm thay đổi job.

## 0. Cách đọc sau P013

Tài liệu này giữ nguyên phát hiện gốc để giải thích nguồn gốc P011. Trạng thái hiện
hành của các phát hiện quan trọng:

| Phát hiện lịch sử | Trạng thái hậu P011/P012/P013 |
| --- | --- |
| Quota theo key, không có stable project ID | Đã sửa: broker theo stable project; P013 xác nhận 50 key thuộc 50 project độc lập |
| Một logical stage quét 50 key | Đã sửa: hard cap 3 physical attempt/stage; P013 chặn burst toàn hệ thống sau 5 project `429` |
| Circuit chỉ hibernate sau 10 pool exhaustion | Đã thay: P013 mở circuit sau 5 project `429`/10 giây và hibernate theo deadline authoritative |
| Dispatcher tạo batch theo configured max | Đã sửa bởi P013: dùng adaptive current limit |
| Maintenance pause không hard-drain | Đã sửa bởi P013: suspend an toàn tại ranh giới stage và persist pending |
| MongoDB liên vùng | Đã xử lý bởi P012 |
| Quota/cooldown/circuit chỉ ở RAM | Đã xử lý phần scheduler cần thiết bằng MongoDB additive state |
| Thiếu logical/physical/amplification/circuit metrics | Đã bổ sung phần chính; token/cost và clinical audit độc lập vẫn còn thiếu |
| Throughput ≥5× | Chưa chứng minh; vẫn là blocker đóng P011 |

P013 là safety authority. Nếu một đề xuất lịch sử dưới đây yêu cầu quét pool, reset
gate sau một success hoặc tăng concurrency để thử, semantics P013 và hồ sơ hiện hành
được ưu tiên.

## 1. Kết luận điều hành

Hệ thống chậm không phải vì thiếu API key. Nguyên nhân chính là kiến trúc đang đồng thời:

1. coi quota là **theo API key**, trong khi Gemini áp rate limit **theo project**;
2. giới hạn throughput thực ở tối đa **6 request Gemini đồng thời**, bất kể có 50 key;
3. biến mỗi chunk 2 trang thành tối thiểu **4**, thường **6–8** lượt Gemini tuần tự;
4. có thể xoay xuyên **cả 50 key cho một logical stage** khi gặp schema/content/5xx;
5. retry ở cấp toàn job, khiến cùng một PDF bị tải lại và cắt lại nhiều lần;
6. thiếu telemetry để phân biệt logical request, physical attempt, loại quota và thời gian chờ.

Không nên “sửa nhanh” bằng cách tăng concurrency lên 50. Với retry hiện tại, thao tác đó có thể làm số request lỗi, 429, chi phí và thời gian chờ tăng nhanh hơn throughput.

Đánh giá tổng quát:

| Hạng mục | Đánh giá |
|---|---|
| Tính bền vững dữ liệu/resume | Khá tốt |
| Atomic job claim/lease | Khá tốt |
| Tận dụng quota | Kém |
| Retry/error classification | Nguy hiểm ở quy mô 50 key |
| Hiệu suất quality pipeline | Kém |
| Khả năng quan sát production | Thiếu nghiêm trọng |
| Khả năng scale ngang | Chưa sẵn sàng |
| Mức cần tái cấu trúc | Cao, nhưng có thể triển khai theo pha |

## 2. Dữ liệu production tại thời điểm audit

Production thay đổi trong lúc audit, nên các số dưới đây là snapshot gần nhau chứ không phải một transaction duy nhất.

### 2.1. Hàng đợi

| Chỉ số | Giá trị quan sát |
|---|---:|
| Tổng quality job | 286 |
| Completed | 116 |
| Pending | 167 |
| Processing | 3 |
| Pending mang `GEMINI_RATE_LIMIT` | 165 |
| Tổng retry đã ghi nhận | khoảng 1.288 |
| Quota retry đã ghi nhận | khoảng 1.276 |
| Dung lượng source gốc | khoảng 306 MB |
| Dung lượng download ước tính theo `sourceSize × attemptCount` | khoảng 1,51 GB |
| Tổng chunk theo job | 3.162 |

Chỉ riêng việc retry đã làm lượng tải source ước tính cao gần **5 lần** dữ liệu gốc. Chưa tính chi phí cắt PDF lại, tạo buffer lại và ghi/đọc MongoDB lại.

### 2.2. Quality pipeline

Snapshot 1.380 chunk đã persist:

| Trạng thái | Số chunk |
|---|---:|
| Passed | 1.012 |
| Needs review | 95 |
| Chưa terminal | 273 |

5.773 Gemini call thành công đã được persist metadata, chưa tính request thất bại:

| Stage | Call thành công | Latency TB | p95 latency |
|---|---:|---:|---:|
| `translate` | 1.337 | 21,8 giây | 34,0 giây |
| `medical_audit` | 1.288 | 17,5 giây | 26,8 giây |
| `revise` | 1.251 | 9,4 giây | 17,2 giây |
| `verify` | 1.141 | 16,3 giây | 25,5 giây |
| `repair` | 309 | 9,5 giây | 16,5 giây |
| `reverify` | 290 | 17,2 giây | 27,0 giây |
| `repair_2` | 82 | 9,1 giây | 14,6 giây |
| `reverify_2` | 75 | 17,2 giây | 26,9 giây |

Tổng latency Gemini cộng dồn của call thành công là khoảng **25,6 giờ**.

Token đã ghi nhận:

| Loại | Tổng |
|---|---:|
| Prompt token | khoảng 24,36 triệu |
| Output token | khoảng 10,73 triệu |
| Thinking token | khoảng 25,00 triệu |

Thinking token đang lớn hơn cả prompt token. Đây là hậu quả trực tiếp của việc bắt mọi stage dùng `ThinkingLevel.HIGH`.

### 2.3. Thời gian hoàn thành

Với 116 job completed:

| Chỉ số | p50 | p95 | Max |
|---|---:|---:|---:|
| Từ upload đến completed | 2,99 giờ | 10,83 giờ | 11,94 giờ |
| Từ lúc context đã tạo đến completed | 0,10 giờ | 5,98 giờ | 7,60 giờ |
| Gemini call thành công/job | 29 | 81 | 185 |
| Retry/job | 2 | 6 | 6 |

Khoảng cách rất lớn giữa p50 và p95 sau context cho thấy tail latency bị retry/quota chi phối, không phải R2 hay PDF splitting đơn thuần.

## 3. Luồng hiện tại và các trần throughput

```text
Job queue
  └─ tối đa 3 job production
       ├─ tải source R2
       ├─ cắt toàn PDF thành chunk 2 trang
       ├─ document_context: 1 call/job
       └─ tối đa 2 chunk/job
            └─ translate → audit → revise → verify
                                      └─ repair → reverify, tối đa 2 vòng

Toàn bộ request quality
  └─ AdaptiveGeminiLimiter: khởi động 3, trần 6
       └─ GeminiKeyScheduler: xoay trong 50 key
```

Giới hạn đồng thời thực:

- `TRANSLATION_WORKER_CONCURRENCY=3` trên production;
- `QUALITY_CHUNK_CONCURRENCY=2`;
- global limiter bắt đầu ở 3 và không vượt quá 6.

Vì vậy trần lý thuyết hiện tại là `3 job × 2 chunk = 6`, vừa đúng trần limiter. Key thứ 7 đến key thứ 50 không tạo thêm concurrency.

Với latency trung bình khoảng 16–22 giây/request, concurrency 6 chỉ cho cỡ 16–22 request thành công/phút trong điều kiện đẹp. Sau đó còn phải chia cho 4–8 call/chunk.

## 4. Phát hiện ưu tiên

## P0 — Cách hiểu quota theo key là sai mô hình

> **Trạng thái hậu P011/P013:** ĐÃ KHẮC PHỤC PHẦN MÔ HÌNH. Scheduler dùng stable
> project ID và shared RPD pool; P013 xác nhận mỗi key production thuộc một project
> độc lập. Tuy nhiên configured counter vẫn không phải quota dashboard động và không
> chứng minh upstream capacity đồng đều.

**Code:** `geminiKeyScheduler.js`, các state RPM/TPM/RPD được tạo theo `keyIndex`.

Google quy định rate limit Gemini áp dụng **theo project, không theo API key**. Do đó:

- nếu 50 key cùng project, throughput quota gần như không tăng;
- scheduler lại tưởng có 50 bucket riêng, nên có thể phát vượt quota project;
- nếu key thuộc nhiều project, code hiện không biết key nào thuộc project nào và không thể giới hạn đúng;
- `available` trong API status chỉ có nghĩa là key từng thành công và không nằm trong cooldown cục bộ; nó không xác nhận quota thật còn khả dụng.

Các ngưỡng `12 RPM / 200k TPM / 400 RPD` đang hard-code theo key cũng không phản ánh tier/model thực tế trong AI Studio.

**Tác động:** 429 hàng loạt, điều phối sai, trạng thái key gây hiểu nhầm, không thể dự báo capacity.

**Giải pháp:**

1. cấu hình mỗi credential kèm `projectId`, tier và model;
2. quota bucket phải theo `(projectId, model)`, không theo key;
3. nhiều key cùng project chỉ là credential dự phòng, không phải capacity độc lập;
4. lấy quota thực từ AI Studio/config vận hành, không hard-code một giá trị giả định;
5. ưu tiên một hoặc vài project trả phí hợp lệ và xin tăng quota chính thức thay vì tăng số key không kiểm soát.

Nguồn chính thức:

- https://ai.google.dev/gemini-api/docs/rate-limits

## P0 — Một logical stage có thể phát 50 physical request

> **Trạng thái hậu P011/P013:** ĐÃ KHẮC PHỤC. P011 giới hạn tối đa 3 physical
> attempt/logical stage. P013 còn mở global circuit sau 5 project độc lập trả `429`
> trong 10 giây; regression 30 logical stage/limiter 1 dừng trong tối đa 6 physical
> `429`.

**Code:** `geminiKeyScheduler.js:164–256`.

Mọi lỗi có `retryable`, lỗi không có HTTP status, schema invalid, output truncated, blocked và 5xx đều có thể bị xem là lý do chuyển key. Vòng lặp chỉ dừng khi:

- có một key thành công;
- gặp config error;
- hoặc đã thử hết pool.

Mô phỏng thuần cục bộ với đúng 50 key hiện tại:

| Kịch bản cho 1 logical stage | Physical call | Lỗi cuối |
|---|---:|---|
| Cả 50 trả schema invalid | 50 | `GEMINI_SCHEMA_INVALID` |
| Key đầu 429, 49 key sau schema invalid | 50 | `GEMINI_RATE_LIMIT` |
| Cả 50 trả 503 | 50 | `GEMINI_UNAVAILABLE` |

Kịch bản thứ hai còn **che mất nguyên nhân gốc**: chỉ một 429 đủ làm lỗi cuối thành pool exhausted dù phần lớn lỗi là content/schema.

Test hiện có không bắt lỗi thiết kế này; ngược lại test `invalid structured response rotates key` đang cố ý bảo vệ hành vi xoay key.

**Tác động:**

- request amplification tối đa 50× cho một stage;
- một stage giữ slot limiter trong toàn bộ chuỗi rotate;
- quota bị đốt nhanh;
- 429 có thể là hậu quả của retry, không phải nguyên nhân ban đầu;
- một stage kẹt có thể lặp nhiều processing attempt, làm hệ số khuếch đại còn lớn hơn.

**Giải pháp:** phân loại lỗi theo phạm vi.

| Nhóm lỗi | Xử lý đúng |
|---|---|
| Credential-scoped: 401/403 | Disable credential; thử credential/project hợp lệ khác |
| Project quota: 429 | Cooldown cả project/model; chỉ chuyển sang project khác có quota |
| Request/content: schema, blocked, truncated, coverage | Tối đa 1–2 lần regenerate có chiến lược; không quét 50 key |
| Service-scoped: 5xx/network | Backoff có jitter, tối đa 2–3 lần; không quét toàn pool tức thì |
| Config: model/input 400/404 | Fail fast |

Đặt ngân sách cứng:

- `maxPhysicalAttemptsPerStage <= 3`;
- `maxProjectRotationsPerStage` riêng;
- lỗi cuối phải giữ `primaryCause`, không chọn theo việc từng có một 429.

## P0 — Circuit breaker phản ứng quá muộn

> **Trạng thái hậu P013:** ĐÃ KHẮC PHỤC THEO SEMANTICS MỚI. Circuit không đợi quét
> hết pool; gate được re-check trước request, persist qua restart và hibernate queue
> theo cùng deadline. Đề xuất lịch sử “một success reset gate” không còn áp dụng:
> P013 cần 10 physical success liên tiếp để reset backoff nhằm không xóa tín hiệu của
> một burst lớn chỉ vì success xen kẽ.

**Code:** `queueManager.js:47–52`, `queueManager.js:914–955`.

Hệ thống chỉ hibernate sau **10 lần pool exhaustion liên tiếp**. Với 50 key, về lý thuyết 10 lần exhaustion có thể xảy ra sau hàng trăm physical request lỗi.

Trong lúc đó worker tiếp tục:

1. claim job khác;
2. tải source;
3. cắt lại PDF;
4. thử stage;
5. trả job về pending.

**Giải pháp:**

- khi toàn bộ project bucket không cấp phát được, mở global quota gate ngay lần đầu;
- lưu `nextAvailableAt` tập trung;
- không claim job Gemini mới trước thời điểm đó;
- cho request đang chạy hoàn tất;
- `[Lịch sử — đã bị P013 supersede]` reset gate khi có một project được xác nhận
  thành công, không cần chờ một job dài hoàn tất.

## P1 — Quality pipeline dùng quá nhiều stage bắt buộc

**Code:** `qualityPipelineState.js:36–49`.

Happy path luôn là:

```text
translate → medical_audit → revise → verify
```

Ngay cả khi audit `PASS`, state machine vẫn bắt buộc `revise`.

Dữ liệu:

- 449/1.288 audit có `PASS`, khoảng 35%;
- cả nhóm này vẫn phát sinh `revise`;
- 1.251 call revise tốn tổng khoảng 3,27 giờ latency Gemini cộng dồn;
- p50 một chunk dùng 4 call, p95 dùng 8 call.

**Cải tiến ít rủi ro:** audit PASS + coverage complete thì dùng `draftContent` làm `revisedContent` và đi thẳng `verify`. Chỉ riêng dữ liệu hiện có, cách này tránh khoảng 449 call revise, tương đương 7,8% tổng call thành công đã quan sát.

**Cải tiến kiến trúc:** gộp `medical_audit + revise` thành một stage `review_and_correct` trả:

- `status`;
- evidence/errors;
- `correctedMarkdown` khi cần.

Sau đó:

- fast profile: hoàn tất sau review nếu kiểm tra deterministic đạt;
- clinical profile: dùng một reviewer độc lập để verify;
- repair chỉ chạy khi verify thật sự FAIL.

Mục tiêu hợp lý là **2 call/chunk ở đường bình thường**, thay vì 4.

## P1 — Mọi stage bị ép `ThinkingLevel.HIGH`

**Code:** `qualityGeminiExecutors.js:60–74`.

`GEMINI_THINKING_LEVEL` được parse trong config nhưng executor không dùng; code hard-code `ThinkingLevel.HIGH`.

Dữ liệu cho thấy khoảng:

- 25,00 triệu thinking token;
- 10,73 triệu output token.

Đặc biệt:

| Stage | Thinking token trung bình/call |
|---|---:|
| Translate | khoảng 6.008 |
| Audit | khoảng 5.678 |
| Verify | khoảng 5.341 |
| Revise | khoảng 1.175 |

Google mô tả thinking level thấp là lựa chọn giảm latency/chi phí cho workload throughput cao.

**Giải pháp:**

- `translate`: LOW hoặc MEDIUM, A/B chất lượng;
- `revise/repair`: LOW;
- `audit/verify`: MEDIUM/HIGH tùy clinical profile;
- context: MEDIUM;
- config phải thực sự được executor sử dụng;
- ghi thinking token và quality outcome theo stage để ra quyết định bằng dữ liệu.

Nguồn chính thức:

- https://ai.google.dev/gemini-api/docs/generate-content/thinking

## P1 — Concurrency bị hard-code và gắn sai tầng

**Code:**

- `queueManager.js:52`: `QUALITY_CHUNK_CONCURRENCY = 2`;
- `adaptiveGeminiLimiter.js:8–13`: 3 → 6;
- `env.js:79–87`: worker chỉ cho 1–5.

Vấn đề không phải chỉ là các con số nhỏ. Job concurrency, chunk concurrency, API concurrency và quota đang trộn vào nhau.

**Thiết kế đích:**

- job coordinator không giữ hai chunk worker cố định;
- mọi chunk-stage sẵn sàng đi vào một durable global stage queue;
- quota broker quyết định request nào được chạy theo project/model;
- source/RAM limiter độc lập với Gemini limiter;
- fairness theo job để một PDF lớn không chiếm toàn hệ thống.

Sau khi sửa retry, concurrency nên được tune bằng:

- active quota thật;
- p95 latency;
- TPM dự kiến;
- tỷ lệ 429;
- RAM và kích thước PDF;
- AIMD/token-bucket, không theo số lượng key.

## P1 — Retry ở cấp job gây làm lại I/O và CPU

**Code:** `queueManager.js:785–899`, `queueManager.js:901–956`.

Một stage gặp quota error làm cả job thoát. Lần retry sau:

- resolve/download source lại;
- spawn PDF worker lại;
- đọc toàn PDF lại;
- cắt lại tất cả chunk;
- load toàn bộ chunk buffer lại;
- rồi mới resume từ stage đã persist.

Production có khoảng 306 MB source nhưng download proxy đã lên khoảng 1,51 GB.

**Giải pháp:** retry/persist ở cấp `chunk-stage`, không ở cấp job.

Job chỉ chuyển failed khi:

- source không còn;
- config terminal;
- hoặc có chunk terminal theo policy.

Quota của một chunk không được làm toàn PDF quay lại từ đầu.

## P1 — Fixed chunk 2 trang tạo quá nhiều request

**Code:** `env.js:73`, mặc định 2 trang.

Dữ liệu translate hiện tại:

| Token | Trung bình | p95 | Max |
|---|---:|---:|---:|
| Prompt | 1.977 | 2.293 | 2.923 |
| Output | 2.643 | 4.246 | 6.182 |

Các con số này cho thấy còn khoảng trống đáng kể để thử chunk 4 trang. Việc tăng mù lên 8–10 trang vẫn không nên vì bảng/hình và output có độ lệch cao.

**Khuyến nghị:**

1. canary 5–10% job với 4 trang/chunk;
2. theo dõi output p95, truncated rate, needs-review rate và wall time/page;
3. nếu ổn, dùng adaptive chunking 3–6 trang theo mật độ nội dung/token dự kiến;
4. giới hạn bằng token/output budget, không chỉ số trang.

Chỉ đổi 2 → 4 trang có thể giảm gần một nửa số logical stage, nhưng mức tăng tốc thật phải đo vì output mỗi request cũng dài hơn.

## P1 — PDF được gửi inline lặp lại ở mọi stage

**Code:** `qualityGeminiExecutors.js:110–165`, `geminiAdapter.js:92–107`.

Cùng một chunk PDF được base64 và gửi lại ở translate, audit, revise, verify, repair và reverify.

Google khuyến nghị Files API khi tài liệu được tái sử dụng qua nhiều request vì giảm bandwidth và request latency.

**Giải pháp:**

- upload chunk một lần cho project/client đang xử lý;
- reuse file URI cho các stage;
- bind chunk lifecycle với project để tránh chuyển credential sai phạm vi;
- re-upload nếu URI hết hạn;
- xóa file ở terminal/finally;
- không persist URI như dữ liệu public.

Nguồn chính thức:

- https://ai.google.dev/gemini-api/docs/document-processing
- https://ai.google.dev/gemini-api/docs/files

## P1 — Giới hạn upload 350 MB không khớp Gemini PDF

**Code:** `env.js:115`, context dùng Files API cho toàn source.

App cho phép file tới 350 MB, trong khi tài liệu Gemini hiện nêu giới hạn PDF 50 MB cho luồng document processing.

**Tác động:** file hợp lệ với app có thể fail ở `document_context`.

**Giải pháp:**

- validate theo giới hạn thực của model/API trước khi queue;
- hoặc tạo context phân cấp theo segment rồi merge;
- không upload toàn PDF lớn trong một call.

## P2 — Quá nhiều MongoDB query cho mỗi stage

**Code:** `queueManager.js:719–779`.

Mỗi stage thường:

- `assertJobActive` trước và sau Gemini;
- `getQualityProgress` khi started;
- update Job khi started;
- persist transition;
- `getQualityProgress` khi completed;
- update Job khi completed.

Mỗi `getQualityProgress` lại chạy 3 query. Như vậy một Gemini stage có thể kéo theo khoảng 9–11 DB operation.

**Giải pháp:**

- progress dùng atomic counter khi chunk terminal;
- throttle UI progress event;
- warning list chỉ query khi client yêu cầu hoặc khi job terminal;
- cancel/lease vẫn giữ kiểm tra đúng chỗ, nhưng không cần scan progress hai lần/stage.

## P2 — Scheduler state chỉ nằm trong RAM

> **Trạng thái hậu P011/P013:** ĐÃ KHẮC PHỤC PHẦN QUOTA AN TOÀN. Project quota state,
> cooldown/consecutive rate-limit, group cursor và global circuit được persist trong
> MongoDB. Limiter active/waiting vẫn là runtime state theo thiết kế; không được dùng
> execution version `project-pool-v2` một mình để phân biệt deploy trước/sau P013.

RPM, TPM, RPD, disabled key, cooldown và limiter đều mất khi restart. Trạng thái production sau restart bắt đầu lại từ 0 dù quota Google không reset.

**Tác động:**

- headroom nội bộ không đáng tin;
- restart có thể tạo burst;
- nhiều instance sẽ nhân đôi capacity giả;
- API key status không phản ánh lịch sử thực.

**Giải pháp:** persist quota bucket/cooldown theo project trong Redis hoặc MongoDB có atomic update. Với quy mô hiện tại có thể dùng MongoDB trước để tránh thêm hạ tầng; khi scale nhiều worker thì chuyển quota broker sang Redis.

## P2 — Observability chưa đo phần quan trọng nhất

> **Trạng thái hậu P011/P013:** ĐÃ KHẮC PHỤC PHẦN VẬN HÀNH CỐT LÕI. Status/metrics
> hiện có logical scheduled/issued, physical attempt, amplification, 429,
> limiter/current limit, group utilization, gate/circuit/backoff, watchdog,
> Mongo/quota latency và pages/hour. Token/cost/page, quota dimension upstream và
> clinical validation độc lập vẫn chưa có.

`/metrics` hiện chủ yếu đo upload/R2. Không có:

- logical stage count;
- physical Gemini attempt count;
- attempt/logical ratio;
- latency theo stage và percentile;
- 429 theo project/model/quota dimension;
- limiter active/waiting/current limit;
- queue wait, processing duration;
- PDF split duration;
- retry reason gốc và reason cuối;
- token/cost/page;
- throughput page/phút.

Schema Job cũng không có `processingStartedAt` và `completedAt` riêng, nên audit phải suy luận bằng `createdAt`, `updatedAt` và `qualityContextGeneratedAt`.

**Giải pháp:** bổ sung telemetry trước khi tune concurrency. Nếu không, mọi tối ưu chỉ là đoán.

## P2 — Head-of-line blocking ở source budget

`claimAdmissibleJob` chỉ nhìn job FIFO đầu. Nếu job đó không vừa phần budget RAM proxy còn lại, worker dừng dù phía sau có job nhỏ đủ chỗ.

Đây chưa phải nút thắt hiện tại vì production đang đủ 3 active job, nhưng sẽ xuất hiện khi nâng concurrency.

**Giải pháp:** giữ fairness nhưng cho phép bounded look-ahead, ví dụ quét tối đa 10 candidate và không để job lớn bị starvation.

## 5. Điểm đang làm tốt và nên giữ

Không nên viết lại toàn bộ một cách mù quáng. Các phần sau có giá trị:

- atomic pending → processing claim;
- processing token và lease heartbeat;
- resume theo stage đã persist;
- optimistic stage transition tránh ghi đè;
- bounded repair cycle;
- source cleanup và R2 lifecycle;
- cancellation checks;
- structured validation và quality warning;
- redaction secret;
- worker thread cho PDF.

Tái cấu trúc nên giữ các invariant trên và thay tầng scheduling/orchestration.

## 6. Kiến trúc đích đề xuất

```text
Upload/R2
  ↓
Job Coordinator
  ├─ Context Task (1 lần/job hoặc context phân cấp)
  └─ Chunk Task records bền vững
       ↓
Durable Global Stage Queue
  ├─ fairness theo job
  ├─ retry theo stage
  └─ priority
       ↓
Quota Broker theo (project, model)
  ├─ RPM/TPM/RPD thực
  ├─ cooldown/circuit breaker
  ├─ physical-attempt budget
  └─ adaptive concurrency
       ↓
Gemini Executor
  ├─ file URI reuse
  ├─ thinking theo stage
  └─ error classification
       ↓
Chunk Artifact + Job Aggregator
```

### Profile sản phẩm

Nên tách rõ hai mục tiêu thay vì bắt mọi tài liệu dùng pipeline đắt nhất:

**Fast**

- adaptive 4 trang/chunk;
- translate;
- deterministic guard;
- review-and-correct khi rủi ro hoặc theo sampling;
- 1–2 call/chunk.

**Clinical**

- adaptive 3–4 trang/chunk;
- translate;
- reviewer độc lập review-and-correct;
- verify chỉ khi có correction/high-risk hoặc luôn bật theo chính sách;
- 2–3 call/chunk ở đa số trường hợp;
- audit sample thủ công để theo dõi chất lượng thật.

Chạy nhiều lượt cùng một model không tạo độc lập thực sự. Với clinical profile, chất lượng tốt hơn có thể đến từ một reviewer model mạnh hơn ở ít stage hơn, thay vì 4–8 lượt cùng model Flash-Lite.

## 7. Lộ trình triển khai

### Pha 0 — Chặn cháy quota, 0,5–1 ngày

> **Trạng thái hậu P013:** Pha an toàn này đã được P011/P013 triển khai theo kiến trúc
> production hiện hành. Không dùng danh sách dưới đây để yêu cầu tăng concurrency;
> mọi rollout tiếp tục phải tuân thủ circuit và gate trong `project-011.md`.

1. Phân loại lỗi theo credential/project/request/service.
2. Giới hạn physical attempt/stage tối đa 2–3.
3. Không để một 429 che schema/content cause.
4. Global quota gate mở ngay khi mọi project không khả dụng.
5. Thêm counter logical/physical/429/latency.
6. Xác minh 50 key thuộc bao nhiêu project và tier nào.

**Không tăng concurrency trong pha này.**

### Pha 1 — Quick wins có đo lường, 1–2 ngày

1. Dùng thinking level theo stage.
2. Skip revise khi audit PASS.
3. Cho chunk concurrency và limiter config được, nhưng giới hạn theo quota broker.
4. Canary 4 trang/chunk.
5. Thêm `processingStartedAt`, `completedAt`, stage attempt telemetry.
6. Batch/throttle progress update MongoDB.

### Pha 2 — Tái cấu trúc queue, 3–5 ngày

1. Tạo durable chunk-stage task.
2. Retry stage thay vì retry job.
3. Global fair stage queue.
4. Persist project quota/cooldown.
5. Reuse Gemini File URI theo chunk.
6. Migration/resume tương thích artifact cũ.

### Pha 3 — Tối ưu quality/cost, 2–4 ngày

1. Gộp audit + revise thành review-and-correct.
2. Tách Fast/Clinical profile.
3. A/B thinking LOW/MEDIUM/HIGH.
4. Đánh giá độc lập trên corpus chuẩn, không chỉ dựa PASS tự báo bởi model.
5. Chốt concurrency bằng dữ liệu p95 và quota thật.

## 8. Tiêu chí nghiệm thu

### Reliability

- Không lặp stage đã persist.
- Không có duplicate chunk.
- Cancel và lease recovery vẫn đúng.
- Một stage lỗi không làm tải/cắt lại toàn PDF.

### Throughput

- `physical_attempts / logical_stages <= 1,15` trong vận hành bình thường.
- Mọi lỗi đều có hard cap `physicalAttempts <= 3`.
- 429 < 1% physical request sau warm-up, hoặc nằm trong SLO đã chốt.
- Theo dõi page/phút, không dùng key/phút làm KPI.
- p95 queue wait và p95 processing time giảm theo mục tiêu đã chốt.

### Quality

- Needs-review rate không tăng ngoài biên cho phép.
- Không tăng omission/number-unit/negation error trên corpus chuẩn.
- Fast và Clinical có rubric riêng.
- Reviewer độc lập kiểm ít nhất một sample cố định sau mỗi thay đổi prompt/model.

### Cost

- Prompt, output, thinking token/page.
- Cost/page và cost/job.
- Retry token < 5% tổng token.

## 9. Test bắt buộc cần bổ sung

1. 50 key cùng trả schema invalid nhưng physical call không vượt budget.
2. Một 429 + nhiều schema invalid không bị kết luận sai là pool exhausted.
3. 503 diện rộng không quét cả 50 key.
4. Nhiều key cùng project chia sẻ một quota bucket.
5. Nhiều project có bucket độc lập.
6. Restart không reset RPD/cooldown đã persist.
7. Circuit breaker dừng claim ngay khi toàn project hết quota.
8. Stage retry không download/split lại source.
9. Audit PASS bỏ qua revise nhưng artifact/resume vẫn đúng.
10. Chunk 4 trang không tăng truncation và quality regression.
11. Load test đo logical/physical ratio với 50 credential mock.

Trạng thái hậu P013:

- Đã có regression cho hard cap schema/503, mixed 429/content cause, nhiều project
  độc lập, persisted quota/cooldown, circuit burst, gate re-check, adaptive
  dispatcher, maintenance drain và load 300 stage.
- “Nhiều key cùng project” không phải topology production hiện hành; config từ chối
  duplicate stable project ID và P013 xác nhận mapping 1:1.
- Stage retry không download/split lại source hoàn toàn vẫn chưa được chứng minh ở
  mọi đường deferral/restart.
- Skip revise và chunk 4 trang không được P011/P013 triển khai vì bất biến hiện hành
  khóa pipeline/chunk size; muốn đổi phải mở dự án quality riêng.
- Trước khi đóng P011 vẫn cần test circuit/cooldown cắt ngang Pacific reset,
  watchdog không xóa active circuit và restart giữ nhất quán circuit + queue
  hibernation.

## 10. Kết quả kiểm thử và hygiene

- Tại audit lịch sử: backend **137/137 pass**. Con số này chỉ xác nhận behavior của
  mốc code trước P011/P013.
- Audit tương thích ngày 25-07-2026: **38/38 test trọng tâm** và **185/185 full
  backend pass** với test env cô lập; không gọi Gemini/MongoDB/R2 production.
- Lần chạy không cô lập `.env` có thể fail ngay khi import do eligible/group
  production lấn test defaults. Đây là lỗ hổng tái lập test harness, không phải
  regression P013.
- `npm audit --omit=dev`: 1 cảnh báo low severity gián tiếp ở `body-parser`, có bản sửa. Đây không phải nguyên nhân chậm nhưng nên cập nhật dependency trong đợt bảo trì.
- Working tree trước audit đã có thay đổi ở `AGENTS.md`; audit không đụng vào thay đổi đó.

## 11. Các câu hỏi lịch sử và trạng thái quyết định

| Câu hỏi audit gốc | Trạng thái hiện hành |
| --- | --- |
| 50 key thuộc bao nhiêu project/tier? | P013 xác nhận 50 project độc lập, Free Tier; capacity không đồng đều và chỉ 4–5 project đại diện từng được kiểm thủ công |
| Ưu tiên thời gian một file hay throughput batch? | P011 hiện khóa mục tiêu reliability + throughput batch ≥5×; chưa có baseline tương đương để nghiệm thu |
| Fast/Clinical hay một quality mode? | P011 giữ pipeline quality hiện hành cho mọi job trong phạm vi; chưa phê duyệt Fast profile |
| SLO file điển hình? | Chưa chốt; không được thay bằng pages/hour snapshot không cùng workload |
| Reviewer model mạnh hơn/ít call hơn? | Chưa phê duyệt và nằm ngoài P011/P013 |

Pha 0 an toàn đã được P011/P013 hoàn thành. Capacity rollout hiện chỉ được phép theo
gate hậu P013 trong `project-011.md`; không dùng các câu hỏi còn mở để trì hoãn safety
fix, và cũng không dùng chúng để suy diễn mục tiêu ≥5× đã đạt.
