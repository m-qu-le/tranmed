# PROJECT 003 — Hiệu năng và tài nguyên

Ngày đo: 2026-07-16. Phép đo không gọi Gemini mới; latency lấy từ 20 B4 artifact hiện hành, tài nguyên PDF đo bằng Worker thật.

## Hiệu năng

- B4 end-to-end quan sát trên 20 chunk: trung bình 1 phút, p95 1.4 phút, tối đa 1.5 phút/chunk.
- Mỗi chunk dùng trung bình 4.4 call; 20% mẫu cần repair/reverify.
- Với scheduler 2 chunk song song, 191 chunk được ngoại suy khoảng 99.3 phút theo chuỗi latency thực nghiệm; biên bảo thủ dùng p95 là 132.2 phút. Đây là ngoại suy, chưa phải một lượt live đủ 370 trang.
- Request Gemini quan sát tối đa 27 giây, thấp hơn timeout 180 giây. Lease 5 phút được heartbeat mỗi 60 giây, nên thời lượng toàn job không phụ thuộc một lease cố định.

## Tài nguyên

- PDF lớn nhất: `29. Osteoporosis Basic and Clinical Aspects.pdf`, 55 trang, 28 chunk; source 5.18 MiB, tổng buffer chunk trả về 7.11 MiB.
- Worker split mất 1028 ms; RSS process tăng tối đa 53.87 MiB, heap tăng 0.25 MiB trong lượt đo.
- BSON terminal trung bình 20 KiB/chunk; peak trung bình 53 KiB/chunk. Ước tính payload terminal cho 191 chunk là 3.76 MiB.
- PASS artifact không giữ draft/revised/repaired full-text; smoke production E011 cũng xác nhận cleanup. `needs_review` giữ artifact chẩn đoán theo thiết kế.

## Giới hạn và cổng còn lại

- BSON là payload document trước compression/index overhead; Mongo storage thực phải được theo dõi ở canary/batch.
- RSS trên máy local không thay thế Render metrics. Cần xác nhận lại bằng một PDF dài ở canary và theo dõi production 24 giờ.
- Báo cáo này là phép ngoại suy trước full-corpus. Lượt live sau đó đã hoàn tất và được tổng hợp tại `archive/project-003/project-003-full-corpus-report.md`; số liệu Render/Mongo thực vẫn chờ canary.
