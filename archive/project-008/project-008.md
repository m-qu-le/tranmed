# PROJECT 008 — Deploy trực tiếp worker pool 5 job / source budget 100 MiB

## 1. Thông tin dự án

| Thuộc tính | Giá trị |
| --- | --- |
| Mã dự án | P008 |
| Ngày lập | 22-07-2026 |
| Trạng thái | **ĐÃ ĐÓNG — rollback cấu hình do Render tràn bộ nhớ** |
| Baseline mã nguồn | `77111a5` trên nhánh `main` |
| Mục tiêu | Đưa backend production lên tối đa 5 job dịch đồng thời và tổng `sourceSize` active tối đa 100 MiB. |
| Phương thức kiểm chứng | Chủ dự án dùng thực tế trên Render Free và phản hồi nếu service crash, restart, chậm hoặc lỗi. Không rollout tăng dần và không benchmark trước deployment. |
| Quyết định rủi ro | Chấp nhận đây là thử nghiệm trực tiếp trên Render Free (1 instance, 512 MB RAM, 0.1 CPU); 100 MiB là budget source, **không phải** RAM dùng thực tế. |

## 2. Hiện trạng và thay đổi cần làm

Hiện tại backend chỉ nhận `TRANSLATION_WORKER_CONCURRENCY` là 1 hoặc 2, fallback là 1; `QueueManager` dùng hằng cứng 10 MiB để admission lane song song. Render production đang đặt concurrency là 2, nên thay fallback trong code một mình không làm production chạy 5 job.

P008 thay trực tiếp thành:

```env
TRANSLATION_WORKER_CONCURRENCY=5
PARALLEL_SOURCE_BUDGET_MB=100
```

`PARALLEL_SOURCE_BUDGET_MB` là biến mới. Job đầu vẫn có thể nhận file lớn hoặc không có `sourceSize` để chạy một mình; các lane sau chỉ được claim khi source size hợp lệ và tổng active source không vượt 100 MiB. FIFO, priority, cancel, retry, lease, hibernation và redeploy pause giữ nguyên semantics hiện có.

## 3. Phạm vi triển khai

### 3.1. Backend config và queue

- Sửa `readTranslationWorkerConcurrency()` để chấp nhận số nguyên 1–5, fallback 5; input ngoài khoảng, số thực và chuỗi không phải số phải fail-fast khi khởi động.
- Thêm parser strict `PARALLEL_SOURCE_BUDGET_MB`, chấp nhận số nguyên 10–100, fallback 100; export byte budget tương ứng.
- Dùng budget export này tại `QueueManager.claimAdmissibleJob()` và `getSystemStatus()` thay hằng cứng 10 MiB.
- Không đổi số worker chunk/Gemini, pipeline quality, schema MongoDB, R2 flow, upload concurrency hoặc frontend.

### 3.2. Tài liệu và test

- Đặt `.env.example` thành 5 / 100 và cập nhật README: cấu hình có thể rollback bằng env về 2 / 10 (hoặc 1 / 10), rồi restart Render.
- Cập nhật `env.test.js`: fallback 5, valid 1–5, invalid 0/6/số thực/chuỗi; thêm test budget default 100, min 10, max 100 và invalid.
- Cập nhật `workerPool.test.js`: 5 job source hợp lệ có thể active cùng lúc nhưng job thứ 6 không được claim; tổng 100 MiB được admission và 101 MiB bị chặn tại đầu FIFO; unknown-size vẫn chạy một mình.
- Giữ toàn bộ regression hiện có về duplicate claim, active byte cleanup, cancel, lease, hibernation và redeploy pause.

### 3.3. Chủ đích không làm trong P008

- Không thêm disk reservation, global Gemini semaphore, metrics RAM/CPU hoặc canary theo nấc. Đây là các biện pháp tối ưu/an toàn bị loại khỏi P008 theo quyết định thử nghiệm trực tiếp.
- Rủi ro còn lại được chấp nhận: PDF có thể cần RAM lớn hơn source size; 5 job có thể tăng request Gemini/R2, timeout, quota error hoặc làm Render Free restart.

## 4. Triển khai và deploy

1. Sửa code/test/tài liệu theo §3 trên `main`.
2. Chạy từ `med-translator-backend`: `npm test`; chạy `git diff --check` tại root. Không dùng PDF thật, key, URI hoặc `.env` trong commit.
3. Commit riêng P008, ví dụ `feat(P008): raise translation worker capacity`, rồi push `git push origin main` tới `git@github.com-personal:m-qu-le/tranmed.git`.
4. Vì repo không có `render.yaml`, xác nhận service Render đang auto-deploy branch `main`. Nếu Render không tự deploy sau push, dùng **Manual Deploy → Deploy latest commit** trong dashboard.
5. Trên Render Dashboard, đặt hai env ở §2 và lưu thay đổi để Render redeploy. Không đặt API key, Mongo URI hay secret vào Git.
6. Sau deploy, gọi `GET https://tranmed.onrender.com/api/translate/status`. Thành công tối thiểu là:

```json
{
  "worker": {
    "concurrency": 5,
    "parallelSourceBudgetBytes": 104857600
  }
}
```

`activeJobs` và `activeSourceBytes` phản ánh tải hiện thời nên không cần là 5/100 MiB tại thời điểm kiểm tra.

## 5. Kết quả kiểm chứng và đóng dự án

Trong kiểm chứng thực tế, Render bị tràn bộ nhớ và tự khởi động lại khi áp dụng mục tiêu 5 job / 100 MiB. P008 vì vậy không đạt điều kiện vận hành production trên Render Free (1 instance, 512 MB RAM, 0.1 CPU) và được đóng, không tiếp tục thử nghiệm hoặc tăng dần trong phạm vi dự án này.

Rollback vận hành đã chọn là đặt rõ trên Render:

```env
TRANSLATION_WORKER_CONCURRENCY=2
PARALLEL_SOURCE_BUDGET_MB=10
```

Lưu cấu hình để Render redeploy. Không xóa `PARALLEL_SOURCE_BUDGET_MB`, vì fallback của code P008 là 100 MiB. Sau redeploy cần kiểm tra endpoint status trả 2 / 10 MiB và xác nhận các job `processing` được lease recovery/retry bình thường; kết quả kiểm tra này không được ghi nhận trong hồ sơ P008.

## 6. Rollback

### 6.1. Rollback cấu hình (đã chọn)

Nếu Render crash/restart hoặc trải nghiệm không đạt, đặt rõ trên Render:

```env
TRANSLATION_WORKER_CONCURRENCY=2
PARALLEL_SOURCE_BUDGET_MB=10
```

Đặt `TRANSLATION_WORKER_CONCURRENCY=1` nếu cần mức an toàn cao hơn. Không xóa biến `PARALLEL_SOURCE_BUDGET_MB`, vì fallback P008 là 100 MiB. Lưu env/redeploy rồi kiểm endpoint status trả 2 / 10 MiB (hoặc 1 / 10 MiB).

Không xóa Job, `TranslationChunk`, batch hay object R2 để rollback. Sau restart, kiểm job `processing`, retry, lease recovery và cleanup; không giả định job thành công chỉ vì instance đã chạy lại.

### 6.2. Rollback code

Nếu lỗi logic xuất phát từ code P008, revert commit P008 trên `main`, push commit revert để Render deploy lại. Không dùng `git reset --hard` trên lịch sử đã push. Code cũ không biết biến `PARALLEL_SOURCE_BUDGET_MB`, nên biến này có thể giữ nguyên hoặc xóa sau khi status xác nhận queue đã về baseline.

## 7. Nhật ký

| Ngày | Mã | Nội dung | Kết quả |
| --- | --- | --- | --- |
| 22-07-2026 | P008-PLAN | Chủ dự án yêu cầu đổi trực tiếp lên 5 job / 100 MiB, push để Render deploy và tự kiểm chứng qua trải nghiệm. | Chưa thực hiện |
| 22-07-2026 | P008-IMPLEMENT | Commit `9b83947` (`feat(P008): raise translation worker capacity`), `npm test` đạt 127/127, `git diff --check` đạt và đã push `main`. | Hoàn thành |
| 22-07-2026 | P008-DEPLOY | Không có kết nối Render Dashboard trong phiên để xác nhận auto-deploy hoặc đặt env. Endpoint production còn trả `concurrency: 2`, `parallelSourceBudgetBytes: 10485760`. | Chờ đặt env 5 / 100 MiB và redeploy |
| 22-07-2026 | P008-RESULT | Kiểm chứng thực tế gây tràn bộ nhớ; Render tự restart. Mục tiêu 5 job / 100 MiB không phù hợp Render Free. Chọn rollback cấu hình rõ về 2 job / 10 MiB; không revert commit P008 để bảo toàn các thay đổi code mới hơn. | Đã đóng |
