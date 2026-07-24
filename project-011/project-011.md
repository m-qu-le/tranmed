# PROJECT 011 — Loại bỏ quota dead-time và tận dụng 50 Gemini project

| Thuộc tính | Giá trị |
| --- | --- |
| Mã dự án | `P011` |
| Ngày mở | 24-07-2026 |
| Ngày mở lại | 24-07-2026 |
| Trạng thái | **ĐANG MỞ — P013 là safety authority; gate hậu P013 cho phép đúng một canary 5 → 6, chờ owner triển khai; NO-GO cho 7–10 hoặc đóng P011** |
| Nhánh | `main` |
| Commit nền P011 | `ab15301` — `Fix Gemini quota dead-time and add group dispatcher` |
| Production code baseline đã xác minh | `0f739b1` — `Stop Gemini 429 retry storms` |
| Production backend | `https://tranmed.onrender.com` |
| Execution version | `project-pool-v2` — không đủ để phân biệt code trước/sau P013; mọi evidence phải kèm commit và instance start time |
| Mục tiêu | Khi maintenance chạy bình thường và P013 circuit đóng, không để backlog idle quá 2 phút nếu broker còn capacity admissible; khi circuit mở, không issue trước `nextAvailableAt` và tự thức trong 30 giây sau deadline; tăng throughput tối thiểu 5× mà không hạ quality |
| Báo cáo phân tích đầu vào | `project-011-input-audit.md` |
| Báo cáo tương thích P013 | `project-011-p013-compatibility-report.md` |
| Runbook | `../med-translator-backend/PROJECT_POOL_ROLLOUT.md` |
| Handoff ngắn | `project-011-handoff.md` |
| Vị trí khi đang mở | `project-011/project-011.md` |
| Vị trí sau khi đóng | `archive/project-011/project-011.md` |

> P011 từng được đóng ngày 24-07-2026 sau khi scheduler đạt gate volume/reliability và
> P012 xử lý MongoDB liên vùng. Cùng ngày, P011 được mở lại vì kiểm tra production hậu
> P012 cho thấy Mongo gate đã đạt nhưng 429/amplification chưa đủ an toàn. P013 sau đó
> xác nhận scheduler P011 khuếch đại một burst 429 thành retry storm và triển khai
> containment tại `0f739b1`. Cửa sổ hậu P013 tại §11 đạt gate để thử đúng một canary
> `5 → 6`; lần đóng trước vẫn chỉ là mốc lịch sử và không chứng minh capacity rollout
> hoặc mục tiêu throughput đã hoàn tất.
>
> Dữ liệu trước P012 vẫn không có baseline workload tương đương để chứng minh trung thực
> mức tăng throughput ≥5×.
>
> `../project 006.md` vẫn là kế hoạch hardening lịch sử chưa được đóng bằng hồ sơ riêng;
> P011 không tự động hoàn tất, thay thế hoặc archive P006 ngoài phạm vi scheduler.

## 1. Bất biến đã khóa

- Giữ chunk PDF 2 trang.
- Giữ `ThinkingLevel.HIGH` ở mọi quality stage.
- Giữ thứ tự `translate → audit → revise → verify → repair/reverify`.
- Tối đa hai vòng repair và giữ nguyên content/terminal failure policy.
- Priority folder `Ưu tiên` tuyệt đối; retry đến hạn chỉ ưu tiên trong cùng boundary.
- Job cũ resume từ stage/artifact đã persist; không dịch lại stage đã hoàn tất.
- Không thêm Redis hoặc worker service; chỉ dùng Render, MongoDB và R2 hiện có.
- P013 rate-limit circuit là safety authority: P011 không được force-clear circuit,
  tăng pool hoặc tăng concurrency để thăm dò generic `429`.
- Generic `429` không đủ để kết luận project hết RPD hoặc outbound IP Render bị block.
- `GEMINI_DIAGNOSTIC_PROBE_ENABLED=false` trong mọi baseline/canary P011; probe chạy
  ngoài quota broker nên có thể làm sai lệch bằng chứng.
- Chỉ tuyên bố không regression theo corpus tự động, không tuyên bố đã được chuyên
  gia lâm sàng xác nhận.

## 2. Nguyên nhân P011 và lỗi kế tiếp được P013 xác nhận

Scheduler cũ tách RPD thành `450 normal + 50 retry` và coi retry vượt 50 là cạn quota
dù tổng request của project còn dưới 500. Khi working set 5 project bị đánh dấu hết
capacity, global gate ngủ đến mốc reset quota và không khai thác 45 project còn lại.
Attempt scheduler chưa phát request vẫn có thể làm tăng counter stage, khiến thời gian
chết và retry amplification khó quan sát chính xác.

P011 đã sửa dead-time và đưa toàn bộ 50 project vào broker, nhưng P013 xác nhận phần
dispatcher mới vẫn dùng `limiter.maxLimit` thay vì adaptive `limiter.limit`. Nhiều
logical stage vì vậy tiếp tục lần lượt thử project khác nhau khi limiter đã giảm về 1.
Global gate lại chỉ đóng khi counter nội bộ coi pool đã hết, nên một burst generic
`429` trên nhiều project có thể bị khuếch đại thành retry storm.

Counter nội bộ chỉ biểu diễn configured/admissible capacity, không phải bằng chứng
upstream chắc chắn chấp nhận request. P013 không xác định được quota dimension chính
xác và không có bằng chứng production cuối cùng cho thấy outbound IP Render bị block.

## 3. Phạm vi triển khai và authority hiện hành

### 3.1. Nền P011 tại commit `ab15301`

- Normal/retry dùng chung tối đa 500 RPD/project; hai counter riêng chỉ để quan sát.
- Broker quản lý project theo RPM/TPM/RPD, cooldown, disabled state và tối đa hai
  in-flight/project; không persist hoặc trả secret/project ID công khai.
- 50 project chia nhóm cố định 5 project; cursor nhóm persist trong MongoDB.
- Thứ tự cấp request:
  `dispatcher admission → limiter permit → quota reservation → Gemini → quota release`.
- Mỗi logical stage tối đa ba physical attempt; pool exhaustion trước issue không tăng
  stage attempt/retry/quota.
- Global dispatcher chỉ chạy một stage/chunk/lượt rồi persist và trả stage kế tiếp về
  queue; source cache được giải phóng nếu chờ quá 60 giây.
- Watchdog P011 30 giây phát hiện backlog idle; sau 2 phút có thể rebuild queue, xoay
  nhóm và xóa stale quota gate nếu còn capacity. Sau P013, quyền xóa này chỉ áp dụng
  gate stale thông thường, tuyệt đối không áp dụng active rate-limit circuit.
- Limiter khởi động 5, chỉ tăng từng slot sau gate resource/Mongo và tối đa 10 cho P011.
- Migration additive/idempotent cho scheduler/chunk/job và migration requeue có mục
  tiêu cho job `pending/GEMINI_RATE_LIMIT`.
- `/status`, `/metrics`, `/gemini-keys/status` và frontend được bổ sung trạng thái
  group, ready/deferred depth, blocked reason, watchdog và countdown.

### 3.2. Containment P013 tại commit `0f739b1`

- Dispatcher width theo adaptive `limiter.limit`, không theo `maxLimit`.
- Năm project độc lập trả `429` trong 10 giây mở global rate-limit circuit.
- Stage re-check circuit sau limiter permit và trước reservation/API call.
- Circuit backoff tăng theo cấp từ khoảng 60 giây tới tối đa 10 phút cộng jitter;
  cần 10 physical success liên tiếp để reset cấp.
- Generic `429` dùng cooldown tăng dần riêng project; không tự được coi là RPD
  exhausted.
- Consecutive project rate-limit và global circuit được persist qua restart.
- Quota deferral hibernate queue theo cùng deadline; watchdog không được xóa active
  rate-limit circuit chỉ vì counter nội bộ báo còn capacity.
- Maintenance cho request đang chạy hoàn tất, suspend job ở ranh giới stage, persist
  về pending và không đi qua cleanup `CANCELLED`.

Schema P013 additive và giữ `project-pool-v2` để resume tương thích. Vì execution
version không đổi, P011 phải dùng Git commit + instance start time làm ranh giới bằng
chứng.

## 4. Bằng chứng cục bộ

| Mã | Kết quả | Phạm vi |
| --- | --- | --- |
| `P011-E001` | Backend `167/167` test pass | Unit/integration local |
| `P011-E002` | Frontend `31/31` test pass; lint/build pass | Component/build local |
| `P011-E003` | Project-pool migration apply thành công | 286 job; bổ sung metadata scheduler cho 2.189/2.227 chunk hiện có |
| `P011-E004` | Quota dead-time migration apply thành công và idempotent | Requeue 34 job, clear timer 197 chunk; dry-run sau apply trả `0/0` |
| `P011-E005` | Commit `ab15301` đã có trên `origin/main` và được Render deploy | Production trả execution telemetry `project-pool-v2` |
| `P011-E006` | Backup production trước migration | 286 job, 2.227 chunk, 6 upload batch và 1 system row |
| `P011-E007` | Canary đầu phase 2 | 25/25 logical-issued/physical, amplification `1,00`, 0 phản hồi 429, tự xoay nhóm 1 → 2 |
| `P011-E008` | Audit production hậu P012 lúc 16:56–16:58 ICT | Mongo gate đạt; amplification/429 gate chưa đạt, chi tiết tại §10 |
| `P011-E009` | Backend test suite hiện hành pass ngày 24-07-2026 | 63 subtest được in trong TAP; không gọi Mongo/R2/Gemini production |
| `P011-E010` | Re-check production hậu warm-up lúc 01:13 ICT, 25-07-2026 | Gate capacity đạt để canary `GEMINI_MAX_CONCURRENCY` từ 5 lên 6, chi tiết tại §11 |
| `P011-E011` | P013 production hậu fix `0f739b1` | 225 logical-issued/226 physical, 0 phản hồi 429, amplification `1,0044`, 45 chunk terminal, maintenance drain/resume không mất job |
| `P011-E012` | Audit tương thích P011–P013 ngày 25-07-2026 | 38/38 test trọng tâm và 185/185 full backend pass với test env cô lập; chi tiết tại `project-011-p013-compatibility-report.md` |

Backup nằm tại `backups/`. Không ghi Mongo URI, API key, project
ID, PDF hoặc nội dung dịch vào hồ sơ này.

## 5. Trạng thái rollout hiện tại

- [x] Code, test, migration và runbook đã hoàn thành cục bộ.
- [x] Commit cục bộ `ab15301` đã được tạo.
- [x] Push `ab15301` lên `origin/main` và deploy production.
- [x] Pause production; xác nhận các job còn lại không có Gemini stage/request in-flight.
- [x] Backup production theo quy trình vận hành.
- [x] Apply additive project-pool migration.
- [x] Deploy phase 1 với 5 project, rotation tắt, concurrency tối đa 5.
- [x] Apply targeted quota-dead-time requeue và xác nhận idempotent.
- [x] Bật phase 2: 50 eligible project, 10 nhóm, rotation bật, concurrency tối đa 5.
- [x] Canary ban đầu: scheduler tự xoay nhóm 1 → 2; 25 request, 0 lỗi 429,
  amplification `1,00`, quota gate mở và backlog tiếp tục chạy.
- [x] Theo dõi vượt gate: 5.685 logical-issued, 5.953 physical attempt và 1.290 chunk
  terminal; amplification khoảng `1,047`.
- [x] P012 cutover MongoDB sang N. Virginia và Mongo gate production hậu cutover đạt.
- [x] P013 deploy `0f739b1`, chặn retry storm và safe-drain maintenance; không thay
  quality pipeline hoặc artifact.
- [x] Mở lại P011 để tiếp tục capacity rollout bằng số liệu hậu P012.
- [x] Thu thập cửa sổ hậu warm-up mới sau restart; Mongo/resource/quota gate đạt.
- [x] Đối chiếu P011–P013 và khóa P013 làm safety authority cho mọi bước tiếp theo.
- [x] Đủ điều kiện triển khai canary tăng từng nấc `5 → 6`.
- [ ] Owner đổi `GEMINI_MAX_CONCURRENCY=6` và redeploy; giữ
  `GEMINI_INITIAL_CONCURRENCY=5`, eligible 50, group size 5 và rotation bật.
- [ ] Theo dõi post-deploy canary trước khi cân nhắc nấc 7; không nhảy lên 10.
- [ ] Không tuyên bố throughput production ≥5×: không có baseline workload tương
  đương để đối chiếu.

Mốc lịch sử trước containment P013 ghi nhận khoảng 2.577 trang, throughput quan sát
khoảng 182 trang/giờ và 60 phản hồi 429. Không dùng mốc này làm baseline 5×. P012 đưa
MongoDB về US East, làm Mongo p95 giảm từ khoảng 598–757 ms xuống 31 ms trên canary và
loại bỏ nút thắt hạ tầng mà P011 không giải quyết. P013 sau đó sửa retry amplification;
cửa sổ hậu P013 dùng cho quyết định hiện hành nằm tại §11.

Trong cửa sổ migration, `worker.activeJobs=3` không giảm về 0 vì quota gate đã đóng,
nhưng telemetry xác nhận `activeStages=0` và `inFlightRequests=0`. Sau backup và
migration additive, Render được redeploy; lease/job được phục hồi và ba worker lane
tiếp tục xử lý trên nhóm 2.

## 6. Cấu hình rollout

### Phase 1 — bắt buộc trước khi bật đủ 50 project

```env
GEMINI_SCHEDULER_MODE=project_pool
GEMINI_ELIGIBLE_PROJECT_LIMIT=5
GEMINI_PROJECT_GROUP_SIZE=5
GEMINI_PROJECT_GROUP_ROTATION_ENABLED=false
GEMINI_INITIAL_CONCURRENCY=5
GEMINI_MAX_CONCURRENCY=5
```

`GEMINI_API_KEYS` và `GEMINI_PROJECT_IDS` phải có đúng 50 phần tử, ID duy nhất và cùng
thứ tự. `GEMINI_ACTIVE_PROJECT_LIMIT=5` chỉ là alias tương thích; production mới nên
dùng biến eligible rõ ràng.

### Phase 2 — cấu hình production hiện hành

```env
GEMINI_ELIGIBLE_PROJECT_LIMIT=50
GEMINI_PROJECT_GROUP_SIZE=5
GEMINI_PROJECT_GROUP_ROTATION_ENABLED=true
GEMINI_INITIAL_CONCURRENCY=5
GEMINI_MAX_CONCURRENCY=5
GEMINI_DIAGNOSTIC_PROBE_ENABLED=false
```

Không tăng `GEMINI_MAX_CONCURRENCY` lên 10. Cửa sổ hậu P013 tại §11 đã đạt gate để
owner thử đúng một canary max `5 → 6`, với điều kiện live pre-deploy vẫn không có
active work/backlog và circuit đang đóng. P013 circuit không có biến tắt trong rollout
P011 và không được bypass. Sau canary phải đo lại tối thiểu 200 logical-issued/20 chunk
terminal trước mọi quyết định khác.

## 7. Công việc tiếp tục

Thực hiện theo đúng thứ tự; P013 safety có quyền chặn capacity rollout:

1. Xác nhận production đang chạy `0f739b1` hoặc commit mới hơn vẫn giữ đầy đủ
   containment P013. Ghi commit, instance start time và toàn bộ cấu hình capacity.
2. Xác nhận `GEMINI_DIAGNOSTIC_PROBE_ENABLED=false`,
   `maintenanceState=running`, rate-limit circuit `closed`, global gate reason trống
   và không có upload/cleanup backlog bất thường.
3. Chỉ redeploy max `5 → 6` khi không có active job/stage/waiting/in-flight hoặc Job
   MongoDB `processing`; dùng maintenance và chờ `maintenanceState=drained`.
4. Sau redeploy, chụp delta đầu/cuối cùng một instance với tối thiểu 200
   logical-issued và 20 chunk terminal. Gate bắt buộc:
   - physical/logical-issued ≤1,15;
   - 429 <1% physical request sau warm-up hoặc SLO mới được owner chốt; rollback nếu
     429 ≥3% trong 5 phút;
   - Mongo operation p95 <200 ms, quota reserve/release p95 <100 ms;
   - RSS <80%, event-loop p95 <200 ms;
   - không duplicate/mất stage, lỗi persist/lease hoặc backlog idle sai.
5. Nếu circuit mở trong canary, không force-wake/clear gate và không tăng pool hoặc
   concurrency. Coi canary chưa đủ điều kiện tăng tiếp; chờ `nextAvailableAt` và dùng
   telemetry/runbook P013. Generic `429` không được gán thành RPD hay Render IP.
6. Nếu cửa sổ canary đạt, vẫn không tự động nâng lên 7. Nấc mới cần một cửa sổ độc
   lập cùng corpus/pipeline/chunk và quyết định mới của owner.
7. Chỉ nghiệm thu mục tiêu 5× khi có workload baseline tương đương và quality gate
   không regression.
8. Chạy lại `npm run migrate:quota-dead-time:dry` chỉ khi cần kiểm tra migration; kết
   quả đúng sau apply là `jobsToRequeue=0`, `chunksToClear=0`.

## 8. Rollback

### 8.1. Rollback canary thông thường

Nếu canary 6 vi phạm gate nhưng chưa thành retry storm:

```env
GEMINI_INITIAL_CONCURRENCY=5
GEMINI_MAX_CONCURRENCY=5
```

Giữ eligible 50/group size 5/rotation bật. Rollback khi 429 ≥3%/5 phút,
amplification >1,15, RSS ≥80%, event-loop p95 ≥200 ms, duplicate/mất stage, failed
job mới hoặc lỗi persist/lease.

### 8.2. Containment sự cố kiểu P013

Nếu circuit lặp lại, 429 burst hoặc amplification tăng nhanh:

```env
GEMINI_ELIGIBLE_PROJECT_LIMIT=5
GEMINI_PROJECT_GROUP_ROTATION_ENABLED=false
GEMINI_INITIAL_CONCURRENCY=1
GEMINI_MAX_CONCURRENCY=1
TRANSLATION_WORKER_CONCURRENCY=1
GEMINI_DIAGNOSTIC_PROBE_ENABLED=false
```

Đây là chế độ an toàn tạm thời, không phải cấu hình nghiệm thu throughput. Chờ circuit
deadline và maintenance drain trước redeploy. Không force-clear active rate-limit
circuit, không restart liên tục, không xóa scheduler cursor/quota state/circuit state
hoặc rollback additive schema bằng thao tác destructive.

## 9. Đối chiếu điều kiện đóng P011

- Khi `maintenanceState=running`, rate-limit circuit `closed`, queue không hibernate
  có chủ ý và broker có project admissible, backlog không idle quá 2 phút do scheduler.
- Khi circuit mở, không có physical attempt mới trước `nextAvailableAt`; queue tự thức
  trong 30 giây sau deadline nếu không có burst 429 mới.
- RPD-only gate resume trong 30 giây sau Pacific reset khi không có active P013
  circuit, maintenance hoặc cooldown upstream còn hiệu lực.
- Artifact cũ được giữ và stage đã persist không bị dịch lại.
- Physical/logical-issued ≤1,15 khi ổn định.
- Priority chiếm mọi slot cấp mới sau khi request thường đang chạy hoàn tất.
- Production đạt tối thiểu 5× pages/giờ so với baseline hợp lệ.
- Corpus tự động không có PASS→FAIL, critical/major mới hoặc giảm coverage.
- Có test circuit/cooldown cắt ngang Pacific reset, watchdog không xóa active
  rate-limit circuit và restart giữ nhất quán circuit + queue hibernation.
- Mọi evidence ghi commit deploy, instance start time, config và delta cùng instance;
  diagnostic probe tắt.
- Handoff, knowledge base, commit deploy và evidence production được cập nhật trước
  khi chuyển hồ sơ vào archive.

Lần đóng trước đã ghi nhận volume/reliability đạt nhưng không chứng minh được điều kiện
“≥5× pages/giờ”. P011 hiện được mở lại; chỉ chuyển lại vào archive khi toàn bộ điều kiện
trên có bằng chứng hậu P012 **và hậu P013**. Không sử dụng hồ sơ này để tuyên bố đã đạt
con số 5×.

## 10. Nhật ký mở lại ngày 24-07-2026 — mốc lịch sử trước P013

Toàn bộ §10 là evidence trước containment `0f739b1`. Nó giải thích vì sao P013 cần
được mở và không còn là trạng thái quyết định hiện hành. Quyết định hiện hành nằm tại
§11 và luôn chịu safety authority của P013.

### 10.1. Lý do mở lại

Owner yêu cầu đưa P011 ra khỏi lưu trữ sau khi P012 chuyển MongoDB từ Hong Kong tới
N. Virginia gần Render Ohio. Câu hỏi cần trả lời là việc gỡ Mongo latency có đủ để tiếp
tục capacity rollout hay chưa.

Kết luận: **P012 đã gỡ blocker MongoDB, nhưng chưa đủ điều kiện tăng concurrency vì
Gemini rate-limit và retry amplification đang vi phạm gate.**

### 10.2. Bằng chứng production

Thời gian quan sát: 16:56–16:58 ICT ngày 24-07-2026. Metrics là in-memory từ instance
khởi động lúc `2026-07-24T08:32:48.238Z`; không phải time-series bền vững.

| Chỉ số | Gate | Giá trị quan sát | Kết quả |
| --- | --- | --- | --- |
| Readiness Mongo/R2 | available | cả hai available | PASS |
| Mongo operation p95 | <200 ms, ≥200 mẫu | 98 ms / 3.610 mẫu | PASS |
| Quota reserve p95 | <100 ms, ≥100 mẫu | 97 ms / ≥948 mẫu | PASS |
| Quota release p95 | <100 ms, ≥100 mẫu | 95 ms / ≥944 mẫu | PASS |
| RSS | <80% | khoảng 47% | PASS |
| Event-loop p95 | <200 ms | 20 ms | PASS |
| Amplification tích lũy | ≤1,15 khi ổn định | 1,219 | FAIL |
| Cửa sổ rate-limit gần nhất | <1% sau warm-up | 22% trong limiter window | FAIL |

Snapshot vận hành:

- 50 project configured; 36 key `validated`, 14 key `untested`, 0 key disabled.
- Eligible 50, 10 nhóm, group rotation bật; quota gate còn capacity và không bị block.
- 3 active job, 4 active stage; limiter ở 4 với trần production 5.
- 305 trang/155 chunk terminal; gauge khoảng 215 trang/giờ. Đây không phải baseline
  tương đương để chứng minh 5×.

Burst 77 giây giữa hai snapshot:

- logical-issued `782 → 811` (+29);
- physical attempts `948 → 989` (+41);
- 429 `200 → 221` (+21).

Không kết luận rollback chỉ từ cửa sổ chưa đủ 5 phút, nhưng dữ liệu này đủ để **dừng mọi
ý định tăng concurrency** cho tới khi điều tra và gate hậu warm-up đạt.

### 10.3. Quyết định tại thời điểm đó

- P011 ở trạng thái mở và tiếp tục theo dõi production.
- P012 được coi là đã hoàn tất phần gỡ Mongo blocker; không rollback Mongo chỉ vì 429.
- Không đổi cấu hình Render khi batch đang hoạt động.
- Không tăng `GEMINI_MAX_CONCURRENCY` trên 5 ở thời điểm ghi nhận này.
- Bước kế tiếp khi đó là điều tra quota 429. P013 sau đó xác nhận retry amplification,
  triển khai containment và tạo baseline mới dùng tại §11.

## 11. Kiểm tra sẵn sàng nâng canary ngày 25-07-2026

### 11.1. Phạm vi và giới hạn bằng chứng

Kiểm tra read-only tại 01:13 ICT ngày 25-07-2026. Instance Render hiện tại khởi động
lúc `2026-07-24T14:23:41.769Z` (khoảng 3 giờ 50 phút trước khi chụp snapshot). Metrics
là in-memory của instance này; chúng đủ lớn cho gate canary nhưng không thay thế giám
sát hậu deploy mới hoặc baseline chứng minh throughput 5×.

Instance này chạy production code baseline P013 `0f739b1`. Vì
`project-pool-v2` không đổi qua P013, commit và timestamp trên là boundary bắt buộc
để không trộn với evidence trước fix.

### 11.2. Gate đã đạt

| Chỉ số | Gate | Giá trị | Kết quả |
| --- | --- | --- | --- |
| Readiness | MongoDB và R2 available | cả hai `available` | PASS |
| Logical-issued / chunk terminal | ≥200 / ≥20 | 1.446 / 300 | PASS |
| Amplification | ≤1,15 | 1,024 | PASS |
| 429 / physical attempts | <1% sau warm-up | 11 / 1.480 = 0,74% | PASS |
| Limiter rate-limit window | <1% | 0% | PASS |
| Mongo operation p95 | <200 ms | 50 ms / 5.694 mẫu | PASS |
| Quota reserve/release p95 | <100 ms | 51 / 38 ms | PASS |
| RSS / event-loop p95 | <80% / <200 ms | 38% / 21 ms | PASS |
| Terminal/backlog | không failed, không tồn đọng | 113 completed, 0 failed, backlog 0 | PASS |
| Key pool | không disabled/untested | 50 validated, 0 disabled, 0 untested | PASS |

Quan sát bổ sung: limiter đã tự tăng từ 4 lên 5 lúc `2026-07-24T15:44:37.521Z` sau
chuỗi success; quota circuit mở 1 lần và đã recovery 1 lần; 11 phản hồi 429 phân tán,
mỗi project liên quan một lần. Không có active job/stage, maintenance không pause,
quota gate mở và watchdog không recovery.

Không có public metric khẳng định tuyệt đối không có lỗi persist/lease đã tự hồi phục.
Tuy nhiên, không có failed job, không có backlog, không có watchdog recovery và không
có counter lỗi liên quan trong telemetry công khai. Đây là đủ cho canary một nấc, nhưng
phải kiểm Render logs trong cửa sổ sau deploy.

### 11.3. Quyết định và cấu hình được phê duyệt

**GO đã ghi nhận cho canary duy nhất `5 → 6`; NO-GO cho 7–10 hoặc đóng P011.**

GO này chỉ còn hiệu lực nếu live pre-deploy re-check vẫn đạt các điều kiện §7. Nó
không cho phép bypass một circuit mới mở hoặc redeploy khi maintenance chưa drained.

Owner thực hiện trên Render:

```env
GEMINI_INITIAL_CONCURRENCY=5
GEMINI_MAX_CONCURRENCY=6
GEMINI_DIAGNOSTIC_PROBE_ENABLED=false
```

Không đổi trong lần này: `GEMINI_ELIGIBLE_PROJECT_LIMIT=50`,
`GEMINI_PROJECT_GROUP_SIZE=5`, `GEMINI_PROJECT_GROUP_ROTATION_ENABLED=true`, worker
concurrency và source budget. Redeploy chỉ khi status xác nhận vẫn không có active job,
stage, upload hoặc cleanup backlog.

### 11.4. Gate hậu deploy và rollback

Sau redeploy, gọi readiness/status/metrics/key status. Chỉ coi canary 6 pass sau ít
nhất 200 logical-issued và 20 chunk terminal mới, rồi ghi delta đầu/cuối cửa sổ.

Rollback canary ngay về `GEMINI_MAX_CONCURRENCY=5` nếu một trong các điều kiện xảy ra:

- 429 ≥3% trong 5 phút hoặc limiter rate-limit window tăng ≥1% và không tự giảm;
- amplification >1,15;
- Mongo operation p95 ≥200 ms hoặc quota reserve/release p95 ≥100 ms;
- RSS ≥80%, event-loop p95 ≥200 ms;
- duplicate/mất stage, lỗi persist/lease, failed job mới hoặc backlog không giải thích
  được.

Nếu rate-limit circuit mở, không force-clear và không issue diagnostic probe để thử.
Canary không đủ điều kiện tăng tiếp; chờ `nextAvailableAt`. Nếu circuit/429 storm lặp
lại hoặc amplification tăng nhanh, dùng containment concurrency 1 tại §8.2 thay vì
chỉ rollback về 5.

Không nâng lên 7 chỉ vì readiness xanh. Nấc tiếp theo cần một cửa sổ đo mới đạt toàn bộ
gate, cùng corpus/pipeline/chunk để lập baseline throughput hợp lệ.
