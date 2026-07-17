# PROJECT 003 — Rà soát độc lập case Asthma

Ngày rà soát: 16-07-2026. Phạm vi: `78 Asthma.pdf`, trang 5–6; so sánh PDF nguồn với B3 high một lượt và B4 sau coverage guard. Báo cáo chỉ giữ nhận định ngắn, không chép toàn bộ nguồn hoặc bản dịch.

## Kết quả

1. **Terminology/mechanism — major, hợp lệ.** Câu về ipratropium mô tả cơ chế đối kháng acetylcholine tại thụ thể muscarinic. Cả B3 và B4 đều diễn đạt theo hướng thuốc “gắn vào acetylcholine”, có thể khiến người đọc hiểu sai đích gắn kết. B4 repair chưa sửa được lỗi này.
2. **Omission — major, hợp lệ.** Hình 78.1 có chỉ dẫn xem xét liệu pháp miễn dịch dị nguyên dưới da cho người bệnh hen dị ứng dai dẳng ở Steps 2–4. B3 chỉ giữ ghi chú bằng chứng liên quan; B4 giữ cảnh báo phản vệ chung nhưng không truyền đạt đầy đủ chỉ dẫn hành động này.
3. **Coverage regression cũ — đã khắc phục bằng code.** Artifact B4 trước guard co từ khoảng 13,9 KB ở revised xuống 5,4 KB ở repair. Sau guard 80%, rerun giữ 13,7 KB và coverage repair 100,8%; không còn thay bản đầy đủ bằng một subsection ngắn.

## Kết luận độc lập

- B4 **không chứng minh chất lượng tốt hơn B3 trong case Asthma**: hai lỗi major vẫn còn sau repair/reverify.
- B4 vẫn có lợi ích an toàn: phát hiện hai lỗi và trả `needs_review`, trong khi bản một lượt không có quality gate để cảnh báo người dùng.
- Case này không được dùng làm bằng chứng để bật quality mặc định. Chủ dự án/người có chuyên môn vẫn cần duyệt các khác biệt major khác và quyết định liệu warning có đủ đáp ứng mục tiêu sản phẩm hay không.
