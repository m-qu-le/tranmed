# P011 — Historical quota dead-time / Gemini project groups

> **ARCHIVE NOTE — 23-08-2026:** P011 đã retired/superseded bởi P015 local-first.
> Không chạy canary `5 → 6` và không dùng cấu hình cloud lịch sử dưới đây để vận hành
> P015. Tài liệu được giữ để giải thích scheduler/P013 containment, không phải runbook
> rollout đang hoạt động.
>
> Hồ sơ: `../archive/project-011/project-011.md`
> Handoff: `../archive/project-011/project-011-handoff.md`
> Báo cáo tương thích: `../archive/project-011/project-011-p013-compatibility-report.md`
> Sự cố đã đóng: `../archive/project-013/project-013.md`

Commit nền `ab15301` và bản containment P013 `0f739b1` đã được push/deploy; backup và hai migration production đã hoàn tất.
P012 đã đưa Mongo operation p95 xuống 98 ms trên 3.610 mẫu trong kiểm tra live hậu
cutover. Trước P013, amplification tích lũy là 1,219 và burst 429 ngắn hạn còn cao.
Nghiệm thu P013 đạt 225 logical-issued/226 physical, 0 response 429, amplification
1,0044 và 45 terminal chunk. Vẫn giữ trần concurrency 5 vì cửa sổ này chứng minh
containment/ổn định, không chứng minh mục tiêu throughput 5×.

## Cấu hình chung

- `GEMINI_API_KEYS`: 50 key, phân cách bằng dấu phẩy.
- `GEMINI_PROJECT_IDS`: 50 ID ổn định, duy nhất, cùng thứ tự với key.
- `GEMINI_SCHEDULER_MODE=project_pool`.
- `GEMINI_PROJECT_RPM=15`, `GEMINI_PROJECT_TPM=250000`, `GEMINI_PROJECT_RPD=500`.
- `GEMINI_PROJECT_HEADROOM=0.9`, `GEMINI_PROJECT_MAX_IN_FLIGHT=2`.
- `GEMINI_PROJECT_GROUP_SIZE=5`.
- `GEMINI_INITIAL_CONCURRENCY=5`; production hiện giữ `GEMINI_MAX_CONCURRENCY=5`.
- `GEMINI_DIAGNOSTIC_PROBE_ENABLED=false` trong mọi baseline/canary.
- `TRANSLATION_WORKER_CONCURRENCY=3`, `PARALLEL_SOURCE_BUDGET_MB=15`.

Scheduler vận hành ở 14 RPM, 225.000 TPM và một pool dùng chung 500 RPD/project.
`dailyNormalCount` và `dailyRetryCount` chỉ dùng để quan sát; không còn trần retry 50.
RPD reset theo `America/Los_Angeles`.

P013 thêm global rate-limit circuit: 5 project độc lập trả 429 trong 10 giây sẽ đóng
gate với backoff 60 giây → 2 → 4 → 8 → tối đa 10 phút; 10 physical success liên tiếp
mới reset cấp. Generic 429 dùng adaptive project cooldown và không tự được coi là
RPD-exhausted hoặc IP block. Circuit/gate phải được kiểm lại ngay trước API call và
được persist qua restart.

P013 circuit là safety authority. Watchdog/operator không được force-clear active
circuit chỉ vì counter nội bộ báo còn capacity; không tăng pool/concurrency hoặc gọi
diagnostic probe để thử trong cửa sổ rollout.

`GEMINI_ACTIVE_PROJECT_LIMIT` chỉ là alias tương thích. Production phải dùng
`GEMINI_ELIGIBLE_PROJECT_LIMIT`.

## Pha 1 — hotfix quota và phục hồi backlog

Pha này đã hoàn tất. Backup ghi nhận 286 job/2.227 chunk. Migration quota đã requeue
34 job, clear timer 197 chunk và dry-run sau apply trả `0/0`.

1. Tạm dừng bằng maintenance control và chờ `maintenanceState=drained`,
   `worker.activeJobs=0`, active/waiting stage bằng 0 và Mongo processing bằng 0.
2. Backup MongoDB.
3. Chạy `npm run migrate:project-pool:dry`, sau đó `npm run migrate:project-pool`.
4. Chạy `npm run migrate:quota-dead-time:dry`; kiểm tra chỉ có job
   `pending/GEMINI_RATE_LIMIT` với timer quota tương lai.
5. Deploy với:
   - `GEMINI_ELIGIBLE_PROJECT_LIMIT=5`
   - `GEMINI_PROJECT_GROUP_ROTATION_ENABLED=false`
   - `GEMINI_INITIAL_CONCURRENCY=5`
   - `GEMINI_MAX_CONCURRENCY=5`
6. Khi readiness xanh, chạy `npm run migrate:quota-dead-time` rồi resume.

Gate pha 1: ít nhất 50 logical-issued stage, 10 chunk terminal,
physical/logical-issued ≤1,15, không duplicate/mất stage và không có lỗi persist/lease.

Không bật trực tiếp 50 eligible project trong lần deploy đầu. Fallback code giữ
eligible/group/concurrency ở 5 và rotation tắt, nhưng production vẫn nên khai báo rõ
các giá trị phase 1 để status và rollback không phụ thuộc fallback.

Migration requeue là idempotent, không giảm attempt history, không xóa artifact, stage,
content hoặc repair count; chạy lại phải trả `jobsToRequeue=0`.

## Pha 2 — gate ổn định đạt, capacity 5× vẫn đang theo dõi

Deploy:

- `GEMINI_ELIGIBLE_PROJECT_LIMIT=50`
- `GEMINI_PROJECT_GROUP_SIZE=5`
- `GEMINI_PROJECT_GROUP_ROTATION_ENABLED=true`
- `GEMINI_INITIAL_CONCURRENCY=5`
- `GEMINI_MAX_CONCURRENCY=5`
- `GEMINI_DIAGNOSTIC_PROBE_ENABLED=false`

Gate containment đã đạt ngày 24-07-2026 với 225 logical-issued, 45 terminal chunk,
physical/logical 1,0044 và 0 response 429. Chưa nâng trần lên 10: P012 đã gỡ Mongo
blocker và P013 đã gỡ retry storm, nhưng mỗi lần tăng vẫn phải lặp lại cửa sổ tối thiểu
200 logical-issued/20 terminal chunk với physical/logical ≤1,15 và 429 <1%.

Cửa sổ P011 hậu P013 ngày 25-07-2026 trên instance bắt đầu tại
`2026-07-24T14:23:41.769Z` đạt 1.446 logical-issued/1.480 physical, amplification
1,024, 11 response 429 = 0,74%, 300 terminal chunk, Mongo/quota/resource gate đạt,
113 completed/0 failed và backlog 0. Đây là approval có điều kiện cho đúng một canary
max `5 → 6`; live pre-deploy vẫn phải circuit closed, maintenance running và không có
active work/backlog.

Chỉ đổi trong canary:

```env
GEMINI_INITIAL_CONCURRENCY=5
GEMINI_MAX_CONCURRENCY=6
GEMINI_DIAGNOSTIC_PROBE_ENABLED=false
```

Không đổi eligible 50/group size 5/rotation/worker/source budget trong cùng lần.
Sau deploy đo lại đầy đủ ≥200 logical-issued/≥20 terminal chunk. Nếu circuit mở,
canary không đủ điều kiện tăng tiếp nhưng không được force-clear circuit.

### Rollback canary thông thường

Nếu max 6 vi phạm gate nhưng chưa thành retry storm:

```env
GEMINI_INITIAL_CONCURRENCY=5
GEMINI_MAX_CONCURRENCY=5
```

Giữ eligible 50/group size 5/rotation bật. Rollback khi 429 ≥3% trong 5 phút,
amplification >1,15, RSS ≥80%, event-loop p95 ≥200 ms, duplicate/mất stage, failed
job mới hoặc lỗi persist/lease.

### Incident containment kiểu P013

Nếu circuit lặp lại, burst 429 hoặc amplification tăng nhanh:

```env
GEMINI_ELIGIBLE_PROJECT_LIMIT=5
GEMINI_PROJECT_GROUP_ROTATION_ENABLED=false
GEMINI_INITIAL_CONCURRENCY=1
GEMINI_MAX_CONCURRENCY=1
TRANSLATION_WORKER_CONCURRENCY=1
GEMINI_DIAGNOSTIC_PROBE_ENABLED=false
```

Đây là chế độ an toàn tạm thời, không phải nghiệm thu throughput. Chờ
`nextAvailableAt` và maintenance `drained` trước redeploy. Không restart liên tục,
không xóa quota/circuit state, scheduler cursor hoặc additive schema.

## Quan sát

- `GET /status`: maintenance state, eligible project, group hiện tại,
  runnable/deferred depth, quota gate, nguyên nhân block, watchdog và next wake.
- `GET /metrics`: logical scheduled/issued, physical, amplification, rotation, idle,
  rate-limit circuit/backoff/open count, watchdog recovery, group utilization, Mongo
  latency và pages/giờ.
- `GET /gemini-keys/status`: chỉ index, group và trạng thái public; không có key,
  project ID hoặc fingerprint.

Metrics production cần baseline trên cửa sổ tải tương đương trước khi xác nhận mục tiêu
5× pages/giờ.

Tiêu chí idle của P011 chỉ áp dụng khi `maintenanceState=running`, rate-limit circuit
`closed`, queue không hibernate có chủ ý và broker có project admissible. Khi circuit
mở, physical attempt mới phải bằng 0 tới `nextAvailableAt` và queue phải tự thức trong
30 giây sau deadline nếu không có burst 429 mới. Pacific reset ≤30 giây chỉ áp dụng
cho RPD-only gate khi không còn circuit/cooldown P013 hiệu lực.

## Quality gate

Không đổi chunk 2 trang, `ThinkingLevel.HIGH`, prompt/pipeline version, thứ tự stage
hoặc tối đa hai repair. Chỉ tuyên bố “không regression theo corpus tự động”; không coi
đó là xác nhận của chuyên gia lâm sàng.
