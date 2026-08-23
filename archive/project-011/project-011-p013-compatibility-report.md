# Báo cáo tương thích Project 011 với Project 013

| Thuộc tính | Giá trị |
| --- | --- |
| Phạm vi | Đối chiếu P011 với toàn bộ thay đổi P013 từ `ab15301` đến `0f739b1` |
| Ngày đánh giá | 25-07-2026 |
| P011 | Loại bỏ quota dead-time và tận dụng 50 Gemini project |
| P013 | Khắc phục retry storm sau burst Gemini `429` trên Render |
| Commit nền P011 | `ab15301` — `Fix Gemini quota dead-time and add group dispatcher` |
| Commit diagnostic P013 | `5b1dbdf` — `Add protected Gemini diagnostic probe` |
| Commit khắc phục P013 | `0f739b1` — `Stop Gemini 429 retry storms` |
| Kết luận | **TƯƠNG THÍCH CÓ ĐIỀU KIỆN** |

> **ARCHIVE NOTE — 23-08-2026:** P011 đã retired/superseded bởi P015 local-first.
> Kết luận và gate dưới đây là evidence lịch sử; canary `5 → 6` không được thực hiện
> và không tạo một yêu cầu rollout đang hoạt động.
| Quyết định | Giữ P013; tiếp tục mở P011; NO-GO cho 7–10 hoặc đóng dự án |
| Trạng thái remediation | **Đã hoàn thành cập nhật hồ sơ P0 ngày 25-07-2026; canary và bằng chứng đóng dự án vẫn pending** |

## 1. Kết luận điều hành

P013 **không phá vỡ dữ liệu, artifact, quality pipeline hay khả năng resume của
P011**. Bản vá chỉ thêm schema và state scheduler theo hướng additive, giữ chunk hai
trang, `ThinkingLevel.HIGH`, thứ tự quality stage, tối đa hai vòng repair, priority,
stage artifact đã persist và policy terminal hiện có.

P013 còn sửa đúng một lỗi nghiêm trọng nằm trong phần triển khai P011: dispatcher của
P011 lấy `limiter.maxLimit` thay vì adaptive `limiter.limit`. Vì vậy khi limiter đã
giảm xuống 1, dispatcher vẫn tạo nhiều logical stage và nhiều stage cùng lần lượt thử
project khác nhau. Sự kiện P013 chứng minh lỗi này đã khuếch đại một đợt `429` tạm
thời thành retry storm.

Tuy nhiên, P013 làm thay đổi có chủ ý một số semantics vận hành của P011:

- P011 muốn khai thác project khác ngay khi counter nội bộ cho rằng còn capacity.
- P013 dừng toàn bộ issuance sau khi 5 project độc lập cùng trả `429` trong 10 giây,
  kể cả khi các project chưa thử vẫn còn capacity **theo counter nội bộ**.
- P011 đặt tiêu chí backlog không idle quá 2 phút.
- P013 có global backoff từ khoảng 60 giây tới 10 phút, có jitter, và không cho
  watchdog xóa rate-limit circuit còn hiệu lực.

Đây không phải lý do rollback P013. Dữ kiện P013 cho thấy counter nội bộ không phải
nguồn sự thật về upstream capacity: limiter đã về 1, nhiều project còn dưới RPD nội bộ
nhưng production vẫn nhận `429` tới khoảng 90,89% physical attempt. Ép P013 tiếp tục
quét pool để thỏa câu chữ cũ của P011 sẽ tái tạo chính sự cố mà P013 đã sửa.

Kết luận theo từng trục:

| Trục tương thích | Kết quả | Nhận định |
| --- | --- | --- |
| Schema và dữ liệu | PASS | Chỉ thêm field; không xóa/rewrite job, chunk, source hoặc artifact |
| Quality pipeline | PASS | P013 không đổi prompt, stage, chunk size, thinking hoặc repair policy |
| Resume/idempotency | PASS | Maintenance mới persist job về pending và không đi qua cleanup `CANCELLED` |
| Pool 50 project | PASS có điều kiện | Xác nhận 50 key thuộc 50 project độc lập; capacity upstream vẫn không đồng đều và không đọc động |
| Scheduler safety | PASS, được cải thiện | Dispatcher theo adaptive limit; circuit chặn retry storm; gate được re-check trước request |
| Mục tiêu “idle ≤2 phút” | PASS về định nghĩa sau remediation | Chỉ áp dụng khi P013 circuit/maintenance không chủ động chặn issuance; chưa nghiệm thu production |
| Tiêu chí Pacific reset ≤30 giây | PARTIAL | Đúng cho RPD-only gate; chưa đúng tuyệt đối nếu P013 circuit/cooldown còn hiệu lực |
| Rollback P011 | PASS về tài liệu sau remediation | Đã tách canary rollback về 5 và containment P013 ở concurrency 1 |
| Bằng chứng/telemetry | PARTIAL | `project-pool-v2` không đổi dù behavior đổi; probe P013 gọi ngoài scheduler |
| Hồ sơ bàn giao P011 | PASS sau remediation | Handoff đã chuyển baseline sang `0f739b1` và khóa P013 làm safety authority |
| Đóng P011 | NO-GO | Mục tiêu throughput ≥5× vẫn chưa có baseline tương đương |

### 1.1. Ghi nhận remediation ngày 25-07-2026

Sau audit, các thay đổi tài liệu P0 đã được áp dụng:

- `project-011.md` đồng bộ trạng thái với §11, thêm production baseline `0f739b1`,
  sửa mục tiêu idle/reset theo circuit và tách hai profile rollback.
- `project-011-handoff.md` được thay thế bằng handoff hậu P013, khóa diagnostic probe,
  maintenance drain và trình tự canary/containment.
- `project-011-input-audit.md` được gắn nhãn baseline lịch sử, có bảng supersession
  P011/P012/P013 và không còn được dùng như mô tả code hiện hành.
- `../../med-translator-backend/PROJECT_POOL_ROLLOUT.md` được đồng bộ gate hậu P013,
  canary 5 → 6 và hai profile rollback/containment.

Remediation này chỉ sửa hồ sơ/runbook P011. Nó không tự triển khai canary, không thay
code/config production và không làm mục tiêu ≥5× trở thành đã đạt.

## 2. Phạm vi và phương pháp

Đánh giá sử dụng bốn lớp bằng chứng:

1. Hồ sơ đang hoạt động của P011:
   - `project-011.md`;
   - `project-011-handoff.md`;
   - `project-011-input-audit.md`.
2. Hồ sơ sự cố và fix plan đã đóng của P013:
   - `../project-013/project-013.md`;
   - `../project-013/project-013-fix-plan.md`.
3. Diff code:
   - `ab15301..5b1dbdf` cho diagnostic probe;
   - commit `0f739b1` cho containment/circuit/maintenance;
   - `ab15301..0f739b1` cho ảnh hưởng tổng hợp.
4. Kiểm thử local, không gọi Gemini/MongoDB/R2 production.

`git diff ab15301..0f739b1` cho thấy P013 tác động 14 file. Phần diagnostic thêm
endpoint bảo vệ; phần fix chính sửa hai model state, `geminiKeyScheduler.js`,
`queueManager.js` và các test liên quan. Không có file prompt, quality pipeline,
chunking, artifact renderer hoặc source lifecycle nào bị P013 sửa.

Tại thời điểm đánh giá, các file code thuộc commit P013 không có diff chưa commit so
với `HEAD=0f739b1`. Working tree có các thay đổi P012 và tài liệu khác của người dùng;
chúng không được sửa hoặc quy thành P013 trong báo cáo này.

Giới hạn:

- Không re-check live production trong lần đánh giá này.
- Không gọi Gemini thật.
- Không khẳng định quota dimension upstream vì P013 không thu được quota detail.
- Số liệu production dưới đây được giữ đúng theo timestamp và phạm vi mà P013/P011
  đã ghi; không trộn các instance hoặc cửa sổ khác nhau.

## 3. Chuỗi sự kiện phải được tôn trọng

### 3.1 Trước bản vá P013

P013 xác nhận:

- 50 API key thuộc 50 Google project độc lập.
- Pool là Free Tier và capacity không đồng đều: fix plan ghi một số project đã chạm
  500 RPD, trong khi nhiều project mới dùng khoảng 80–90 request.
- Hồ sơ sự cố chính chỉ có kiểm tra thủ công 4–5 project đại diện khoảng 80 request;
  không có phép đọc quota động cho cả 50 project.
- Local chạy được hai model đã thử, trong khi probe từ Render từng trả generic
  `429 RESOURCE_EXHAUSTED`.
- Lỗi upstream không cung cấp quota metric đủ để kết luận là RPM, TPM, RPD, IP,
  anti-abuse, region hay dynamic capacity.
- Limiter đã giảm xuống 1 nhưng request tuần tự vẫn tiếp tục.
- Snapshot cuối trước fix có 243 logical-issued, 582 physical attempt, 529 response
  `429`, amplification `2,3951`, chỉ 19 chunk/37 trang terminal.
- Maintenance cũ chỉ dừng claim mới; active job vẫn bắt đầu stage tiếp theo.

Những dữ kiện này bác bỏ ba suy diễn nguy hiểm:

1. “Counter nội bộ còn dưới 500” không chứng minh request tiếp theo sẽ được upstream
   chấp nhận.
2. Generic `429` không chứng minh project đã hết RPD.
3. Limiter bằng 1 không đồng nghĩa hệ thống đã containment retry storm.

### 3.2 Thay đổi P013

P013 triển khai:

- dispatcher width theo `limiter.limit`, không theo `maxLimit`;
- circuit mở khi 5 project độc lập trả `429` trong 10 giây;
- re-check gate sau limiter permit và trước reservation/API call;
- global backoff tăng theo cấp, có jitter và cần 10 physical success liên tiếp để
  reset cấp;
- cooldown `429` riêng từng project tăng dần khi provider không gửi `Retry-After`;
- persist consecutive project rate-limit và global circuit qua restart;
- quota deferral hibernate queue ngay theo deadline authoritative;
- maintenance cho request đang chạy hoàn tất, sau đó suspend ở ranh giới stage,
  persist job về pending và không cleanup như cancel;
- thêm telemetry `maintenanceState`, gate reason và `rateLimitCircuit`.

P013 không:

- thay prompt hoặc model quality flow;
- thay chunk size;
- hạ thinking level;
- tăng số vòng repair;
- xóa state P011 cũ;
- đánh dấu project RPD-exhausted chỉ từ generic `429`;
- chứng minh outbound IP Render bị block.

### 3.3 Sau bản vá P013

Production trên instance bắt đầu lúc `2026-07-24T14:23:41.769Z` ghi nhận:

- 225 logical-issued;
- 226 physical attempt;
- 0 response `429`;
- amplification `1,0044`;
- 45 chunk terminal;
- 83 trang hoàn tất;
- 45 job completed, 0 failed;
- 113/113 source cloud safe;
- maintenance chuyển `draining → drained`, sau resume nhận lại đúng 3 job.

P011 §11 sau đó dùng chính instance hậu P013 này và ghi:

- 1.446 logical-issued / 1.480 physical;
- amplification `1,024`;
- 11/1.480 response `429` = `0,74%`;
- 300 chunk terminal;
- 113 completed, 0 failed, backlog 0;
- rate-limit circuit từng mở 1 lần và đã recovery 1 lần.

Vì vậy P013 không làm mất hiệu lực cửa sổ P011 §11. Ngược lại, đây là bằng chứng tích
hợp hậu P013 để cho phép cân nhắc **một canary duy nhất 5 → 6**. Nó không phải bằng
chứng để đóng P011 hoặc tuyên bố throughput ≥5×.

## 4. Ảnh hưởng lên các bất biến P011

| Bất biến P011 | P013 có đổi? | Kết luận |
| --- | --- | --- |
| Chunk PDF 2 trang | Không | Giữ nguyên |
| `ThinkingLevel.HIGH` | Không | Giữ nguyên |
| `translate → audit → revise → verify → repair/reverify` | Không | Giữ nguyên |
| Tối đa hai vòng repair | Không | Giữ nguyên |
| Content/terminal failure policy | Không | Giữ nguyên |
| Priority folder tuyệt đối | Không đổi logic priority | Test priority hiện hành vẫn pass |
| Resume từ stage/artifact đã persist | Không phá; maintenance còn an toàn hơn | PASS |
| Không thêm Redis/worker service | Không | Vẫn Render + MongoDB + R2 |
| Không tuyên bố xác nhận lâm sàng | Không | Giữ nguyên |
| Không lộ key/project ID | Không | State mới chỉ lưu stable ID/state; public telemetry aggregate/redacted |

Kết luận: **không có bất biến chất lượng hoặc dữ liệu nào của P011 bị P013 vi phạm**.

## 5. Ảnh hưởng lên giả định và logic scheduler P011

### P011–P013-F01 — “Capacity” không còn được phép đồng nhất với counter nội bộ

Mức độ: **Cao**.

P011 dùng RPM/TPM/RPD, cooldown và group state để quyết định project còn capacity.
P013 chứng minh số liệu nội bộ và AI Studio có định nghĩa/thời điểm khác nhau. Failed
request vẫn tạo reservation/event và có thể tăng daily counter trước khi biết upstream
trả `429`.

Sau P013, cần tách ba khái niệm:

- `configured capacity`: giới hạn app cấu hình;
- `admissible capacity`: broker nội bộ hiện cho phép reserve;
- `observed upstream capacity`: request gần đây thực sự được Gemini chấp nhận.

Mục tiêu P011 chỉ nên dùng “admissible capacity an toàn khi circuit đóng”, không dùng
“counter dưới trần” như bằng chứng đủ.

### P011–P013-F02 — Circuit P013 cố ý ưu tiên safety hơn việc quét đủ 50 project

Mức độ: **Cao**.

P011 muốn group rotation khai thác 45 project còn lại khi working group đầu hết
capacity. Logic đó vẫn đúng với exhaustion được xác định bởi counter RPD/RPM/TPM.

Nhưng với burst generic `429`, P013 dừng sau 5 project độc lập thay vì tiếp tục quét
đủ 50. Đây là thay đổi đúng vì sự kiện production cho thấy nhiều logical stage đã
quét gần hết pool và tạo amplification lớn.

Hệ quả:

- Không được dùng watchdog hoặc `/force-wakeup` để cưỡng bức xóa circuit còn hạn chỉ
  vì `anyCapacity=true`.
- Không được tăng eligible project/concurrency để “thử xem project khác có chạy”.
- Group rotation tiếp tục là capacity mechanism khi circuit đóng; nó không được phép
  vượt safety circuit.

### P011–P013-F03 — Tiêu chí idle ≤2 phút hiện xung đột với P013

Mức độ: **Blocker đối với việc đóng P011**.

P011 hiện ghi:

> Không để backlog idle quá 2 phút khi còn ít nhất một trong 50 project có capacity.

P013 cho phép rate-limit circuit đóng issuance lâu hơn 2 phút. `clearStaleGate()` cũng
chủ động từ chối xóa circuit còn hiệu lực. Do đó tiêu chí nguyên văn có thể đánh dấu
một containment đúng là failure và khuyến khích operator phá circuit.

Tiêu chí thay thế đề xuất:

> Khi `maintenanceState=running`, `rateLimitCircuit.state=closed`, queue không
> hibernate có chủ ý và broker có ít nhất một project admissible, backlog không được
> idle quá 2 phút do scheduler. Khi circuit mở, không được phát physical attempt mới
> trước `nextAvailableAt`; queue phải tự đánh thức trong 30 giây sau deadline, trừ
> khi một burst `429` mới mở circuit kế tiếp.

### P011–P013-F04 — Pacific reset ≤30 giây cần giới hạn phạm vi

Mức độ: **Cao**.

Test hiện hành chứng minh normal/retry dùng chung RPD pool và RPD-only gate mở lại sau
Pacific reset. Nhưng cooldown project và rate-limit circuit P013 được persist độc lập
với quota-day counter. Một circuit mở ngay trước reset có thể còn hạn sau reset.

Tiêu chí đúng nên là:

> RPD-only gate phải resume trong 30 giây sau Pacific reset nếu không có active
> rate-limit circuit, maintenance hoặc cooldown upstream còn hiệu lực. Không được
> cưỡng bức xóa circuit P013 chỉ vì quota-day đã đổi.

Cần thêm test cho trường hợp circuit/cooldown cắt ngang Pacific reset trước khi dùng
tiêu chí này để đóng dự án.

### P011–P013-F05 — Adaptive limiter của P011 trước P013 không thực sự điều khiển dispatcher

Mức độ: **Cao, đã sửa**.

P011 mô tả limiter sẽ giảm/tăng theo resource và rate-limit, nhưng dispatcher lại chọn
batch theo `maxLimit`. P013 sửa dispatcher theo `limit` hiện tại. Đây là correction
phù hợp với ý định P011, không phải thay đổi mục tiêu.

Hệ quả đo throughput:

- Khi limiter giảm, throughput tức thời sau P013 có thể thấp hơn code P011 cũ.
- Phần throughput “mất” này là tải lỗi/retry bị loại bỏ, không phải regression hợp lệ.
- So sánh pages/hour phải kèm amplification và `429`; không được đánh giá chỉ bằng
  số stage được tạo.

### P011–P013-F06 — Semantics maintenance cũ của P011 không còn là chuẩn hiện hành

Mức độ: **Trung bình, đã sửa**.

P013 live test chứng minh maintenance cũ vẫn phát thêm 169 physical attempt và 159
response `429` trong lúc pause. Vì vậy “đã bấm pause” không chứng minh drain.

P011 chỉ được coi là an toàn để redeploy khi đồng thời:

- `maintenanceState=drained`;
- active job/stage/waiting/in-flight bằng 0;
- MongoDB không còn job `processing`;
- snapshot và token kiểm soát không bị log vào hồ sơ.

Bằng chứng migration P011 vẫn hợp lệ vì hồ sơ ghi đã kiểm riêng
`activeStages=0`/`inFlightRequests=0`, không chỉ dựa vào cờ pause.

### P011–P013-F07 — Rollback P011 và containment P013 là hai thao tác khác nhau

Mức độ: **Cao**.

Rollback canary P011 từ max 6 về max 5 là hợp lệ khi chỉ có regression nhỏ trong một
cửa sổ đo.

Nhưng profile P011 hiện ghi eligible 5, rotation false, max 5 chưa đủ làm containment
khi tái diễn sự cố P013-class. P013 quy định chế độ an toàn:

```env
GEMINI_ELIGIBLE_PROJECT_LIMIT=5
GEMINI_PROJECT_GROUP_ROTATION_ENABLED=false
GEMINI_INITIAL_CONCURRENCY=1
GEMINI_MAX_CONCURRENCY=1
TRANSLATION_WORKER_CONCURRENCY=1
```

P011 cần tách rõ:

1. **Canary rollback:** `6 → 5`, không đổi các biến khác nếu circuit chưa storm.
2. **Incident containment:** dùng profile concurrency 1 của P013, chờ circuit và
   maintenance drain; không xóa state/schema.

### P011–P013-F08 — `project-pool-v2` không phân biệt code trước/sau P013

Mức độ: **Trung bình**.

P013 giữ `PROJECT_POOL_EXECUTION_VERSION='project-pool-v2'` để bảo toàn resume và
không reset artifact. Điều này tốt cho tương thích dữ liệu nhưng yếu cho audit:
telemetry cùng execution version có thể đến từ `ab15301`, `5b1dbdf` hoặc `0f739b1`.

Mọi baseline/canary P011 từ nay phải ghi ít nhất:

- Git commit deploy;
- instance start time;
- cấu hình eligible/group/rotation/initial/max/worker;
- đầu và cuối cửa sổ đo;
- circuit open count/backoff/gate reason.

Không gộp counter từ instance trước và sau deploy.

### P011–P013-F09 — Diagnostic probe P013 nằm ngoài quota broker P011

Mức độ: **Trung bình**.

Probe P013 dùng trực tiếp key đầu tiên, không đi qua scheduler/quota broker. Vì vậy
request probe có thể tiêu upstream quota nhưng không tăng logical/physical/RPD metric
của P011. Endpoint được bảo vệ bằng maintenance token, giới hạn 4 request/giờ, cooldown
5 phút và mặc định tắt, nhưng vẫn có thể làm nhiễu baseline nếu bật.

Quy tắc cho mọi cửa sổ P011:

- `GEMINI_DIAGNOSTIC_PROBE_ENABLED=false`;
- không gọi probe trong baseline/canary;
- nếu buộc phải diagnostic, loại cửa sổ đó khỏi bằng chứng throughput/quota;
- sau P013 không chạy probe chỉ để “xem pool có hồi không”; workload thật và circuit
  telemetry được ưu tiên.

### P011–P013-F10 — Nguyên nhân upstream vẫn chưa biết chính xác

Mức độ: **Trung bình**.

P013 xác định chắc chắn lỗi phía ứng dụng là retry amplification. P013 không xác định
chắc chắn nguyên nhân upstream của burst `429`, và bằng chứng cuối không ủng hộ kết
luận outbound IP Render bị block.

P011 không được:

- coi generic `429` là RPD exhausted;
- coi Render IP là nguyên nhân đã chứng minh;
- đổi region, tăng pool hoặc tăng concurrency dựa trên giả thuyết này;
- dùng một local-vs-Render probe khác thời điểm làm causal proof.

## 6. Ảnh hưởng lên mục tiêu throughput ≥5×

P013 không thay đổi mục tiêu ≥5×, nhưng làm rõ vì sao chưa thể nghiệm thu:

- Code P011 cũ có throughput “ảo” do tạo nhiều physical attempt lỗi.
- P013 giảm issuance khi upstream có dấu hiệu bất thường; đây là trade-off đúng giữa
  reliability và tốc độ.
- Group size 5, worker concurrency 3, adaptive limiter, Mongo latency, quality
  pipeline nhiều stage và source budget vẫn là các trần độc lập.
- Nâng max concurrency từ 5 lên 6 chỉ tăng trần API danh nghĩa 20%; nó không tự chứng
  minh cải thiện tổng thể 5×.
- Snapshot pages/hour khác corpus, backlog, stage mix hoặc instance không thể làm
  baseline tương đương.

Do đó:

- Không được lấy số request giảm sau P013 làm throughput regression.
- Không được lấy một pages/hour gauge tích lũy làm bằng chứng 5×.
- P011 chỉ được đóng khi có workload cùng corpus/pipeline/chunk/config và quality gate,
  hoặc owner chính thức sửa mục tiêu sản phẩm. Không được âm thầm đổi tiêu chí vì khó
  đo.

## 7. Tình trạng từng tài liệu P011

### `project-011.md`

Các phần còn đúng:

- bất biến quality;
- shared RPD 500/project;
- group 5/50 project;
- reservation sau limiter;
- hard cap ba physical attempt/logical stage;
- schema/migration additive;
- gate amplification/429/resource;
- §11 là bằng chứng hậu P013 và hỗ trợ canary một nấc.

Các điểm audit trên đã được sửa ngày 25-07-2026:

- trạng thái đầu tài liệu đã đồng bộ với “GO có điều kiện 5 → 6” tại §11;
- bảng ghi riêng commit nền P011 và production baseline `0f739b1`;
- idle/Pacific reset đã giới hạn theo semantics circuit;
- rollback đã tách canary và incident containment;
- diagnostic probe bị khóa tắt trong mọi cửa sổ P011.

### `project-011-handoff.md`

Tại thời điểm audit, tài liệu này không an toàn vì còn trỏ production/main về
`ab15301` và chưa có circuit/maintenance/rollback P013.

Handoff đã được thay thế ngày 25-07-2026. Bản mới:

- trỏ production baseline về `0f739b1`;
- phân biệt commit nền P011 với code baseline hiện hành;
- ghi đầy đủ sự kiện production P013;
- yêu cầu `maintenanceState=drained`;
- tách canary rollback và incident containment concurrency 1;
- giữ NO-GO cho 7–10/đóng P011.

### `project-011-input-audit.md`

Đây là tài liệu lịch sử đầu vào, không phải mô tả code hiện hành:

- phát hiện “một logical stage có thể phát 50 physical request” đã được P011 giới hạn
  còn 3, và P013 tiếp tục chặn burst toàn hệ thống sau 5 project;
- đề xuất reset gate sau một success đã bị P013 thay bằng 10 physical success liên
  tiếp để tránh một success xen kẽ xóa tín hiệu burst;
- mô tả scheduler state chỉ nằm trong RAM không còn đúng cho quota/cooldown/cursor/
  circuit đã persist.

Không nên xóa phát hiện lịch sử. Cần gắn nhãn commit/thời điểm và liên kết tới báo cáo
này để tránh người đọc hiểu nhầm là code hiện hành. Việc gắn nhãn và bảng trạng thái
supersession đã hoàn thành ngày 25-07-2026.

### Runbook và knowledge base

`../../med-translator-backend/PROJECT_POOL_ROLLOUT.md` cùng `.codex/knowledge/backend.md`
và `.codex/knowledge/operations.md` đã phản ánh phần lớn P013:

- dispatcher theo current limit;
- global circuit;
- generic `429` không đồng nghĩa RPD;
- maintenance safe-drain;
- không tăng pool/concurrency để chẩn đoán.

Nguồn vận hành hiện hành này nhất quán với P013 hơn `project-011-handoff.md`.

## 8. Gate P011 đề xuất sau P013

### 8.1 Gate trước canary 5 → 6

- Production commit chứa `0f739b1` hoặc bản kế tiếp giữ đầy đủ containment P013.
- Diagnostic probe tắt.
- `maintenanceState=running`.
- `rateLimitCircuit.state=closed`, global gate reason trống.
- Không có active upload/cleanup backlog bất thường.
- Bắt đầu một cửa sổ metric mới trên cùng instance.
- Tối thiểu 200 logical-issued và 20 chunk terminal.
- Physical/logical-issued ≤1,15.
- `429` <1% physical attempt sau warm-up.
- Mongo p95 <200 ms; quota reserve/release p95 <100 ms.
- RSS <80%; event-loop p95 <200 ms.
- Không có failed job mới, duplicate/mất stage, persist/lease error.

### 8.2 Gate hậu canary

Trong cửa sổ canary:

- nếu circuit mở, coi canary **không đạt để tăng tiếp**, nhưng không cưỡng bức circuit;
- nếu `429 ≥3%` trong 5 phút, rollback canary về max 5;
- nếu retry storm/circuit lặp lại, chuyển sang incident containment concurrency 1;
- đo bằng delta cùng instance, không dùng snapshot tích lũy qua redeploy;
- không nâng lên 7 chỉ vì readiness xanh hoặc limiter đã chạm 6.

### 8.3 Gate đóng P011

Ngoài các gate hiện có, cần:

- tiêu chí idle/reset đã sửa theo semantics circuit;
- test circuit cắt ngang Pacific reset;
- test tích hợp watchdog không xóa active rate-limit circuit;
- test restart với cả persisted circuit và queue hibernation;
- baseline throughput tương đương để chứng minh ≥5× hoặc quyết định sản phẩm chính
  thức thay mục tiêu;
- quality corpus không regression;
- `project-011.md`, handoff, runbook và knowledge base cùng một commit/trạng thái.

## 9. Kết quả kiểm thử độc lập

### 9.1 Test trọng tâm

Đã chạy các test liên quan trực tiếp:

- `projectQuotaBroker.test.js`;
- `workerPool.test.js`;
- `errorPolicy.test.js`;
- `deadTimeWatchdog.test.js`.

Kết quả: **38/38 pass**.

Các behavior đã được xác nhận gồm:

- shared normal/retry RPD và Pacific reset;
- group rotation/cursor;
- reservation sau limiter permit;
- re-check circuit trước issue;
- 5 project `429` mở circuit;
- 30 logical stage/limiter 1 dừng trong tối đa 6 physical `429`;
- exponential backoff và reset sau 10 success;
- per-project cooldown tăng dần;
- circuit sống qua restart;
- dispatcher theo current limit;
- maintenance suspend an toàn;
- quota deferral không làm tăng attempt/retry giả;
- watchdog không mutate queue trong maintenance.

### 9.2 Full backend suite

Full suite với test env được cô lập rõ ràng: **185/185 pass**.

Lần chạy đầu không override đầy đủ biến `GEMINI_ELIGIBLE_PROJECT_LIMIT` và
`GEMINI_PROJECT_GROUP_SIZE`; `.env` cục bộ lấn test defaults, khiến 14 test file fail
ngay khi import vì eligible/group không khớp một test project. Sau khi đặt rõ test
key/project/eligible/group, toàn bộ suite pass.

Đây không phải failure logic P013, nhưng là một lỗ hổng tái lập bằng chứng:
`test/setup-env.js` hiện chỉ điền biến còn thiếu và không cô lập hoàn toàn `.env`.
CI/runbook nên dùng test env rõ ràng hoặc ngăn dotenv production lấn test defaults.

Không test nào trong đánh giá này gọi Gemini, MongoDB hoặc R2 production.

## 10. Hành động bắt buộc theo ưu tiên

### P0 — Trước thay đổi capacity tiếp theo

- [x] Cập nhật `project-011-handoff.md` từ production baseline `ab15301` sang
  `0f739b1` và ghi rõ P013 containment.
- [x] Đồng bộ dòng trạng thái đầu `project-011.md` với §11.
- [x] Sửa tiêu chí idle ≤2 phút và Pacific reset theo §5 của báo cáo này.
- [x] Tách canary rollback với P013 incident containment.
- [x] Khóa diagnostic probe ở trạng thái tắt trong mọi cửa sổ P011.
- [x] Bổ sung quy tắc gắn commit + instance start time vào mọi snapshot mới.

### P1 — Trước khi cân nhắc nấc 7

1. Hoàn tất canary 5 → 6 theo delta cùng instance.
2. Coi mọi circuit open trong canary là lý do dừng tăng tiếp, không phải lý do phá gate.
3. Thêm test circuit qua Pacific reset và watchdog/circuit end-to-end.
4. Sửa test harness để `.env` cục bộ không làm full suite cho kết quả giả.

### P2 — Trước khi đóng P011

1. Tạo baseline throughput tương đương và quality corpus.
2. Chứng minh mục tiêu ≥5× hoặc xin owner quyết định đổi mục tiêu có chủ đích.
3. Cập nhật toàn bộ hồ sơ/handoff/runbook/knowledge về cùng production commit.
4. Chỉ archive P011 khi không còn mâu thuẫn trạng thái và tất cả điều kiện đóng có
   bằng chứng hậu P013.

## 11. Quyết định cuối

- **Không rollback P013.**
- **Không coi P013 là làm hỏng P011 về dữ liệu hoặc quality.**
- **Không tiếp tục dùng nguyên văn mục tiêu idle/capacity cũ của P011.**
- **Không đóng P011.**
- Bằng chứng hậu P013 trong P011 §11 không bị vô hiệu; nó chỉ hỗ trợ một canary
  5 → 6 có kiểm soát, không hỗ trợ nấc 7–10 hoặc tuyên bố ≥5×.
- Remediation hồ sơ P0 đã hoàn tất; trước thao tác capacity tiếp theo vẫn phải re-check
  live pre-deploy theo P011 §7/handoff. Không suy diễn việc sửa tài liệu thành production
  đã được thay cấu hình.

Đánh giá tổng thể: **P013 là bản sửa lỗi cần thiết và tương thích về kiến trúc, nhưng
trở thành một lớp safety authority cao hơn logic tận dụng capacity của P011. P011 chỉ
tiếp tục an toàn khi mục tiêu throughput chịu sự ràng buộc của circuit P013, thay vì
cố vượt circuit để giữ câu chữ “không idle quá 2 phút”.**
