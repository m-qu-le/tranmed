# Rollout quota dead-time / Gemini project groups

## Cấu hình chung

- `GEMINI_API_KEYS`: 50 key, phân cách bằng dấu phẩy.
- `GEMINI_PROJECT_IDS`: 50 ID ổn định, duy nhất, cùng thứ tự với key.
- `GEMINI_SCHEDULER_MODE=project_pool`.
- `GEMINI_PROJECT_RPM=15`, `GEMINI_PROJECT_TPM=250000`, `GEMINI_PROJECT_RPD=500`.
- `GEMINI_PROJECT_HEADROOM=0.9`, `GEMINI_PROJECT_MAX_IN_FLIGHT=2`.
- `GEMINI_PROJECT_GROUP_SIZE=5`.
- `GEMINI_INITIAL_CONCURRENCY=5`, `GEMINI_MAX_CONCURRENCY=10`.
- `TRANSLATION_WORKER_CONCURRENCY=3`, `PARALLEL_SOURCE_BUDGET_MB=15`.

Scheduler vận hành ở 14 RPM, 225.000 TPM và một pool dùng chung 500 RPD/project.
`dailyNormalCount` và `dailyRetryCount` chỉ dùng để quan sát; không còn trần retry 50.
RPD reset theo `America/Los_Angeles`.

`GEMINI_ACTIVE_PROJECT_LIMIT` chỉ là alias tương thích. Production phải dùng
`GEMINI_ELIGIBLE_PROJECT_LIMIT`.

## Pha 1 — hotfix quota và phục hồi backlog

1. Tạm dừng bằng maintenance control và chờ `worker.activeJobs=0`.
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

Migration requeue là idempotent, không giảm attempt history, không xóa artifact, stage,
content hoặc repair count; chạy lại phải trả `jobsToRequeue=0`.

## Pha 2 — đủ 10 nhóm, concurrency vẫn bắt đầu ở 5

Deploy:

- `GEMINI_ELIGIBLE_PROJECT_LIMIT=50`
- `GEMINI_PROJECT_GROUP_SIZE=5`
- `GEMINI_PROJECT_GROUP_ROTATION_ENABLED=true`
- `GEMINI_INITIAL_CONCURRENCY=5`
- `GEMINI_MAX_CONCURRENCY=10`

Theo dõi tối thiểu 200 logical-issued stage và 20 chunk terminal. Limiter chỉ tăng từng
một slot sau 30 stage thành công và chỉ khi Mongo p95 dưới 200 ms, RSS/event-loop/429
cùng đạt gate.

Rollback về working set đầu:

- `GEMINI_ELIGIBLE_PROJECT_LIMIT=5`
- `GEMINI_PROJECT_GROUP_ROTATION_ENABLED=false`
- `GEMINI_MAX_CONCURRENCY=5`

Rollback khi 429 ≥3% trong 5 phút, RSS ≥80%, event-loop p95 ≥200 ms, duplicate/mất
stage hoặc lỗi persist/lease. Không xóa quota state hay scheduler cursor.

## Quan sát

- `GET /status`: eligible project, group hiện tại, runnable/deferred depth, nguyên nhân
  block, watchdog và next wake.
- `GET /metrics`: logical scheduled/issued, physical, amplification, rotation, idle,
  watchdog recovery, group utilization, Mongo latency và pages/giờ.
- `GET /gemini-keys/status`: chỉ index, group và trạng thái public; không có key,
  project ID hoặc fingerprint.

Metrics production cần baseline trên cửa sổ tải tương đương trước khi xác nhận mục tiêu
5× pages/giờ.

## Quality gate

Không đổi chunk 2 trang, `ThinkingLevel.HIGH`, prompt/pipeline version, thứ tự stage
hoặc tối đa hai repair. Chỉ tuyên bố “không regression theo corpus tự động”; không coi
đó là xác nhận của chuyên gia lâm sàng.
