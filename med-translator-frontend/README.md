# StudyMed Translator — Frontend

React/Vite client cho hệ thống dịch PDF y khoa. Frontend upload PDF trực tiếp lên Cloudflare R2 với concurrency 4, xác nhận từng lô qua backend và chỉ báo có thể đóng máy sau khi toàn batch đã an toàn trên Cloud.

## Chạy local

```powershell
Copy-Item .env.example .env.local
npm install
npm run dev
```

`VITE_API_URL` phải bao gồm `/api/translate`, ví dụ `http://localhost:8080/api/translate`.

## Kiểm tra

```powershell
npm test
npm run lint
npm run build
```

Không F5 hoặc đóng tab khi còn batch chưa được backend xác nhận `canCloseClient=true`. Khi banner “Đã lưu an toàn trên Cloud” xuất hiện, có thể đóng máy; Render tiếp tục dịch và giao diện sẽ phục hồi batch/job từ MongoDB khi mở lại.
