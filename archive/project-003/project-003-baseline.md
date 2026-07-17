# PROJECT 003 — Baseline khởi động

Ngày ghi nhận: 15-07-2026 (Asia/Saigon).

## Git và bảo toàn worktree

- Nhánh nguồn: `feat/project-002-r2-upload`.
- Commit nguồn: `a1c0bb1e905bffe2da63bab74acacdd60d094652` (`docs(P002-G10): record controlled restart recovery`).
- Nhánh làm việc: `feature/project-003-translation-quality`.
- P002 vẫn còn bước theo dõi production 24 giờ và đóng dự án chưa hoàn thành; P003 chỉ kế thừa commit code ổn định và không thay đổi bằng chứng vận hành P002.
- Trước khi tạo nhánh, worktree có ba file root đã bị xóa: `Kiến trúc hệ thống ứng dụng dịch file .txt`, `Mô tả bản thân .txt`, `implementation_plan.md`.
- Hồ sơ đóng `archive/project-003/project-003.md` và `samplepdf/` là dữ liệu có sẵn. P003 không khôi phục, xóa hoặc ghi đè các thay đổi này.
- `samplepdf/` và `.p003-local/` được ignore để PDF nguồn, prompt/response thô và bản dịch benchmark không bị commit nhầm.

## Môi trường và dependency

- Node.js: `v22.17.1`.
- npm: `10.9.2`.
- Backend dùng `@google/genai` cài thực tế phiên bản `1.52.0`; model cấu hình là `gemini-3.1-flash-lite`, timeout `180000 ms`, có 7 key được cấu hình. Chỉ số lượng key được ghi nhận, không đọc hoặc ghi giá trị secret.
- Frontend: React `19.2.5`, Vite `8.1.4`, Vitest `4.1.10`.
- `npm audit --omit=dev` backend: 0 vulnerability.
- `npm audit` frontend: 0 vulnerability.

## Kết quả baseline tự động

| Hạng mục | Kết quả |
| --- | --- |
| Backend `npm test` | 44 test pass, 0 fail |
| Frontend `npm test` | 3 file/9 test pass, 0 fail |
| Frontend `npm run lint` | Đạt, không có lỗi |
| Frontend `npm run build` | Đạt; 228 module; bundle JS 377,55 kB (gzip 119,57 kB) |

## Hành vi pipeline trước P003

- Worker cắt cố định 3 trang/chunk; helper `splitPdfToBuffers` có default riêng là 10 nhưng production truyền số 3 trực tiếp.
- Gemini dùng `temperature: 0.1`, không đặt `thinkingConfig`, không đặt output budget và chỉ kiểm tra `response.text` có rỗng hay không.
- Chưa kiểm tra `finishReason`, candidates/safety/block reason; chưa lưu token usage, model version hay latency theo stage.
- Mỗi request chọn key vòng tròn, nhưng với 429/5xx/network sẽ retry cùng key tối đa 3 lần sau 12/24/36 giây rồi mới chuyển key khác.
- Concurrency dịch chunk toàn cục hiện là 2.

Baseline thời gian/chunk, tỷ lệ 429, số call/chunk và response không `STOP` cần một lượt B0 thật qua API. Phần này chưa được suy diễn từ test unit và sẽ được ghi sau khi benchmark runner lưu artifact vào vùng local ignored.

## Bộ PDF mẫu

- Manifest tái tạo bằng `npm run manifest:p003` trong backend.
- Kết quả xác minh: 20 PDF, 370 trang, 21.662.171 byte (20,66 MiB).
- Vì mỗi PDF được cắt độc lập, tổng `ceil(pageCount / 2)` là **191 chunk**, không phải `ceil(370 / 2) = 185`.
- SHA-256, kích thước, số trang, số chunk và chuyên khoa suy ra từ tên nằm trong `archive/project-003/project-003-sample-manifest.json`; manifest không chứa nội dung PDF.
