# Giới hạn và rủi ro được chấp nhận

Cập nhật khi đóng PROJECT 001–003 và dọn codebase ngày 16-07-2026.

## Chất lượng dịch

- AI tự audit không thể chứng minh bản dịch không còn lỗi thực tế. `passed` chỉ có nghĩa báo cáo cuối không phát hiện lỗi và coverage đầy đủ.
- `needs_review` cần người có chuyên môn kiểm tra; UI chỉ cung cấp chunk/page range, không public private report.
- Canary PDF dài chạy trên `p003-v2` cho thấy 9 chunk từng được passed-with-minor. Policy đó đã bị thay bằng strict-pass `p003-v3`.
- `p003-v3` được khóa bằng backend 106/106 test và frontend 12/12 + lint/build; theo quyết định chủ dự án không chạy lại PDF dài hoặc batch nhiều PDF.
- Context passport giúp nhất quán xuyên chunk nhưng không phải glossary tuyệt đối; PDF chunk vẫn là nguồn quyết định.

## Bằng chứng vận hành được miễn

- Không có cửa sổ theo dõi production đủ 24 giờ cho v3.
- Không thực hiện live rollback drill sau khi bật quality mặc định.
- Không bổ sung số đo RAM/disk Render sau canary. Có số liệu local RSS/BSON, Mongo payload canary, source cleanup và backlog 0.
- Các mục trên được owner waiver tại D021 trong `archive/project-003/project-003.md`; không được diễn giải thành phép thử đã chạy.

## Khoản nợ sản phẩm/kỹ thuật

- `frontend/src/App.jsx` vẫn lớn, nhiều inline style và `alert/confirm`.
- Preview/copy ghép nội dung trong RAM; tài liệu rất lớn nên ưu tiên streaming download.
- Không có authentication theo quyết định chủ dự án; endpoint công khai vẫn cần CORS, rate limit và validation chặt.
- AbortSignal không bảo đảm Gemini ngừng tính usage cho request đã nhận.
- Thay đổi model, human-review workflow, translation memory hoặc monitoring dài hạn phải mở dự án mới, không tự nối lại P003.

## Nguồn sự thật

Mã nguồn hiện tại và `archive/project-003/project-003.md` ưu tiên hơn báo cáo lịch sử. Các report B4/v1/v2 là bằng chứng theo thời điểm, không mô tả đầy đủ semantics strict-pass v3.
