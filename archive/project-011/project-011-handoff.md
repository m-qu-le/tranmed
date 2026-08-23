# Bàn giao lịch sử — Project 011

**Cập nhật:** 25-07-2026

> **ARCHIVE NOTE — 23-08-2026:** P011 đã retired/superseded bởi P015 local-first.
> Canary `5 → 6` không được thực hiện và không có bằng chứng throughput 5×. Nội dung
> bên dưới là handoff lịch sử, không phải runbook để rollout cấu hình cloud.

## Điểm tiếp tục chính xác

- Branch: `main`.
- Commit nền P011: `ab15301` — `Fix Gemini quota dead-time and add group dispatcher`.
- Production code baseline đã xác minh: `0f739b1` —
  `Stop Gemini 429 retry storms`.
- `HEAD`, `main` và `origin/main` cùng trỏ tới `0f739b1` tại lần audit tương thích
  ngày 25-07-2026.
- Backend production: `https://tranmed.onrender.com`.
- Execution version: `project-pool-v2`.
- Execution version không đổi qua P013; mọi snapshot phải ghi thêm Git commit và
  instance start time.
- Hồ sơ đầy đủ: `project-011.md`.
- Báo cáo tương thích bắt buộc đọc:
  `project-011-p013-compatibility-report.md`.
- Runbook lịch sử: `../../med-translator-backend/PROJECT_POOL_ROLLOUT.md`.

Không dùng `project-011-input-audit.md` như mô tả code hiện hành. Đó là baseline lịch
sử trước P011/P013.

## Authority P013 bắt buộc giữ

- Dispatcher dùng adaptive `limiter.limit`, không dùng `maxLimit`.
- Năm project độc lập trả `429` trong 10 giây mở global rate-limit circuit.
- Stage re-check gate sau limiter permit và trước reservation/API call.
- Circuit backoff tăng theo cấp, persist qua restart và chỉ reset cấp sau 10 physical
  success liên tiếp.
- Generic `429` dùng cooldown tăng dần; không tự được coi là RPD exhausted.
- Watchdog/owner không được force-clear active rate-limit circuit chỉ vì counter nội
  bộ báo `anyCapacity`.
- Maintenance cho request đang chạy hoàn tất rồi suspend job tại ranh giới stage;
  chỉ redeploy khi `maintenanceState=drained`.
- Không xóa scheduler cursor, quota/circuit state, job, chunk, source R2 hoặc artifact
  để rollback.

## Trạng thái production đã xác minh

### Nền P011/P012

- Backup trước migration: 286 job, 2.227 chunk, 6 upload batch và 1 system row tại
  `backups/`.
- Project-pool migration đã apply; quota dead-time migration đã requeue 34 job và
  clear timer 197 chunk. Dry-run sau apply trả `0/0`.
- P012 chuyển MongoDB sang US East và gỡ nút thắt Mongo liên vùng.
- Phase 2 giữ eligible 50, group size 5, rotation bật, initial/max concurrency 5.

### Sự kiện P013 phải được tôn trọng

- Trước fix, snapshot từng có 243 logical-issued, 582 physical attempt, 529 response
  `429`, amplification `2,3951` dù limiter đã giảm về 1.
- Maintenance cũ không hard-drain active job.
- P013 xác định scheduler P011 khuếch đại một burst upstream `429` thành retry storm.
- P013 không xác định được quota dimension upstream chính xác và không có bằng chứng
  production cuối cùng cho thấy outbound IP Render bị block.
- Production hậu `0f739b1`: 225 logical-issued/226 physical, 0 response `429`,
  amplification `1,0044`, 45 chunk terminal, 45 completed/0 failed; maintenance
  `draining → drained` và resume nhận lại đúng 3 job.

### Gate hậu P013 cho canary 5 → 6

Snapshot read-only ngày 25-07-2026 trên instance bắt đầu tại
`2026-07-24T14:23:41.769Z`:

- 1.446 logical-issued / 1.480 physical;
- amplification `1,024`;
- 11/1.480 response `429` = `0,74%`;
- Mongo p95 50 ms; quota reserve/release p95 51/38 ms;
- RSS 38%; event-loop p95 21 ms;
- 300 chunk terminal; 113 completed, 0 failed, backlog 0;
- 50 key validated, 0 disabled, 0 untested;
- circuit từng mở 1 lần và đã recovery 1 lần.

Đây là bằng chứng cho đúng một canary `5 → 6`, không phải bằng chứng throughput ≥5×
hoặc giấy phép tăng lên 7.

## Trình tự tiếp tục

1. Đọc `AGENTS.md`, `project-011.md`, báo cáo tương thích và runbook.
2. Xác nhận live production commit vẫn chứa đầy đủ containment `0f739b1`; ghi commit,
   instance start time và cấu hình capacity.
3. Xác nhận:
   - `GEMINI_DIAGNOSTIC_PROBE_ENABLED=false`;
   - `maintenanceState=running`;
   - rate-limit circuit `closed`;
   - global gate reason trống;
   - MongoDB/R2 available;
   - không có upload/cleanup backlog bất thường.
4. Nếu còn active job/stage/waiting/in-flight hoặc Job MongoDB `processing`, chưa
   redeploy. Dùng maintenance và chờ `maintenanceState=drained`.
5. Owner chỉ đổi:

   ```env
   GEMINI_INITIAL_CONCURRENCY=5
   GEMINI_MAX_CONCURRENCY=6
   GEMINI_DIAGNOSTIC_PROBE_ENABLED=false
   ```

6. Không đổi eligible 50/group size 5/rotation/worker/source budget trong cùng canary.
7. Sau redeploy, lấy snapshot đầu rồi đo delta cùng instance tối thiểu 200
   logical-issued và 20 chunk terminal.
8. Canary chỉ pass khi:
   - physical/logical-issued ≤1,15;
   - `429` <1% sau warm-up;
   - Mongo p95 <200 ms;
   - quota reserve/release p95 <100 ms;
   - RSS <80%, event-loop p95 <200 ms;
   - không failed job mới, duplicate/mất stage, persist/lease error.
9. Không nâng lên 7 chỉ vì readiness xanh hoặc limiter đã đạt 6.
10. Mục tiêu ≥5× cần baseline workload tương đương và quality corpus không regression.

## Khi circuit mở

- Không force-wake/clear circuit.
- Không tăng pool, eligible project hoặc concurrency để thăm dò.
- Không gọi diagnostic probe trong cửa sổ đo.
- Không restart liên tục.
- Chờ `nextAvailableAt`; trong thời gian circuit mở không được có physical attempt mới.
- Queue phải tự thức trong 30 giây sau deadline nếu không có burst `429` mới.
- Generic `429` không được ghi thành bằng chứng project hết RPD hoặc Render IP bị block.

## Rollback

### Canary rollback thông thường

Nếu max 6 vi phạm gate nhưng chưa tạo retry storm:

```env
GEMINI_INITIAL_CONCURRENCY=5
GEMINI_MAX_CONCURRENCY=5
```

Giữ eligible 50/group size 5/rotation bật.

### Incident containment kiểu P013

Nếu circuit lặp lại, burst `429` hoặc amplification tăng nhanh:

```env
GEMINI_ELIGIBLE_PROJECT_LIMIT=5
GEMINI_PROJECT_GROUP_ROTATION_ENABLED=false
GEMINI_INITIAL_CONCURRENCY=1
GEMINI_MAX_CONCURRENCY=1
TRANSLATION_WORKER_CONCURRENCY=1
GEMINI_DIAGNOSTIC_PROBE_ENABLED=false
```

Đây là cấu hình an toàn tạm thời, không phải nghiệm thu throughput. Chờ circuit và
maintenance drain trước redeploy; giữ toàn bộ additive state/schema.

## Không được suy diễn

- Có 50 project độc lập không có nghĩa upstream capacity đồng đều hoặc luôn khả dụng.
- Counter RPM/TPM/RPD nội bộ không phải quota dashboard động của Gemini.
- Canary 25 request, một pages/hour gauge hoặc snapshot khác instance không thay thế
  gate 200 request/20 chunk.
- Mongo p95 xanh không đồng nghĩa Gemini quota/retry gate xanh.
- `project-pool-v2` giống nhau không chứng minh hai snapshot chạy cùng code.
- `/health` xanh không chứng minh R2, dispatcher, circuit hoặc quota broker sẵn sàng.
- P013 sửa amplification phía ứng dụng; không chứng minh quota dimension upstream.
- Corpus tự động pass không phải xác nhận lâm sàng.
- Không archive P011 hoặc tuyên bố ≥5× khi chưa có baseline tương đương.
