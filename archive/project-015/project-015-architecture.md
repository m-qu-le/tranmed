# P015 — Kiến trúc local-first

## Kiến trúc đích

```text
Browser trên cùng máy
  └─ http://127.0.0.1:<port>
       └─ Node/Express
            ├─ phục vụ frontend production build
            ├─ API /api/translate
            ├─ queue + Gemini scheduler
            ├─ tối đa ba source lane + một PDF split lane
            ├─ D:\StudyMedData\sources + temp + logs
            ├─ MongoDB local (database P015 mới)
            └─ Gemini API qua Internet
```

Không dùng Caddy, DuckDNS, Vercel proxy, Render hoặc Koyeb trong runtime local.
Frontend và API cùng origin nên không cần production CORS hoặc Basic Auth. Boundary
bảo mật là loopback; đổi sang LAN/public access phải có dự án security riêng.

## Storage modes

Backend cần abstraction rõ ràng thay vì rải điều kiện platform trong controller:

| Mode | Source | Queue/state | Dùng khi |
| --- | --- | --- | --- |
| `local` | Filesystem D | MongoDB local | Runtime mặc định P015 |
| `cloud` | R2 | Atlas | Baseline Render/khôi phục web |

Không xóa `cloud` mode. Nó là đường quay lại web. Schema phải tiếp tục đọc được job
`storageProvider=r2` và job local; không rewrite dữ liệu cloud cũ.

## Quản lý tài nguyên

Máy có 7,7 GB RAM và CPU 2 core, nên P015 dùng ba lớp bảo vệ:

1. Giữ `TRANSLATION_WORKER_CONCURRENCY=3` như Render, nhưng serialize PDF splitting;
   các lane còn lại chủ yếu chờ Gemini và có thể bị admission governor tạm dừng.
2. Node chạy với process priority `BelowNormal` và V8 old-space target 1,5–2 GB.
3. Admission controller chỉ dùng system CPU để quyết định nhận job mới. Process RSS,
   available system memory và event-loop delay chỉ là telemetry trong status.

Ngưỡng active của profile backend server:

| Gate | Giá trị kế hoạch |
| --- | ---: |
| RSS / free RAM | Telemetry, không phải điều kiện admission |
| Dừng nhận job mới | System CPU ≥ 90% liên tục 15 giây |
| Hard pressure | Không dùng hard-pressure theo RAM |
| CPU pressure | System CPU ≥ 90% liên tục 15 giây |
| Resume | CPU < 75% và free RAM ≥ 256 MB liên tục 30 giây |
| Disk reserve | Luôn chừa ít nhất 10 GB trên volume dữ liệu |
| Parallel source budget | 15 MB như backend server trước đây; source lớn hơn chạy một mình |
| Upload limit | 159 MB; đây là validation gate, không phải kích thước workload mục tiêu |

Các ngưỡng là baseline để đo, không phải hằng số hardcode. UI/status phải công khai
lý do `LOCAL_RESOURCE_PRESSURE` nhưng không log file content hoặc secret.

Node `--max-old-space-size` vẫn không kiểm soát toàn bộ Buffer/native/worker memory;
RSS/free RAM chỉ được công khai để quan sát, không dừng queue.

## PDF memory model cần sửa

Code hiện đọc toàn bộ PDF, giữ document gốc và toàn bộ chunk buffers trong RAM. P015
phải chuyển dần sang xử lý theo page range/chunk tuần tự:

1. Đọc/parse source một lần trong PDF worker.
2. Tạo một chunk nhỏ, persist metadata hoặc chuyển sang pipeline.
3. Giải phóng buffer không còn dùng trước chunk kế tiếp.
4. Nếu vượt hard pressure, terminate worker và đưa job về trạng thái resource-blocked
   có hướng dẫn; không retry loop vô hạn.

PDF thông thường của owner khoảng 10 MB là workload nghiệm thu chính. File trên 25 MB
được đưa vào single-source mode và hiển thị cảnh báo; dung lượng file nén không phải
proxy chính xác cho RAM sau parse, nên upload thành công không đồng nghĩa chắc chắn
đủ tài nguyên để xử lý một PDF sát trần 159 MB.

## Database local

Để giảm phạm vi rewrite, P015 ưu tiên MongoDB Community local vì code hiện dùng
Mongoose sâu. MongoDB phải bind loopback, dùng database P015 mới và giới hạn
WiredTiger cache ở mức nhỏ (khởi đầu 0,25–0,5 GB). Không trỏ local worker vào Atlas
production trong khi test destructive.

Thay Mongo bằng SQLite là một dự án riêng vì cần viết lại query, indexes, atomic
claim/lease và migrations; không thuộc P015 baseline.
