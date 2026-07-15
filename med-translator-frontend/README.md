# StudyMed Translator — Frontend

React/Vite client cho hệ thống dịch PDF y khoa. Frontend giữ nhiều PDF trong Local Queue và chỉ gửi một file khi backend báo còn dung lượng, nhằm tránh làm đầy filesystem 500 MB của Render.

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

Không F5 hoặc đóng tab khi Local Queue còn file chưa gửi. Trình duyệt sẽ cảnh báo vì đối tượng File chưa upload không thể tự phục hồi sau khi tải lại trang.
