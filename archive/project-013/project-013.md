# Project 013 — Hồ sơ sự cố Gemini `429` trên Render

> Ngày lập: 24-07-2026
> Ngày đóng: 25-07-2026
> Múi giờ vận hành: Asia/Saigon (UTC+7)
> Trạng thái: **đã đóng — production phục hồi**
> Commit khắc phục: `0f739b1 Stop Gemini 429 retry storms`
> Mục đích: lưu hồ sơ sự cố, phân tích nguyên nhân, bản vá và bằng chứng nghiệm thu.

## 1. Tóm tắt sự cố

Người vận hành nhận thấy số lượng file dịch hoàn tất ngừng tăng trong một khoảng
thời gian dù backend trên Render vẫn đang chạy.

Log cho thấy các stage dịch liên tục:

1. reserve một Gemini project/key;
2. nhận HTTP `429`;
3. đặt project đó vào cooldown 60 giây;
4. chuyển sang project/key khác;
5. lặp lại trên nhiều project.

Production không mất khả năng gọi Gemini hoàn toàn. Một số request vẫn thành công
xen kẽ, nhưng tỷ lệ `429` rất cao và số lần gọi vật lý lớn hơn nhiều số logical
stage cần thực hiện.

Hai model đã được kiểm tra:

- `gemini-3.5-flash-lite`
- `gemini-3.1-flash-lite`

Cả hai chạy thành công ở local nhưng đều trả `429 RESOURCE_EXHAUSTED` khi cùng
probe được gọi từ instance Render.

## 2. Kiến trúc và môi trường liên quan

### 2.1 Backend

- Node.js/Express.
- Package Gemini: `@google/genai` phiên bản `2.13.0`.
- Persistent queue trong MongoDB.
- PDF nguồn và artifact dùng Cloudflare R2.
- Backend production chạy bằng Render Free Web Service.
- Render Free không có Shell/SSH.
- Instance production có ba source worker lane.
- Quality pipeline chia PDF thành chunk và có nhiều stage cho mỗi chunk, ví dụ:
  `translate`, `medical_audit`, `revise`, `verify`, `repair`, `reverify`.

### 2.2 Gemini project pool

Theo xác nhận trực tiếp của chủ hệ thống:

- Render và local có cùng danh sách 50 API key.
- Mỗi API key thuộc một Google project độc lập.
- Cả 50 project đều thuộc Free Tier.
- Thứ tự key trên Render giống thứ tự key ở local.
- Chủ hệ thống đã kiểm tra thủ công 4–5 project đại diện trong AI Studio.
- Usage hiển thị trong ngày của các project được kiểm tra chỉ khoảng 80 request.

Cấu hình production được API metrics/status phản ánh:

| Thuộc tính | Giá trị |
|---|---:|
| Scheduler mode | `project_pool` |
| Số project cấu hình | 50 |
| Số project eligible | 50 |
| Kích thước working group | 5 |
| Số group | 10 |
| Project RPM nội bộ | 14 sau headroom |
| Project TPM nội bộ | 225.000 sau headroom |
| Project RPD nội bộ | 500 |
| Max in-flight mỗi project | 2 |
| Worker concurrency | 3 |
| Gemini adaptive concurrency | khởi tạo tối đa 5, có thể giảm đến 1 |

Các giá trị 14 RPM và 225.000 TPM là giới hạn admission do ứng dụng tự cấu hình,
không phải kết quả đọc quota động từ Google AI Studio.

## 3. Triệu chứng trong log do người vận hành cung cấp

File log gốc được cung cấp trong phiên điều tra:

```text
C:\Users\lequa\.codex\attachments\
815a741e-862e-48e5-8b68-74d6675fa0f1\pasted-text.txt
```

Log chứa nhiều job trong batch:

```text
batchId=686e8759-3a72-4894-b7e3-0af24f76067e
```

Một số job xuất hiện nhiều lần:

```text
jobId=0be84249-d200-4679-b877-498f5b5b107f
jobId=968cd3c2-a249-4e1b-b8a5-f629bb07b24c
jobId=73f4f1f2-ff66-433f-8a48-68ae525a02e9
```

Mẫu lặp đại diện:

```text
[translate] keyIndex=44 event=reserved
[translate] keyIndex=44 event=cooldown status=429 retryAfterMs=60000
[translate] keyIndex=40 event=reserved
[translate] keyIndex=40 event=cooldown status=429 retryAfterMs=60000
[translate] keyIndex=41 event=reserved
[translate] keyIndex=41 event=cooldown status=429 retryAfterMs=60000
```

Trong cùng một đợt, log lần lượt xuất hiện trên gần như toàn bộ key index từ
`0` đến `49`. Thời gian giữa `reserved` và `cooldown` thường chỉ khoảng
150–400 ms, phù hợp với một phản hồi từ chối sớm thay vì request inference hoàn
chỉnh.

Log cũng có thành công xen kẽ, ví dụ:

```text
[medical_audit] keyIndex=14 event=reserved
[medical_audit] keyIndex=14 event=succeeded
✅ [Chunk 14] Hoàn thành stage=medical_audit.
```

Do đó log không thể hiện tình trạng toàn bộ Gemini API bị mất kết nối hoặc mọi
request đều thất bại tuyệt đối.

## 4. Diagnostic probe đã thêm vào hệ thống

Do Render Free không có Shell, một endpoint chẩn đoán bảo vệ bằng maintenance
token đã được thêm trong commit:

```text
5b1dbdf Add protected Gemini diagnostic probe
```

Commit đã được push lên:

```text
origin/main
GitHub repository: m-qu-le/tranmed
```

Endpoint:

```http
POST /api/translate/diagnostics/gemini-probe
X-Maintenance-Token: <secret>
Content-Type: application/json
```

Body chỉ cho phép một trong hai model:

```json
{"model":"gemini-3.5-flash-lite"}
```

```json
{"model":"gemini-3.1-flash-lite"}
```

Đặc điểm của probe:

- mặc định tắt;
- chỉ bật khi `GEMINI_DIAGNOSTIC_PROBE_ENABLED=true`;
- bắt buộc `MAINTENANCE_CONTROL_TOKEN`;
- chỉ sử dụng key index `0`;
- tạo một PDF y khoa nhỏ trong RAM;
- không ghi MongoDB;
- không ghi R2;
- không ghi file tạm;
- không trả nội dung dịch;
- không trả API key;
- lọc/redact secret khỏi lỗi;
- giới hạn 4 request/giờ theo HTTP rate limiter;
- cooldown 5 phút cho mỗi model;
- chỉ trả metadata an toàn như model, latency, token usage, finish reason và
  thông tin lỗi quota nếu SDK cung cấp.

PDF probe chứa hai câu tiếng Anh:

```text
Cardiac output is the volume of blood pumped by the heart per minute.
It equals heart rate multiplied by stroke volume.
```

Kích thước PDF tạo ra trong các lần test là 986 byte.

## 5. Toàn bộ kiểm thử đã thực hiện

### 5.1 Unit test của diagnostic probe

Các trường hợp đã test:

1. Probe mặc định bị tắt nếu không bật rõ bằng biến môi trường.
2. Model ngoài allowlist bị từ chối trước khi đọc API key.
3. Response thành công chỉ trả metadata, không trả nội dung dịch hoặc key.
4. Lỗi quota được sanitize nhưng vẫn giữ trường quota an toàn nếu SDK có trả.
5. Cooldown được áp dụng riêng theo model.
6. Secret được truyền trực tiếp vào dependency mock cũng bị redact, không chỉ
   secret lấy từ biến môi trường.

Kết quả targeted test:

```text
10 tests
10 passed
0 failed
```

Nhóm test targeted bao gồm:

- `geminiDiagnosticProbe.test.js`
- `env.test.js`
- `geminiKeyStatusController.test.js`

### 5.2 Kiểm tra import route

Route backend được import độc lập sau thay đổi:

```text
route-import-ok
```

Điều này xác nhận không có lỗi cú pháp/module resolution khi Express nạp route
diagnostic.

### 5.3 Kiểm tra lint/diff

- Backend không có script lint riêng.
- `npm run lint --if-present` thoát với mã `0` và không có output.
- `git diff --check` không báo whitespace error.
- Git chỉ cảnh báo quy tắc chuyển LF sang CRLF trên Windows.

### 5.4 Toàn bộ test backend

Lệnh:

```powershell
npm test
```

Kết quả trước khi deploy diagnostic endpoint:

```text
177 tests
177 passed
0 failed
```

Thời gian chạy khoảng 19,5 giây.

Các test dùng mock/fixture ngoại trừ các smoke/probe được gọi rõ; full unit suite
không tự gọi Gemini production.

### 5.5 Test API thật từ local

Local có file `.env` chứa 50 key. Không có key nào được in ra trong quá trình
test.

Probe sử dụng key index `0`, cùng PDF 986 byte và cùng cấu hình request gần với
quality translation production.

#### `gemini-3.5-flash-lite`

```json
{
  "ok": true,
  "model": "gemini-3.5-flash-lite",
  "keyIndex": 0,
  "latencyMs": 4624,
  "modelVersion": "gemini-3.5-flash-lite",
  "finishReason": "STOP",
  "pdfBytes": 986,
  "usage": {
    "promptTokenCount": 789,
    "candidatesTokenCount": 31,
    "thoughtsTokenCount": 574,
    "totalTokenCount": 1394
  }
}
```

#### `gemini-3.1-flash-lite`

```json
{
  "ok": true,
  "model": "gemini-3.1-flash-lite",
  "keyIndex": 0,
  "latencyMs": 3828,
  "modelVersion": "gemini-3.1-flash-lite",
  "finishReason": "STOP",
  "pdfBytes": 986,
  "usage": {
    "promptTokenCount": 789,
    "candidatesTokenCount": 30,
    "thoughtsTokenCount": 774,
    "totalTokenCount": 1593
  }
}
```

Kết quả local xác nhận tại thời điểm test:

- key index `0` hợp lệ;
- cả hai model tồn tại và nhận request;
- PDF/prompt/config cơ bản được Gemini chấp nhận;
- lỗi không tái hiện ở local.

### 5.6 Xác minh Render đã deploy diagnostic endpoint

Trước khi Render nhận commit mới:

```http
POST /api/translate/diagnostics/gemini-probe
HTTP 404
Cannot POST /api/translate/diagnostics/gemini-probe
```

Sau deploy, request không có maintenance token:

```http
HTTP 403
{"error":"Mã quản trị không hợp lệ."}
```

Sự chuyển đổi từ `404` sang `403` xác nhận route mới đã xuất hiện trên instance
production và middleware bảo vệ token hoạt động.

### 5.7 Test API thật từ Render

Biến môi trường production đã được chủ hệ thống đặt:

```text
GEMINI_DIAGNOSTIC_PROBE_ENABLED=true
```

Hai request được gửi đến endpoint production bằng maintenance token. Token
không được in hoặc ghi vào báo cáo.

#### `gemini-3.1-flash-lite`

```json
{
  "ok": false,
  "model": "gemini-3.1-flash-lite",
  "keyIndex": 0,
  "latencyMs": 900,
  "upstreamStatus": 429,
  "upstreamCode": null,
  "message": "{\"error\":{\"code\":429,\"message\":\"Resource has been exhausted (e.g. check quota).\",\"status\":\"RESOURCE_EXHAUSTED\"}}",
  "retryAfter": null,
  "details": []
}
```

#### `gemini-3.5-flash-lite`

```json
{
  "ok": false,
  "model": "gemini-3.5-flash-lite",
  "keyIndex": 0,
  "latencyMs": 201,
  "upstreamStatus": 429,
  "upstreamCode": null,
  "message": "{\"error\":{\"code\":429,\"message\":\"Resource has been exhausted (e.g. check quota).\",\"status\":\"RESOURCE_EXHAUSTED\"}}",
  "retryAfter": null,
  "details": []
}
```

Google SDK không trả:

- quota metric cụ thể;
- quota ID;
- quota value;
- quota dimensions;
- `Retry-After`.

Vì vậy không thể phân biệt trực tiếp từ response này giữa RPM, TPM, RPD, một
limit khác hoặc capacity/abuse enforcement.

### 5.8 Snapshot production ngay sau deploy

Instance metrics bắt đầu tại:

```text
2026-07-24T13:17:15.045Z
```

Snapshot đầu tiên, khoảng vài phút sau khi instance khởi động:

| Chỉ số | Giá trị |
|---|---:|
| Active jobs | 3 |
| Logical issued stages | 45 |
| Physical attempts | 112 |
| `429` responses | 99 |
| Physical/logical amplification | 2,4889 |
| Group rotations | 19 |
| Adaptive limit | 1 |
| Rate-limit ratio quan sát | 0,92 |
| Terminal chunks | 1 |
| Pages completed | 1 |

`99 / 112`, tương đương khoảng 88,4% số physical attempt kể từ khi instance
khởi động, đã nhận `429`.

Snapshot kế tiếp vài phút sau:

| Chỉ số | Giá trị |
|---|---:|
| Logical issued stages | 75 |
| Physical attempts | 179 |
| `429` responses | 165 |
| Physical/logical amplification | 2,3867 |
| Group rotations | 33 |
| Adaptive limit | 1 |
| Rate-limit ratio gần nhất | 0,98 |
| Terminal chunks | 1 |
| Pages completed | 1 |

Giữa hai snapshot:

- thêm 67 physical attempt;
- thêm 66 response `429`;
- không tăng terminal chunk hoặc completed page.

### 5.9 Test maintenance pause

Mục tiêu của test là tạo một khoảng thời gian Render không có workload nền,
chờ cooldown hết rồi chạy một probe đơn lẻ. Không có job nào bị xóa.

Gọi:

```http
POST /api/translate/maintenance/pause
```

Response ban đầu:

```json
{
  "status": 200,
  "isMaintenancePaused": true,
  "activeJobs": 2,
  "activeStages": 0,
  "waitingStages": 0
}
```

Hệ thống được poll trong khoảng hai phút. Kết quả:

- `isMaintenancePaused=true`;
- active jobs giảm từ 2 xuống 1 nhưng không về 0;
- active stage và waiting stage tiếp tục xuất hiện;
- job còn lại tiếp tục gọi Gemini.

Metrics trước và trong pause:

| Chỉ số | Trước pause | Trong pause |
|---|---:|---:|
| Physical attempts | 179 | 348 |
| `429` responses | 165 | 324 |
| Terminal chunks | 1 | 10 |
| Pages completed | 1 | 19 |

Delta trong thời gian pause:

- thêm 169 physical attempt;
- thêm 159 response `429`;
- thêm 9 terminal chunk;
- thêm 18 completed page.

Vì workload nền vẫn hoạt động, probe cô lập không được gọi. Test không thể trả lời
câu hỏi “một Render request khi hoàn toàn idle có thành công hay không”.

Sau test, maintenance pause được hủy:

```json
{
  "status": 200,
  "message": "Đã tiếp tục nhận job mới.",
  "isMaintenancePaused": false,
  "activeJobs": 3
}
```

Production không bị để lại trong chế độ maintenance.

### 5.10 Snapshot cuối dùng cho báo cáo

Thời điểm lấy:

```text
2026-07-24T13:36:31.7608913Z
2026-07-24 20:36:31 Asia/Saigon
```

Metrics tính từ lần khởi động instance lúc `13:17:15Z`:

| Chỉ số | Giá trị |
|---|---:|
| Maintenance paused | false |
| Active jobs | 3 |
| Active stages | 1 |
| Waiting stages | 6 |
| Runnable stages | 14 |
| Deferred stages | 10 |
| Logical issued stages | 243 |
| Physical attempts | 582 |
| `429` responses | 529 |
| Physical/logical amplification | 2,3951 |
| Adaptive concurrency limit | 1 |
| Rate-limit ratio gần nhất | 0,88 |
| Group rotations | 103 |
| Current group | 6/10 |
| Terminal chunks | 19 |
| Pages completed | 37 |
| Pages/hour gauge | 114,95 |

Tỷ lệ tích lũy:

```text
529 / 582 = 90,89% physical attempts nhận 429
```

Trong khi đó hệ thống vẫn hoàn tất được một số chunk/page, xác nhận thành công
xen kẽ với các đợt từ chối.

## 6. Hành vi code liên quan đã xác minh

Phần này chỉ mô tả code hiện tại, không đề xuất cách thay đổi.

### 6.1 Mỗi logical stage có tối đa ba physical attempt

Trong project-pool mode:

```text
maxPhysicalAttempts = 3
```

Một logical stage không tự quét đủ 50 project. Tuy nhiên nhiều logical stage từ
nhiều chunk/job có thể chạy hoặc chờ đồng thời. Tổng hợp các stage này có thể
reserve rất nhiều project trong một khoảng thời gian ngắn.

### 6.2 Chọn project và xoay group

Hàm `reserve()` trong:

```text
med-translator-backend/src/services/geminiKeyScheduler.js
```

khi bật group rotation sẽ thử các group tính từ current group và có thể chuyển
current group nếu tìm thấy project mà bộ đếm nội bộ cho rằng còn capacity.

Một project được xem là không khả dụng nếu:

- disabled;
- đang cooldown;
- chạm giới hạn RPM nội bộ;
- chạm giới hạn TPM nội bộ;
- chạm giới hạn RPD nội bộ;
- chạm max in-flight.

Các giới hạn này được tính từ state nội bộ của ứng dụng, không đọc trực tiếp
trạng thái quota động của Gemini trước mỗi request.

### 6.3 Xử lý `429`

Khi một physical request trả `429`:

1. scheduler lấy `Retry-After` nếu SDK cung cấp;
2. nếu không có, mặc định 60.000 ms;
3. release reservation;
4. đặt `cooldownUntil`;
5. ghi event `cooldown`;
6. thêm lỗi vào danh sách lỗi quota;
7. tiếp tục vòng lặp nếu physical attempt budget của logical stage chưa hết.

Production probe nhận `retryAfter=null`, nên fallback 60 giây phù hợp với log:

```text
retryAfterMs=60000
```

### 6.4 Điều kiện mở global quota gate

Sau khi logical stage dùng hết physical attempt, code đánh giá `poolExhausted`
bằng state capacity nội bộ.

Nếu nhiều project khác chưa được thử vẫn không cooldown và còn dưới các counter
nội bộ, `poolExhausted` có thể là `false` dù ba project vừa gọi đều trả `429`.
Trong trường hợp đó global gate không nhất thiết được mở.

### 6.5 Adaptive concurrency

Adaptive limiter giảm concurrency khi nhận nhiều `429`.

Trong sự cố, limiter đã giảm về mức tối thiểu:

```text
limit = 1
```

Dù chỉ còn một physical request chạy tại một thời điểm, scheduler vẫn tiếp tục
phát request tuần tự. Vì vậy concurrency bằng 1 không đồng nghĩa với ngừng retry.

### 6.6 Bộ đếm RPD nội bộ

Khi reserve một request:

- request loại normal tăng `dailyNormalCount`;
- request loại retry tăng `dailyRetryCount`.

Việc tăng xảy ra trước khi biết upstream thành công hay trả `429`. Khi `429`,
release hiện giữ lại request event và daily counter.

Snapshot sau deploy cho thấy các project có số liệu nội bộ đại diện:

```text
normalRpd: khoảng 5–77
retryRpd: khoảng 132–147
totalRpd: khoảng 141–223
```

Đây là counter admission của ứng dụng, không phải số liệu do Gemini API trả.
Chủ hệ thống quan sát khoảng 80 request trong AI Studio ở 4–5 project đại diện.
Hai loại số liệu có định nghĩa và thời điểm cập nhật khác nhau nên không thể coi
chúng là cùng một metric.

### 6.7 Maintenance pause

`pauseForRedeploy()` hiện:

- đặt `isMaintenancePaused=true`;
- xóa retry timer của queue;
- ngăn worker claim job thay thế;
- phát system-status event.

Hàm này không trực tiếp:

- abort active job;
- suspend các Gemini stage đang chạy/chờ;
- thu hồi lease của active job ngay lập tức.

Điều này phù hợp với test thực tế: job mới không được nhận nhưng job đã active
vẫn tiếp tục thực hiện stage.

## 7. Các kết luận đã được bằng chứng xác nhận

1. Hai model `3.5-flash-lite` và `3.1-flash-lite` đều hoạt động ở local.
2. Cùng hai model đều trả `429 RESOURCE_EXHAUSTED` từ probe trên Render.
3. Lỗi không riêng cho một trong hai model đã thử.
4. Response `429` từ Render đến rất nhanh và không có quota detail.
5. Production có tỷ lệ `429` rất cao, từng đạt 98% trong cửa sổ quan sát.
6. Physical attempts cao hơn logical issued stages khoảng 2,4 lần.
7. Cả 50 key index xuất hiện trong các chuỗi cooldown của log.
8. Render vẫn có request Gemini thành công xen kẽ; không phải chặn tuyệt đối.
9. Adaptive limiter đã giảm xuống 1 nhưng chuỗi retry tuần tự vẫn tiếp tục.
10. Maintenance pause hiện tại không dừng active job.
11. Local và Render dùng cùng 50 key theo xác nhận của chủ hệ thống.
12. Mỗi key thuộc một project độc lập theo xác nhận của chủ hệ thống.
13. Không có API key hoặc maintenance token nào được đưa vào tài liệu này.

## 8. Những điều chưa được chứng minh

Chưa có đủ dữ kiện để khẳng định nguyên nhân upstream chính xác là một trong các
trường hợp sau:

- RPM;
- TPM;
- RPD;
- token-per-day hoặc một limit model-specific khác;
- giới hạn theo account/billing history;
- dynamic/shared serving capacity;
- anti-abuse enforcement;
- reputation hoặc shared outbound IP của Render;
- region/routing giữa Render và Gemini;
- một cơ chế không được thể hiện trong quota dashboard.

Đặc biệt:

- Google response không ghi quota metric.
- Chưa thực hiện probe Render trong trạng thái worker hoàn toàn idle.
- Chưa thực hiện probe từ Render service ở region khác.
- Chưa ghi lại outbound IP thực tế của từng request.
- Chưa thực hiện A/B test đồng thời giữa hai Render region.
- Chưa thực hiện A/B test giữa Render shared IP và dedicated IP.
- Chưa có xác nhận từ Google rằng 50 Free Tier project cùng phát traffic từ một
  IP có bị gom vào một giới hạn chống lạm dụng hay không.

Thành công xen kẽ trên Render làm suy yếu giả thuyết “IP bị khóa hoàn toàn”, nhưng
không loại trừ một giới hạn tạm thời, xác suất, capacity hoặc anti-abuse liên quan
đến nguồn traffic.

## 9. Thông tin nền từ tài liệu nhà cung cấp

### Google Gemini

Tài liệu rate limit của Google nêu:

- các dimension thường gặp gồm RPM, TPM và RPD;
- chỉ cần vượt một dimension là có thể nhận `429`;
- quota chính thức được áp dụng theo project, không theo API key;
- giới hạn khác nhau theo model/tier;
- actual capacity không được bảo đảm và có thể thay đổi;
- rate limit hỗ trợ duy trì công bằng, chống lạm dụng và ổn định hệ thống.

Nguồn:

```text
https://ai.google.dev/gemini-api/docs/rate-limits
https://ai.google.dev/gemini-api/docs/troubleshooting
```

Tài liệu abuse monitoring của Google nêu họ có automated/manual detection và có
thể áp dụng temporary usage limits. Tài liệu không công bố một quy tắc cụ thể
gom 50 project theo outbound IP.

Nguồn:

```text
https://ai.google.dev/gemini-api/docs/usage-policies
```

### Render

Tài liệu Render nêu:

- outbound traffic dùng các dải IP theo region;
- các dải outbound mặc định được chia sẻ giữa các service trong cùng region;
- một service có thể dùng bất kỳ IP nào trong dải liên quan;
- restart/redeploy không phải cam kết cấp một IP độc lập;
- không thể đổi region trực tiếp cho service hiện có;
- dedicated outbound IP là tính năng trả phí của workspace phù hợp.

Nguồn:

```text
https://render.com/docs/outbound-ip-addresses
https://render.com/docs/regions
https://render.com/docs/dedicated-ips
https://render.com/docs/free
```

## 10. Câu hỏi mở dành cho người review độc lập

1. Với cùng project/key/model/payload nhưng local thành công và Render nhận
   `429`, những lớp quota/capacity nào có thể tạo khác biệt theo nguồn chạy?
2. Generic `RESOURCE_EXHAUSTED` không có quota detail thường xuất hiện trong
   trường hợp nào của Gemini Developer API?
3. Chuỗi nhiều logical stage, mỗi stage tối đa ba physical attempt, có giải thích
   đầy đủ việc gần như toàn bộ 50 project lần lượt cooldown không?
4. Cách ứng dụng tính `dailyNormalCount`/`dailyRetryCount` có đang đo cùng khái
   niệm với AI Studio usage hay không?
5. Vì sao một số request Render vẫn thành công giữa các đợt `429`?
6. Shared outbound IP/region của Render có phải giả thuyết hợp lý với bằng chứng
   hiện có hay chỉ là tương quan?
7. Dữ liệu bổ sung nào là tối thiểu để xác định quota dimension thật sự mà không
   làm tăng thêm tải production?

## 11. Tình trạng production khi kết thúc thu thập dữ kiện

Tại snapshot cuối:

```text
isMaintenancePaused=false
activeJobs=3
adaptive Gemini limit=1
```

Hệ thống vẫn chạy và có tiến độ xen kẽ, nhưng tỷ lệ `429` tích lũy từ lần restart
được quan sát là khoảng 90,89%.

Không có hotfix scheduler nào được sửa hoặc deploy trong quá trình lập tài liệu
Project 013. Commit production mới nhất liên quan sự cố vẫn là:

```text
5b1dbdf Add protected Gemini diagnostic probe
```

Phần trên là snapshot kết thúc **giai đoạn thu thập dữ kiện ban đầu**, không phải
trạng thái production khi đóng dự án. Bản vá và kết quả cuối được ghi tại mục 12.

## 12. Khắc phục, deploy và đóng dự án

### 12.1 Nguyên nhân phía ứng dụng đã xác định

Sự cố upstream ban đầu chỉ trả generic `429 RESOURCE_EXHAUSTED`, nên không thể chứng
minh quota dimension chính xác. Tuy nhiên code cũ chắc chắn đã khuếch đại lỗi:

1. Dispatcher dùng `maxLimit` thay cho adaptive `limit`, tiếp tục tạo nhiều logical
   stage khi limiter đã giảm.
2. Một logical stage có thể thử ba project liên tiếp; group rotation cho phép nhiều
   stage quét gần hết pool.
3. Global gate chỉ đóng khi counter nội bộ cho rằng toàn pool hết capacity; burst
   429 trên nhiều project chưa đủ để đóng sớm.
4. Stage đang chờ limiter không kiểm tra lại gate ngay trước reservation/API call.
5. Cooldown generic 429 cố định 60 giây, không có exponential backoff thích nghi,
   tạo các đợt retry đồng bộ.
6. Quota deferral return trước nhánh hibernation; maintenance cũ không ngăn active
   job bắt đầu stage tiếp theo.

Do đó kết luận kỹ thuật là: một đợt 429 tạm thời đã bị scheduler cũ khuếch đại thành
retry storm. Không có bằng chứng production cuối cùng cho thấy outbound IP Render bị
block.

### 12.2 Bản vá

Commit `0f739b1` được push lên `main` và Render khởi động instance mới tại
`2026-07-24T14:23:41.769Z`. Bản vá:

- dispatcher theo `limiter.limit` hiện tại;
- mở rate-limit circuit khi 5 project độc lập trả 429 trong cửa sổ 10 giây;
- kiểm tra lại gate sau khi limiter cấp permit, trước reservation/API call;
- global backoff 60 giây → 2 → 4 → 8 → tối đa 10 phút, có jitter giới hạn;
- cần 10 physical success liên tiếp để reset cấp backoff;
- cooldown riêng project tăng dần khi generic 429 không có `Retry-After`;
- persist project cooldown streak và global circuit qua Render restart;
- quota pool exhaustion hibernate queue theo cùng deadline circuit;
- maintenance pause cho request đang chạy hoàn tất nhưng suspend job ở ranh giới
  stage, persist về pending và không đi qua nhánh `CANCELLED`.

Schema bổ sung đều additive; không xóa hoặc rewrite job, chunk, source R2 hay artifact.

### 12.3 Kiểm thử và nghiệm thu production

- Backend regression: 185/185 test pass.
- Mô phỏng 30 logical stage, limiter 1, 100% 429: burst bị chặn trong tối đa 6
  physical attempt thay vì quét 50 project.
- Live maintenance:
  - `draining` → `drained`;
  - `activeJobs=0`, `activeStages=0`, `waitingStages=0`;
  - MongoDB `processing=0`, `failed=0`;
  - resume nhận lại 3 job và tiếp tục xử lý.
- Lease `processing` dư ngay sau instance replacement tự recover từ 4 về 3, khớp
  số active worker.

Snapshot cuối lúc `2026-07-24T14:36:20Z`:

| Chỉ số | Giá trị |
|---|---:|
| Readiness | `ready` |
| Logical-issued | 225 |
| Physical attempt | 226 |
| 429 | 0 |
| Amplification | 1,0044 |
| Circuit | `closed`; open count 0 |
| Terminal chunk | 45 |
| Trang hoàn tất | 83 |
| Job completed / failed | 45 / 0 |
| Source cloud safe | 113 / 113 |

Gate đóng dự án đạt: ≥200 logical-issued, ≥20 terminal chunk, amplification ≤1,15,
429 <1%, không mất job/artifact và maintenance drain hoạt động trên production.

### 12.4 Quyết định sau đóng

- Không chạy thêm diagnostic/A-B probe vì workload production thật đã cung cấp bằng
  chứng mạnh hơn với 0/225 response 429.
- Không coi generic 429 là bằng chứng project hết RPD hoặc IP bị block.
- Nếu 429 tái phát, dùng circuit/status/metrics và runbook trong
  `.codex/knowledge/operations.md`; không tăng pool/concurrency để “thử”.
- Project 013 được chuyển vào `archive/project-013/`. Tài liệu trong archive là bằng
  chứng lịch sử; kiến trúc và vận hành hiện hành nằm trong `.codex/knowledge/`.
