[CmdletBinding()]
param(
    [string]$DataRoot = 'D:\StudyMedData',
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$backendRoot = Split-Path -Parent $PSScriptRoot
$resolvedDataRoot = [IO.Path]::GetFullPath($DataRoot)
$lockPath = Join-Path $resolvedDataRoot '.launcher.lock'
$envFile = Join-Path $backendRoot '.env.local'

if (-not (Test-Path -LiteralPath $lockPath)) { Write-Host 'StudyMed local không có launcher lock.'; exit 0 }
$record = Get-Content -Raw -LiteralPath (Join-Path $lockPath 'launcher.json') | ConvertFrom-Json
$process = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
if (-not $process) { Remove-Item -LiteralPath $lockPath -Recurse -Force; Write-Host 'Đã dọn launcher lock cũ.'; exit 0 }

try {
    if (-not (Test-Path -LiteralPath $envFile)) { throw 'Thiếu .env.local nên không thể gửi lệnh dừng an toàn.' }
    $tokenLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^MAINTENANCE_CONTROL_TOKEN=' } | Select-Object -First 1
    $token = ($tokenLine -split '=', 2)[1].Trim()
    if (-not $token -or $token -like 'replace_with_*') { throw 'MAINTENANCE_CONTROL_TOKEN local chưa hợp lệ.' }
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($record.port)/api/maintenance/shutdown" -Headers @{ 'X-Maintenance-Token' = $token } -TimeoutSec 10 | Out-Null
    $process.WaitForExit()
} catch {
    if (-not $Force) {
        throw "Không thể dừng an toàn: $($_.Exception.Message). Dùng -Force chỉ khi bạn chấp nhận job stage đang chạy sẽ được recover sau restart."
    }
    Stop-Process -Id $process.Id -Force
}

if ($record.mongoStartedByLauncher -eq $true) {
    Stop-Service -Name 'MongoDB' -ErrorAction Stop
}
Remove-Item -LiteralPath $lockPath -Recurse -Force
Write-Host 'StudyMed local đã dừng.'
