# PROJECT 003 — Phân tích canary production PDF dài

Ngày chạy: 16-07-2026
Job: `14d027c5-b5ae-4a39-a351-8d5079cd8457`
Pipeline: B4 gia cố, `quality` / `p003-v2` / `p003-prompts-v2`
Phạm vi báo cáo: chỉ thống kê và metadata; không chứa nội dung PDF, bản dịch, context passport hoặc excerpt lỗi.

## Kết luận

Canary production đã chạy hết 77 trang thành 39 chunk và không mất kết quả khi resume. Context toàn tài liệu, audit coverage chi tiết, repair có giới hạn, cảnh báo page range, preview/download và cleanup R2 đều hoạt động như thiết kế.

Kết quả cũng chỉ ra một giới hạn quan trọng: `37 passed / 2 needs_review` là kết quả theo policy hiện tại, không phải 37 chunk hoàn toàn sạch lỗi. Chỉ 28 chunk có báo cáo cuối `PASS`; 9 chunk còn lại được đánh dấu `passed` dù báo cáo cuối `FAIL` vì chỉ còn lỗi `minor` (tổng 13 lỗi minor). Vì vậy không nên trình bày tỷ lệ 94,9% như tỷ lệ dịch chính xác tuyệt đối.

## Quy mô và vận hành

- PDF nguồn: 77 trang, 4.702.262 byte, chia 39 chunk hai trang (chunk cuối một trang).
- Thời gian wall-clock: 35 phút 36,847 giây.
- Tổng 163 model call: 1 context, 156 call bốn stage bắt buộc và 6 call repair/reverify.
- Tổng usage: 939.969 input token, 422.471 output token, 470.929 thinking token, 1.833.369 total token.
- Call chậm nhất: translate 99.827 ms, dưới timeout 180 giây.
- Bảy key nhận 22–25 call/key; không key bị disable.
- Sau 27 chunk có một `GEMINI_SCHEMA_INVALID`; job chuyển về pending rồi attempt 2 resume từ artifact đã persist và hoàn tất 39/39.
- Source R2 đã xóa; cleanup/upload backlog bằng 0. Job khoảng 5,5 KB, context khoảng 3,7 KB, tổng 39 document chunk khoảng 1,10 MB theo JSON byte gần đúng.
- Preview và download đều 521.538 ký tự, SHA-256 cùng `30cd4a51762945c8d91cea02375948c2eb43314343fe9b2578f854cef636acdd`.

## Context và coverage

- Context passport được tạo một lần bằng toàn PDF: 10 thuật ngữ, 9 chữ viết tắt, 4 quy tắc nhất quán, 4 ghi chú rủi ro và một mô tả trọng tâm tài liệu.
- Context call: 22.151 ms, 42.228 input token, 45.183 total token.
- Audit có coverage `COMPLETE` ở 39/39 chunk, tổng 747 checkpoint, trung bình 19,15 và khoảng 5–23 checkpoint/chunk.
- Verify có coverage `COMPLETE` ở 38/39 chunk, tổng 766 checkpoint, trung bình 19,64 và khoảng 6–25 checkpoint/chunk.
- Public API chỉ lộ summary và page range cảnh báo; không lộ context, report riêng, excerpt hay cách sửa.

## Lỗi được phát hiện và hiệu chỉnh

Audit đầu tiên ghi nhận 84 finding trên 39 chunk, thay vì chỉ 1–2 finding cho cả file:

| Mức độ | Audit | Verify sau revise |
| --- | ---: | ---: |
| Critical | 5 | 2 |
| Major | 24 | 3 |
| Minor | 55 | 14 |
| Tổng | 84 | 19 |

Theo category ở audit: terminology 41, mistranslation 29, omission 5, addition 3, formatting 3, number/unit 2 và table/figure 1. Số finding ở verify giảm từ 84 xuống 19 sau revise, nhưng đây là hai lượt đánh giá độc lập nên chỉ là tín hiệu cải thiện, không phải phép đo chính xác rằng 65 lỗi đã được sửa một-một.

Ba chunk có lỗi blocking và coverage đầy đủ đi qua repair/reverify: một chunk đạt PASS, một chunk chỉ còn minor và được policy hiện tại cho passed, một chunk vẫn còn major nên cần review. Một chunk khác có coverage verify không đầy đủ nên được đưa thẳng vào review thay vì tự sửa dựa trên báo cáo thiếu.

## Hai vùng bắt buộc review thủ công

1. Trang 25–26 (chunk 12): audit ban đầu có hai lỗi minor; verify phát hiện một mistranslation major; sau repair, reverify vẫn phát hiện một terminology major và coverage `INCOMPLETE`.
2. Trang 35–36 (chunk 17): audit có hai terminology major; verify có một addition major và một omission critical, đồng thời coverage `INCOMPLETE`; hệ thống dừng ở `needs_review` và không tự cho qua.

## Điểm cần hiểu đúng trước khi sử dụng

- Pipeline mới đã giải quyết đúng lo ngại “mỗi file chỉ bắt 1–2 lỗi”: riêng file này audit tạo 84 finding và 747 checkpoint.
- Self-audit bằng cùng họ model vẫn không chứng minh mọi lỗi thực tế đã được tìm ra. Hai vùng `needs_review` chắc chắn cần người có chuyên môn kiểm tra; các chunk passed vẫn không nên được quảng bá là “đã kiểm chứng hoàn toàn”.
- Policy hiện tại cố ý không repair lỗi minor, nhưng việc gắn nhãn `passed` cho báo cáo cuối `FAIL` dễ gây hiểu nhầm. Nếu tiếp tục phát triển sau đợt phân tích này, nên tách `passed_clean` khỏi `passed_with_minor_warnings`, hoặc hiển thị cảnh báo minor thay vì gộp cả hai.
- Theo quyết định của chủ dự án, không chạy batch nhiều PDF hoặc benchmark production lớn hơn sau canary này.
