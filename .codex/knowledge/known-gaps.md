# Giới hạn và rủi ro được chấp nhận

Cập nhật khi đóng PROJECT 001–005 ngày 18-07-2026.

## Chất lượng dịch

- AI tự audit không thể chứng minh bản dịch không còn lỗi thực tế. `passed` chỉ có nghĩa báo cáo cuối không phát hiện lỗi và coverage đầy đủ.
- `needs_review` cần người có chuyên môn kiểm tra; P004 chỉ công khai phần report cuối đã chọn và escape trong header, không công khai raw diagnostic hay toàn bộ artifact private.
- Canary PDF dài chạy trên `p003-v2` cho thấy 9 chunk từng được passed-with-minor. Policy đó đã bị thay bằng strict-pass `p003-v3`.
- `p003-v3` được khóa bằng backend 106/106 test và frontend 12/12 + lint/build; theo quyết định chủ dự án không chạy lại PDF dài hoặc batch nhiều PDF.
- Context passport giúp nhất quán xuyên chunk nhưng không phải glossary tuyệt đối; PDF chunk vẫn là nguồn quyết định.

## Bằng chứng vận hành được miễn

- Không có cửa sổ theo dõi production đủ 24 giờ cho v3.
- Không thực hiện live rollback drill sau khi bật quality mặc định.
- Không bổ sung số đo RAM/disk Render sau canary. Có số liệu local RSS/BSON, Mongo payload canary, source cleanup và backlog 0.
- Các mục trên được owner waiver tại D021 trong `archive/project-003/project-003.md`; không được diễn giải thành phép thử đã chạy.
- P005 không đọc trực tiếp biểu đồ peak RAM Render theo owner waiver. Canary production chỉ chứng minh peak hai job, tổng source active 3.101 byte trong budget 10 MiB, không crash/restart quan sát được và cleanup sạch.
- P005 không theo dõi concurrency 2 đủ 24 giờ và không chạy hai PDF lớn; source size vẫn chỉ là proxy bảo thủ cho RAM.

## Khoản nợ sản phẩm/kỹ thuật

- `frontend/src/App.jsx` vẫn lớn, nhiều inline style và `alert/confirm`.
- Preview/copy ghép nội dung trong RAM; tài liệu rất lớn nên ưu tiên streaming download.
- Không có authentication theo quyết định chủ dự án; endpoint công khai vẫn cần CORS, rate limit và validation chặt.
- AbortSignal không bảo đảm Gemini ngừng tính usage cho request đã nhận.
- Budget worker P005 dùng kích thước source làm proxy bảo thủ cho RAM; canary nhỏ không chứng minh hai PDF lớn có thể chạy song song.
- P007 áp dụng ưu tiên tuyệt đối theo yêu cầu: nếu priority được đưa vào liên tục, job thường có thể chờ vô hạn. Chỉ thay bằng quota/công bằng khi mở dự án mới và có quyết định owner.
- Thay đổi model, human-review workflow, translation memory hoặc monitoring dài hạn phải mở dự án mới, không tự nối lại P003.

## Nguồn sự thật

Mã nguồn hiện tại, `archive/project-003/project-003.md`, `archive/project-004/project-004.md` và `archive/project-005/project-005.md` ưu tiên hơn báo cáo lịch sử. Các report B4/v1/v2 là bằng chứng theo thời điểm, không mô tả đầy đủ semantics strict-pass v3, lớp cảnh báo P004 hoặc worker pool P005.
