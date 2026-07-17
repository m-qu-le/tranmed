# PROJECT 003 — Full-corpus quality run

Ngày tổng hợp: 2026-07-16. Báo cáo không chứa nội dung PDF hoặc bản dịch.

## Kết quả

- Đủ 20 PDF, 370 trang, 191 chunk theo thứ tự 2 trang/chunk.
- 177 chunk PASS, 14 chunk `needs_review`, 50 chunk qua repair/reverify.
- 864 call thành công trên 905 attempt; lỗi theo status/code được tổng hợp trong JSON đi kèm.
- Coverage thấp nhất của revise là 91.8%; repair là 98.4%. Mọi artifact đều đạt guard 80%.

## Hiệu năng live

- End-to-end model latency trung bình 1.3 phút/chunk, p95 1.8 phút.
- Xếp latency của đủ 191 artifact lên 4 lane như runner: 62.8 phút model wall-time; theo production target 2 lane là 124.8 phút.
- Runner resume thực tế mất 52.4 phút vì chạy mới 148 chunk và tái sử dụng 43 checkpoint hợp lệ.
- Single call tối đa 42 giây, dưới timeout 180 giây.

## Hàng đợi review critical/major

- `27. Hormones and Disorders of Mineral Metabolism.pdf`, trang 61–62: major terminology.
- `28. Endocrine Functions of Bone.pdf`, trang 3–4: major terminology.
- `30. Rickets and Osteomalacia.pdf`, trang 17–18: major omission.
- `31. Kidney Stones.pdf`, trang 17–18: major terminology.
- `52. Pain Management.pdf`, trang 11–12: major mistranslation.
- `52. Pain Management.pdf`, trang 17–18: major terminology.
- `52. Pain Management.pdf`, trang 21–22: critical terminology, major terminology.
- `54. Principles of Neuroendovascular Therapy.pdf`, trang 23–24: major terminology.
- `55. Neurological Rehabilitation.pdf`, trang 17–18: major terminology.
- `55. Neurological Rehabilitation.pdf`, trang 23–24: major terminology.
- `78 Asthma.pdf`, trang 5–6: major terminology, major omission.
- `78 Asthma.pdf`, trang 7–8: major mistranslation.
- `319 Approach to the Patient with Renal Disease or Urinary Tract Disease.pdf`, trang 3–4: major formatting.
- `322 Chronic Kidney Disease.pdf`, trang 1–2: major terminology.

## Cổng rollout

- Chunk `needs_review` vẫn có final content nhưng bắt buộc hiển thị warning/page range.
- Cần duyệt các finding critical/major và canary production trước khi bật mặc định quality.
