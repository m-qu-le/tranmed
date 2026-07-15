# PROJECT 003 — Rubric chấm mù bản dịch y khoa

Mỗi mẫu có bốn bản `A`–`D`; người chấm không được mở `answer-key.json` trước khi hoàn tất. Chấm từng lỗi độc lập theo nguồn PDF 2 trang tương ứng. Không cộng điểm văn phong để bù lỗi critical/major.

## Mức độ

- `critical`: có thể đảo quyết định/chống chỉ định, sai thuốc–liều–đơn vị, đảo phủ định hoặc quan hệ nhân quả gây hiểu sai nguy hiểm.
- `major`: làm sai hoặc mất một ý y khoa quan trọng, nhưng chưa đạt ngưỡng critical.
- `minor`: lỗi cục bộ không đổi ý y khoa, chủ yếu thuật ngữ phụ, độ tự nhiên hoặc định dạng.

## Danh mục lỗi

| Mã | Nội dung cần kiểm |
| --- | --- |
| `mistranslation` | Dịch sai nghĩa mệnh đề hoặc tác nhân–đích |
| `omission` | Bỏ sót câu, bảng, chú thích, nhãn hình hoặc dữ kiện |
| `addition` | Thêm kết luận/giải thích không có trong nguồn |
| `terminology` | Thuật ngữ y khoa Việt Nam sai hoặc không nhất quán |
| `negation_modality` | Sai phủ định, khả năng, mức độ chắc chắn/khuyến cáo |
| `causal_relation` | Đổi liên quan/tương quan thành nhân quả hoặc ngược lại |
| `number_unit` | Sai số, khoảng, liều, tần suất hoặc đơn vị |
| `fluency` | Câu khó hiểu/không tự nhiên nhưng chưa sai nghĩa |
| `table_figure` | Sai/bỏ bảng, tiêu đề, chú thích hoặc chữ trong hình |
| `markdown` | Heading, bảng hoặc cấu trúc Markdown hỏng |

## Phiếu cho mỗi bản

Ghi số lỗi `critical/major/minor` theo từng danh mục, sau đó ghi:

- Có response rỗng/cắt cụt/khác `STOP`: có/không.
- Có lỗi critical: có/không.
- Bản dùng được không cần sửa: có/không.
- Ghi chú tối đa 3 ví dụ ngắn; không sao chép dài nội dung sách.

Xếp hạng A–D chỉ là kết quả phụ. Quyết định production dựa trước hết vào số lỗi critical, rồi major, omission và number/unit; fluency chỉ dùng khi các lỗi nghĩa tương đương.
