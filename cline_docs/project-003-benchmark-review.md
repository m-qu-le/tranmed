# PROJECT 003 — Báo cáo benchmark 20 PDF và rà soát sơ bộ

Ngày chạy: 16-07-2026 (Asia/Saigon). Raw PDF con, prompt/response, bản dịch và answer key nằm trong `.p003-local/` được Git ignore. Báo cáo này chỉ chứa số liệu tổng hợp và không chép nội dung sách.

## Phạm vi và cổng tự động

- 20 PDF, mỗi PDF chọn một cặp 2 trang có nội dung; B0 giữ hành vi cũ 3 trang.
- 100 artifact: B0–B4, tất cả hoàn thành.
- B1–B4 của cả 20 PDF có cùng `inputSha256`; không còn sai lệch byte do thời điểm serialize PDF.
- 0 response rỗng, 0 finish reason khác `STOP`, 0 structured report hỏng sau rotation và 0 length anomaly ngoài trường hợp Asthma được pipeline tự gắn `needs_review`.
- 174 request attempt trong lượt tổng hợp hiện hành; phân bố theo key index là 23–26 attempt/key. Có 2 lượt 429 và 4 JSON sai schema; tất cả được chuyển key/retry hữu hạn, không có 5xx hoặc auth failure.

## Baseline và các biến thể

| Biến thể | Call thành công | Attempt | Latency TB/call | Input token TB | Output token TB | Thought token TB | Kết quả quality |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| B0 legacy, 3 trang | 20 | 20 | 14.719 ms | 2.244 | 4.486 | không trả | không audit |
| B1 minimal | 20 | 20 | 11.507 ms | 1.343 | 3.262 | không trả | không audit |
| B2 medium | 20 | 21 | 13.999 ms | 1.343 | 3.388 | 1.095 | không audit |
| B3 high | 20 | 21 | 21.009 ms | 1.343 | 3.416 | 3.699 | không audit |
| B4 pipeline high | 88 | 92 | 14.179 ms | 3.940 | 1.781 | 3.207 | 19 passed, 1 needs-review |

B0 thiết lập baseline vận hành: 1 call/chunk, latency trung bình 14,719 giây, 0 lượt 429 và 0 response khác `STOP` trên 20 mẫu. B4 tốn trung bình 4,4 call/mẫu do luôn chạy translate–audit–revise–verify và chỉ repair khi verify còn lỗi blocking.

## Kết quả pipeline B4

- 20 translate, 20 audit, 20 revise, 20 verify; 4 repair và 4 reverify.
- 19/20 mẫu đạt `passed`; `78 Asthma.pdf` trang 5–6 còn một omission major và một terminology minor sau repair nên được giữ ở `needs_review`.
- Theo chuyên khoa: nội tiết/xương 4/4 passed; thận 6/6; thần kinh 5/5; huyết học 1/1; dị ứng–miễn dịch 3/4 passed và 1 needs-review.
- Audit đầu ghi nhận 42 finding (13 major, 29 minor). Final verify/reverify còn 10 finding, trong đó 9 minor và 1 major. Minor đơn thuần không kích hoạt vòng repair.
- Normalizer production loại 100% horizontal rule độc lập trong B4, nhưng giữ separator của bảng Markdown. B1–B3 là output benchmark thô nên vẫn có vi phạm định dạng này.

## Fixture audit có chủ đích

Auditor được thử độc lập trên 5 bản sửa lỗi cục bộ từ cùng một PDF: bỏ đoạn, đảo phủ định/mức chắc chắn, đổi số–đơn vị, đổi liên quan thành nhân quả và thay sai thuật ngữ. Ngưỡng chấp nhận đặt trước là bắt ít nhất 4/5; kết quả bắt 5/5. Báo cáo công khai chỉ giữ category/severity; excerpt và draft lỗi nằm trong vùng ignored.

## Bộ chấm mù và nhận định Codex

`.p003-local/blind-review/` chứa 20 bộ A–D với thứ tự được xáo xác định, `blind-index.json` cho người chấm và `answer-key.json` để mở nhãn sau khi khóa phiếu. Rubric ưu tiên critical, major, omission và number/unit trước fluency.

Nhận định kỹ thuật sơ bộ: high thinking và pipeline chạy ổn định, strict validation/rotation hoạt động như thiết kế, B4 giảm lỗi blocking trên 19/20 mẫu và tự giữ lại đúng mẫu Asthma có dấu hiệu ngắn bất thường. Tuy nhiên audit/verify vẫn là cùng họ model với translator; số liệu này chưa thay thế chấm mù của chủ dự án/người có chuyên môn. Vì vậy chưa đủ bằng chứng để bật `quality` làm mặc định production; mode an toàn vẫn là `legacy` cho tới khi phiếu chấm mù và canary được duyệt.

Nguồn số liệu máy đọc: `cline_docs/project-003-benchmark-report.json`, `cline_docs/project-003-audit-fixture-report.json` và `cline_docs/project-003-benchmark-selection.json`.
