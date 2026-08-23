[CmdletBinding()]
param(
    [int]$Port = 8080
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$url = "http://127.0.0.1:$Port"

try {
    $readiness = Invoke-RestMethod -Uri "$url/api/readiness" -TimeoutSec 3
    if ($readiness.status -ne 'ready' -or $readiness.runtimeMode -ne 'local') {
        throw 'StudyMed local chưa sẵn sàng.'
    }
} catch {
    Write-Host 'StudyMed local chưa chạy hoặc chưa sẵn sàng. Hãy chạy Start StudyMed Local.cmd trước.' -ForegroundColor Yellow
    exit 1
}

Start-Process $url
Write-Host "Đã mở StudyMed local tại $url bằng trình duyệt mặc định." -ForegroundColor Green
