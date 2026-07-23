# Rollout scheduler Gemini project pool

## Cấu hình bắt buộc

- `GEMINI_API_KEYS`: 50 key, phân cách bằng dấu phẩy.
- `GEMINI_PROJECT_IDS`: 50 ID ổn định, duy nhất, cùng thứ tự với key. ID được lưu trong MongoDB; key không được lưu.
- `GEMINI_SCHEDULER_MODE=project_pool`.
- `GEMINI_ACTIVE_PROJECT_LIMIT=5` ở canary đầu tiên.
- Quota gốc: `GEMINI_PROJECT_RPM=15`, `GEMINI_PROJECT_TPM=250000`, `GEMINI_PROJECT_RPD=500`.
- `GEMINI_PROJECT_HEADROOM=0.9`, `GEMINI_PROJECT_MAX_IN_FLIGHT=2`.
- `TRANSLATION_WORKER_CONCURRENCY=3`, `PARALLEL_SOURCE_BUDGET_MB=15`.

Scheduler vận hành ở 14 RPM, 225.000 TPM, 450 normal RPD và 50 retry RPD cho mỗi project. RPD reset theo `America/Los_Angeles`.

## Quy trình deploy

1. Deploy trong vòng 15 phút sau mốc reset quota Pacific.
2. Tạm dừng nhận/claim job bằng maintenance control; chờ request đang chạy persist stage.
3. Chạy `npm run migrate:project-pool:dry`.
4. Kiểm tra dry-run chỉ thêm execution metadata, không đổi stage hoặc artifact.
5. Chạy `npm run migrate:project-pool`.
6. Deploy với `GEMINI_ACTIVE_PROJECT_LIMIT=5`, sau đó resume backlog.
7. Mỗi nấc 5 → 15 → 50 phải có ít nhất 200 logical stage và 20 chunk terminal.

Chỉ nâng nấc khi `physicalAttempts/logicalRequests <= 1.15`, 429 dưới 1%, RSS dưới 70%, event-loop p95 dưới 100 ms, corpus không có PASS→FAIL/critical/major mới, và không có duplicate/mất stage.

Rollback một nấc khi 429 đạt 3% trong 5 phút, RSS đạt 80%, event-loop p95 đạt 200 ms, hoặc có lỗi persist/lease. Rollback scheduler hoàn toàn bằng `GEMINI_SCHEDULER_MODE=legacy`; không xóa field hoặc quota state vì migration là additive.

## Quan sát

- `GET /status`: `dispatcher.stageQueueDepth`, concurrency, active project, resource guard và quota gate.
- `GET /metrics`: logical/physical/amplification, latency và token theo stage, 429 theo project index, dispatcher và pages/giờ.
- `GET /gemini-keys/status`: chỉ có index/status và quota aggregate; không có key, project ID hoặc fingerprint.

Metrics production cần được ghi lại trước canary để làm baseline pages/giờ. Mục tiêu 5× chỉ được xác nhận bằng production window tương đương; test local chỉ xác nhận invariants và amplification.

## Quality gate

Không đổi chunk 2 trang, `ThinkingLevel.HIGH`, prompt/pipeline version, thứ tự stage hoặc tối đa hai repair. Chỉ được tuyên bố “không regression theo corpus tự động”; kết quả không phải xác nhận của chuyên gia lâm sàng.
