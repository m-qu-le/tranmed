# Project 013 — Kế hoạch sửa lỗi Gemini 429 trên Render

> Ngày bắt đầu: 24-07-2026
> Trạng thái: **HOÀN THÀNH — PRODUCTION ĐÃ PHỤC HỒI**
> Nhánh: `main`
> Production nghiệm thu: commit `0f739b1`
> Ngày đóng: 25-07-2026
> Mục tiêu ưu tiên: dừng retry storm, không mất job/artifact, sau đó mới phục hồi
> throughput có kiểm soát.

## 1. Dữ kiện đã được xác nhận

- Pool có 50 API key duy nhất và mỗi key thuộc một Google project độc lập.
- Quota thật đã được kiểm tra trong Google AI Studio: 500 RPD/project.
- Pool không đồng đều:
  - một số project đã hết 500 RPD;
  - nhiều project mới dùng khoảng 80–90 request trong ngày.
- Hai model đã thử đều hoạt động từ local nhưng probe trên Render trả
  `429 RESOURCE_EXHAUSTED`.
- Probe Render chưa được chạy khi worker hoàn toàn idle.
- Production dùng 50 eligible project, group size 5, rotation bật, worker
  concurrency 3.
- Log gốc có 204 reservation, 200 cooldown 429, 4 success và sử dụng đủ 50 key.
- Backend hiện tại đạt 177/177 test nhưng test chủ yếu dùng mock.

## 2. Nguyên nhân code đã xác định

1. Dispatcher dùng `limiter.maxLimit` thay vì adaptive `limiter.limit`, nên vẫn tạo
   nhiều logical stage khi limiter đã giảm xuống 1.
2. Một logical stage có thể gọi ngay ba project khác nhau sau 429.
3. Khi rotation bật, broker quét tất cả group; global gate chỉ mở sau khi toàn bộ
   pool nội bộ được coi là hết capacity.
4. Request đã xếp trong limiter có thể đi qua một global gate được mở sau thời điểm
   nó bắt đầu chờ.
5. Fallback cooldown là 60 giây cố định, không exponential backoff và gần như không
   có jitter, tạo sóng retry đồng bộ.
6. Nhánh quota deferral return trước bộ đếm hibernation, nên circuit breaker không
   chạy cho lỗi 429.
7. Maintenance pause chỉ dừng claim job mới, không ngăn active job bắt đầu stage
   Gemini tiếp theo.
8. Bộ đếm nội bộ không thể phân biệt chắc chắn:
   - project đã hết RPD thật;
   - RPM/TPM tạm thời;
   - enforcement chung theo nguồn/account;
   - project còn quota nhưng bị 429 tạm thời.

## 3. Bất biến an toàn

- Không xóa job, chunk, source R2 hoặc artifact đã persist.
- Không abort active job theo đường `CANCELLED`, vì policy hiện tại có thể cleanup
  và xóa job.
- Không thay prompt, quality guard, pipeline version, chunk size hoặc số vòng repair.
- Không log API key, project ID, PDF, prompt hoặc nội dung dịch.
- Không gọi Gemini thật trong unit/full test.
- Mọi thay đổi scheduler phải có test tái hiện 429 storm trước khi sửa.
- Deploy production chỉ sau maintenance drain thật sự đạt:
  `activeStages=0`, `waitingStages=0`, `inFlightRequests=0`.

## 4. Phạm vi triển khai

### P013-G0 — Baseline và test tái hiện

- [x] Đọc hồ sơ, code, log gốc và lịch sử commit.
- [x] Chạy full backend test: 177/177 pass.
- [x] Mô phỏng bằng scheduler thật:
  30 logical stage → 50 physical 429 → 50 project cooldown trong 695 ms dù
  limiter bằng 1.
- [x] Thêm regression test cho burst 429 nhiều logical stage.
- [x] Thêm test request đã chờ limiter không được vượt global gate mới mở.
- [x] Thêm test dispatcher dùng current adaptive limit.
- [x] Thêm test maintenance drain không đi qua nhánh `CANCELLED`/xóa artifact.

Gate G0:

- Test mới phải fail trên code cũ vì đúng nguyên nhân production.
- Không dùng network, Mongo production hoặc secret.

### P013-G1 — Containment tại dispatcher và maintenance

- [x] Đổi dispatcher width từ `maxLimit` sang `limit`.
- [x] Khi maintenance pause:
  - không claim job mới;
  - active request đang chạy được phép hoàn tất;
  - active job không được bắt đầu Gemini stage tiếp theo;
  - job được persist về `pending/schedulerSuspended`, không bị xóa;
  - status phải phản ánh đang drain hay đã drained.
- [x] Resume phải đánh thức lại đúng job đã defer, không tăng attempt/retry giả.

Gate G1:

- Với adaptive limit 1 và 3 active job, tối đa một physical request chạy.
- Sau pause, physical-attempt counter không tăng sau khi request đang chạy cuối cùng
  đã hoàn tất.
- Không mất job/chunk/artifact.

### P013-G2 — Global 429 circuit breaker

- [x] Ghi nhận 429 theo cửa sổ thời gian và số project khác nhau.
- [x] Mở global circuit sớm khi nhiều project độc lập cùng 429 trong burst, thay vì
  chờ quét đủ 50 project.
- [x] Re-check global gate bên trong limiter permit, ngay trước reservation/API call.
- [x] Backoff toàn cục theo cấp:
  - lần đầu: khoảng 60 giây;
  - tiếp theo: 2, 4, 8 phút;
  - trần: 10 phút;
  - có jitter giới hạn để tránh đồng bộ.
- [x] Success ổn định mới giảm/reset cấp backoff; một success xen kẽ không được xóa
  ngay tín hiệu của một burst 429 lớn.
- [x] Expose telemetry an toàn:
  `circuitState`, `backoffLevel`, `recent429Projects`, `nextAvailableAt`,
  `circuitOpenCount`.

Giá trị khởi tạo đề xuất:

- rolling window: 10 giây;
- ngưỡng mở circuit: 5 project khác nhau;
- base delay: 60 giây;
- max delay: 10 phút;
- success cần để reset: 10 physical success liên tiếp.

Các giá trị phải được cô lập trong scheduler constructor để test deterministic trước
khi quyết định có expose thành biến môi trường hay không.

Gate G2:

- Mô phỏng 30 logical stage/50 project/100% 429 không được quét hết 50 project.
- Sau khi circuit mở, physical attempt mới bằng 0 cho tới `nextAvailableAt`.
- Amplification của burst test phải giảm rõ rệt và có upper bound xác định.

### P013-G3 — Project cooldown thích nghi

- [x] Theo dõi consecutive 429 riêng từng project.
- [x] Cooldown project tăng dần khi không có `Retry-After`, thay vì luôn 60 giây.
- [x] Success reset consecutive project failures.
- [x] Không tự đánh dấu project là RPD-exhausted chỉ từ generic 429.
- [x] Khi project đã đạt 500 RPD theo counter đáng tin cậy, defer tới Pacific reset.
- [x] Giữ phân biệt telemetry `normalRpd/retryRpd`; admission dùng tổng RPD.

Gate G3:

- Project trả 429 lặp lại không bị gọi đúng mỗi 60 giây vô hạn.
- Project còn quota vẫn có thể phục hồi sau cooldown.
- Không disable vĩnh viễn project chỉ vì 429.

### P013-G4 — Sửa quota deferral và hibernation

- [x] Đưa `poolExhausted` quota deferral qua policy circuit/hibernation mới.
- [x] Bỏ dead branch hoặc cập nhật semantics của
  `consecutivePoolExhaustions/POOL_EXHAUSTION_HIBERNATION_THRESHOLD`.
- [x] Không tạo hai cơ chế gate độc lập mâu thuẫn nhau.
- [x] Cập nhật test cũ đang assert “10 lần exhaustion vẫn không hibernate”.

Gate G4:

- Queue không tự thức dậy liên tục khi global circuit còn đóng.
- Wake-up dùng một deadline authoritative.
- Restart hydrate đúng cooldown/gate cần persist; không tạo burst sau deploy.

### P013-G5 — Metrics và kiểm thử cô lập production

- [x] Bổ sung trạng thái maintenance drain và circuit vào `/status`/`metrics`.
- [x] Không cần ghi outbound IP sau khi workload production thực tế chạy thành
  công; chỉ thực hiện bước này nếu 429 theo nguồn tái xuất hiện.
- [x] Quy trình A/B đã được chuẩn bị nhưng không chạy vì production workload thật
  đã phục hồi với 0/225 response 429:
  1. hard drain worker;
  2. chờ mọi cooldown/gate hết;
  3. một probe Render;
  4. một probe local đồng thời bằng cùng key/model/payload;
  5. tối đa số request đã định trước.
- [x] Không probe project đã đạt 500 RPD.

Gate G5:

- Nếu Render idle vẫn 429 trong khi local đồng thời success, ưu tiên kiểm tra
  source/account enforcement hoặc Render shared outbound IP.
- Nếu cả hai cùng 429, ưu tiên quota/project/model.
- Nếu cả hai success, lỗi chính là workload/retry storm production.

## 5. Thứ tự triển khai code

1. Test dispatcher current limit.
2. Sửa dispatcher.
3. Test gate re-check và burst 429.
4. Thêm global circuit breaker.
5. Test maintenance drain.
6. Sửa maintenance stage admission/defer an toàn.
7. Hợp nhất quota deferral/hibernation.
8. Thêm adaptive per-project cooldown.
9. Cập nhật metrics/status/docs.
10. Targeted test → full backend test → diff review.

Không gộp toàn bộ thành một thay đổi lớn nếu một phase có thể được kiểm chứng và
rollback độc lập.

## 6. Test matrix

| Nhóm | Trường hợp bắt buộc |
|---|---|
| Dispatcher | width theo `limit`; giảm 5→1 có hiệu lực ở batch kế tiếp |
| Burst | 5 project 429 trong 10 giây mở circuit |
| Gate | task đã chờ permit re-check gate trước reserve |
| Backoff | 60s→2m→4m→8m→10m, jitter deterministic trong test |
| Recovery | 10 success liên tiếp reset backoff |
| Mixed pool | project hết RPD không làm quét project còn lại vô hạn |
| Maintenance | stage đang chạy hoàn tất; stage kế tiếp defer; job không bị xóa |
| Restart | hydrate state không tạo cold-start request burst |
| Security | status không lộ key/project ID/error payload nhạy cảm |
| Regression | toàn bộ backend tests pass |

## 7. Rollback

Rollback code:

- Revert riêng commit containment/circuit nếu test production phát hiện deadlock hoặc
  mất tiến độ.
- Không xóa Mongo quota/scheduler state.
- Không rollback migration bằng thao tác destructive.

Rollback cấu hình vận hành:

```env
GEMINI_ELIGIBLE_PROJECT_LIMIT=5
GEMINI_PROJECT_GROUP_ROTATION_ENABLED=false
GEMINI_INITIAL_CONCURRENCY=1
GEMINI_MAX_CONCURRENCY=1
TRANSLATION_WORKER_CONCURRENCY=1
```

Đây là chế độ an toàn tạm thời, không phải nghiệm thu throughput.

## 8. Điều kiện deploy

- Targeted regression tests pass.
- Full backend test pass.
- `git diff --check` pass.
- Diff không chứa secret.
- Maintenance drain đạt 0 active/waiting/in-flight Gemini stage.
- Có snapshot metrics trước deploy.
- Có đường rollback commit/config rõ ràng.

## 9. Điều kiện đóng Project 013

- Không còn chu kỳ quét 50 project mỗi khoảng 60 giây.
- 429 burst mở circuit sớm và không tiếp tục physical attempt trong thời gian gate.
- Maintenance tạo được Render idle probe hợp lệ.
- Physical/logical amplification ổn định ≤1,15.
- 429 sau warm-up <1% hoặc SLO khác được owner chấp thuận bằng dữ liệu.
- Không mất/duplicate stage, job hoặc artifact.
- Có kết luận upstream dựa trên A/B đồng thời, không suy diễn từ probe khác thời điểm.

## 10. Nhật ký thực hiện

### 24-07-2026 — Khởi tạo

- Xác nhận mapping 50 key/project và quota thật 500 RPD từ owner.
- Xác nhận pool có cả project hết RPD và project mới dùng 80–90 request.
- Full backend test: 177/177 pass.
- Không gọi thêm Gemini thật.

### 24-07-2026 — Containment và circuit breaker

- Dispatcher dùng adaptive `limit` hiện tại thay vì `maxLimit`.
- Maintenance pause suspend active job tại ranh giới stage; không abort qua
  `CANCELLED`.
- Circuit mở khi 5 project độc lập trả 429 trong cửa sổ 10 giây.
- Gate được kiểm tra lại sau khi limiter cấp permit và trước reservation/API call.
- Global backoff 60 giây → 2 → 4 → 8 → tối đa 10 phút, có jitter giới hạn.
- Cần 10 physical success liên tiếp mới reset cấp backoff.
- Generic 429 dùng cooldown project tăng dần; `Retry-After` của provider vẫn được
  ưu tiên.
- Persist project cooldown streak và global circuit để Render restart không tạo
  cold-start burst.
- Quota `poolExhausted` hibernate queue ngay theo deadline của circuit; không áp
  dụng hibernation này cho `STAGE_DEFERRED` nội bộ.
- Regression mô phỏng 30 logical stage, limiter 1, 100% 429: tối đa 6 physical
  attempt thay vì 50.
- Full backend test bàn giao: 185/185 pass.
- `git diff --check` pass trên toàn bộ file thuộc Project 013; không phát hiện
  secret mới trong diff.

### 24-07-2026 — Deploy production và nghiệm thu ban đầu

- Commit code cô lập: `0f739b1` (`Stop Gemini 429 retry storms`).
- Push `main` thành công; Render khởi động instance mới tại
  `2026-07-24T14:23:41.769Z`.
- Snapshot instance cũ ngay trước deploy:
  - 1.055 physical attempt;
  - 801 response 429;
  - amplification tích lũy 1,972;
  - maintenance cũ đã pause nhận job mới nhưng không hard-drain được stage.
- Endpoint production mới xác nhận có `maintenanceState` và
  `rateLimitCircuit`, chứng minh code mới đang chạy.
- Cửa sổ hậu deploy tại `2026-07-24T14:28Z`:
  - 85 logical request/issued;
  - 85 physical attempt;
  - 0 response 429;
  - amplification 1,000;
  - circuit `closed`, `openCount=0`, `backoffLevel=0`;
  - 16 chunk terminal, 29 trang hoàn tất và tiếp tục tăng;
  - 37 job completed, 0 job failed;
  - 113/113 source cloud ở trạng thái safe.
- Kết luận tại thời điểm nghiệm thu:
  - production Render đang gọi Gemini thành công ổn định;
  - không có bằng chứng IP Render đang bị block;
  - không chạy thêm diagnostic probe/A-B vì workload production thực tế đã cung
    cấp bằng chứng mạnh hơn mà không tiêu thêm request chẩn đoán.
- Còn theo dõi một processing lease nhiều hơn số active worker ngay sau restart;
  lease này đã tự recover ở snapshot kế tiếp: processing từ 4 về 3, khớp 3 active
  worker.

### 24-07-2026 — Live maintenance và cửa sổ nghiệm thu cuối

- Maintenance pause trên code mới:
  - trạng thái chuyển `draining` → `drained`;
  - `activeJobs=0`, `activeStages=0`, `waitingStages=0`;
  - MongoDB `processing=0`, `failed=0`;
  - job chưa hoàn tất trở về `pending`, không bị xóa.
- Maintenance cancel:
  - trạng thái trở lại `running`;
  - worker nhận lại 3 job;
  - physical/logical counter tiếp tục tăng bình thường.
- Snapshot cuối lúc `2026-07-24T14:36:20Z`:
  - readiness `ready`;
  - 225 logical-issued;
  - 226 physical attempt;
  - amplification 1,0044;
  - 0 response 429;
  - rate-limit circuit `closed`, `openCount=0`, `backoffLevel=0`;
  - quota gate mở bình thường;
  - 45 chunk terminal, 83 trang hoàn tất;
  - 45 job completed, 65 pending, 3 processing, 0 failed.
- Đạt gate rollout ≥200 logical-issued, ≥20 terminal chunk,
  physical/logical ≤1,15 và 429 <1%.
- Kết luận cuối:
  - lỗi production đã được sửa và hệ thống hoạt động bình thường;
  - không có bằng chứng IP outbound của Render bị block;
  - nguyên nhân vận hành phù hợp nhất là burst 429 tạm thời bị scheduler cũ khuếch
    đại thành retry storm; bản vá chặn amplification và bảo toàn queue khi tái phát.
