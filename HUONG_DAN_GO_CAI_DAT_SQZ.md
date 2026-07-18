# Hướng dẫn gỡ cài đặt sqz trên Windows

## Trạng thái cài đặt hiện tại

- Phiên bản: `sqz 1.3.0`
- Đã cài: `sqz.exe` và `sqz-mcp.exe`
- Thư mục cài đặt: `%LOCALAPPDATA%\Programs\sqz\bin`
- Đã thêm thư mục trên vào **User PATH**.
- Đã thêm server `sqz` vào cấu hình MCP global của Codex (`%USERPROFILE%\.codex\config.toml`).
- Chưa chạy `sqz init`.

## Gỡ bỏ an toàn

### 1. Tắt kết nối MCP trước

Đóng Codex/VS Code hoặc các client MCP đang chạy. Mở `%USERPROFILE%\.codex\config.toml`, sao lưu file, rồi xóa riêng bảng `[mcp_servers.sqz]`:

```toml
[mcp_servers.sqz]
command = "C:/Users/lequa/AppData/Local/Programs/sqz/bin/sqz-mcp.exe"
args = ["--transport", "stdio"]
enabled = true
```

Không xóa các bảng MCP khác. Khởi động lại client sau khi lưu.

Nếu đã chạy `sqz init` cho Codex hoặc công cụ khác, hãy dùng cơ chế gỡ hook của chính công cụ đó hoặc khôi phục bản sao lưu cấu hình. Không xóa mù toàn bộ file cấu hình vì có thể làm mất thiết lập khác.

### 2. Xóa sqz khỏi User PATH

Mở PowerShell mới và chạy:

```powershell
$sqzBin = Join-Path $env:LOCALAPPDATA "Programs\sqz\bin"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$newPath = (($userPath -split ";") | Where-Object { $_ -and $_ -ine $sqzBin }) -join ";"
[Environment]::SetEnvironmentVariable("Path", $newPath, "User")
```

Đóng các terminal cũ và mở lại terminal mới để PATH được cập nhật.

### 3. Xóa binary

Đảm bảo không còn tiến trình `sqz`, `sqz-mcp` hoặc client MCP đang dùng chúng, rồi chạy:

```powershell
$sqzBin = Join-Path $env:LOCALAPPDATA "Programs\sqz\bin"
Remove-Item -LiteralPath $sqzBin -Recurse -Force
```

Nếu Windows báo file đang được sử dụng, đóng VS Code/Codex và terminal rồi chạy lại bước này.

### 4. Xóa dữ liệu cục bộ (tùy chọn)

sqz có thể tạo cache, preset và thống kê trong `%USERPROFILE%\.sqz`. Chỉ xóa thư mục này nếu không cần giữ dữ liệu thống kê/cache:

```powershell
Remove-Item -LiteralPath (Join-Path $env:USERPROFILE ".sqz") -Recurse -Force -ErrorAction SilentlyContinue
```

Việc xóa dữ liệu này không thể hoàn tác; nên xem nội dung trước bằng `Get-ChildItem $env:USERPROFILE\.sqz -Force`.

## Kiểm tra sau khi gỡ

```powershell
Get-Command sqz,sqz-mcp -ErrorAction SilentlyContinue
Test-Path (Join-Path $env:LOCALAPPDATA "Programs\sqz\bin")
```

Kết quả mong đợi: không tìm thấy lệnh và thư mục cài đặt không còn tồn tại. Nếu đã cấu hình MCP, client cũng không còn entry `sqz` và khởi động bình thường.

## Lưu ý

- Gỡ package không tự động xóa cache/preset hoặc entry MCP; cần xử lý riêng như các bước trên.
- Không chạy `sqz init --global` nếu chỉ muốn thử trong một dự án; tùy chọn global có thể sửa cấu hình ở phạm vi user.
- Bản cài hiện tại dùng binary chính thức từ GitHub Releases của dự án `ojuschugh1/sqz`, không dùng gói npm cũ đã lỗi 404.

Tài liệu dự án: <https://github.com/ojuschugh1/sqz>
