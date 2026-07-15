# PROJECT 003 — Báo cáo smoke benchmark B0–B4

Ngày chạy: 15-07-2026 (Asia/Saigon).

Phạm vi smoke: `321 Acute Kidney Injury.pdf`, SHA-256 nguồn `e8b95ca9f72ccce438ec98697f6c8e1ae82cbd91fc776b1a39c6e0571e1f6d92`. Đây là kiểm tra SDK/harness và chưa thay thế benchmark đại diện 20 PDF hoặc đánh giá chuyên môn mù.

Raw response, prompt ghép artifact và bản dịch nằm trong `.p003-local/benchmarks/`, đã bị Git ignore. Báo cáo này chỉ giữ metadata tổng hợp, không chứa nội dung sách hoặc bản dịch.

B1–B4 dùng đúng cùng byte PDF trang 1–2, SHA-256 `a5ce4d88df3ce567ba0da61d7bb183b41479b64bc3e0a4490b7fdcdd12fd0873`, và cùng system prompt nền SHA-256 `673f5dc4554a1fb9b80f9c767cf2c2e805ed62fd6b7b3d6f1c30c6333b803fce`.

## Single-pass

| Biến thể | Trang | Key index | Thinking | Latency | Input token | Output token | Thought token | Finish |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- |
| B0 | 1–3 | 0 | mặc định | 18.121 ms | 2.355 | 4.228 | không trả | STOP |
| B1 | 1–2 | 1 | MINIMAL | 13.562 ms | 1.795 | 4.215 | không trả | STOP |
| B2 | 1–2 | 2 | MEDIUM | 14.084 ms | 1.795 | 4.107 | không trả | STOP |
| B3 | 1–2 | 3 | HIGH | 21.068 ms | 1.795 | 4.000 | 1.958 | STOP |

Không có 429, auth error, retry, response rỗng hoặc finish reason khác `STOP` trong smoke này. Mỗi biến thể thành công sau một call.

## B4 nhiều stage

| Stage | Key index | Latency | Input token | Output token | Thought token | Kết quả |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| translate | 4 | 21.617 ms | 1.795 | 4.207 | 1.838 | STOP |
| medical_audit | 5 | 15.111 ms | 5.463 | 457 | 3.278 | FAIL, 3 lỗi có cấu trúc |
| revise | 6 | 15.113 ms | 5.816 | 4.211 | 1.165 | STOP |
| verify | 0 | 12.628 ms | 5.486 | 17 | 3.633 | PASS, 0 lỗi |

- Tổng thời gian model theo stage: 64.469 ms; thời gian tiến trình quan sát khoảng 66,4 giây.
- B4 dùng 4 call, không cần repair; `qualityStatus = passed` và `repairCount = 0`.
- JSON audit/verify đạt cả schema SDK lẫn validator nghiệp vụ ngay lần đầu.
- `thinkingLevel: HIGH`, `includeThoughts: false`, `responseMimeType: application/json`, `responseJsonSchema`, `finishReason`, `modelVersion` và usage metadata đều đã được xác minh bằng API thật với `@google/genai` 1.52.0.

## Cách chạy

Từ `med-translator-backend/`:

```powershell
npm run benchmark:p003 -- B0 "321 Acute Kidney Injury.pdf" 1 0 dry-run
npm run benchmark:p003 -- B3 "321 Acute Kidney Injury.pdf" 1 3
npm run benchmark:p003 -- B4 "321 Acute Kidney Injury.pdf" 1 4
```

Tham số positional lần lượt là `variant`, `fileName`, `startPage` 1-based, `firstKeyIndex` 0-based và tùy chọn `dry-run`. Runner không in bản dịch ra console và không ghi giá trị API key.

## Smoke profile production G2

`processTranslation` được gọi trực tiếp trên cùng PDF 2 trang với `mode: quality`. Kết quả: một chunk, 20.388 ms, `STOP`, 1.795 input token, 4.051 output token, 2.068 thought token, tổng 7.914 token. Callback nhận đủ metadata và 14.214 ký tự output; nội dung output không được in hoặc commit.
