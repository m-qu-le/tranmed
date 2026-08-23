[CmdletBinding()]
param(
    [string]$DataRoot = 'D:\StudyMedData',
    [int]$Port = 8080,
    [switch]$OpenBrowser,
    [switch]$DashboardOnce
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$backendRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $backendRoot
$frontendRoot = Join-Path $workspaceRoot 'med-translator-frontend'
$envFile = Join-Path $backendRoot '.env.local'
$resolvedDataRoot = [IO.Path]::GetFullPath($DataRoot)
$lockPath = Join-Path $resolvedDataRoot '.launcher.lock'
$logsPath = Join-Path $resolvedDataRoot 'logs'
$lockOwned = $false
$process = $null

function Get-LockProcess {
    if (-not (Test-Path -LiteralPath $lockPath)) { return $null }
    try {
        $record = Get-Content -Raw -LiteralPath (Join-Path $lockPath 'launcher.json') | ConvertFrom-Json
        return Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
    } catch { return $null }
}

function Rotate-Log([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if ((Get-Item -LiteralPath $Path).Length -lt 10MB) { return }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Move-Item -LiteralPath $Path -Destination "$Path.$stamp" -ErrorAction Stop
}

function Ensure-MaintenanceToken {
    $content = Get-Content -Raw -LiteralPath $envFile
    $match = [regex]::Match($content, '(?m)^MAINTENANCE_CONTROL_TOKEN=(.*)$')
    if ($match.Success -and $match.Groups[1].Value.Trim() -and $match.Groups[1].Value.Trim() -ne '__GENERATE_ON_FIRST_START__') {
        return
    }

    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = [Convert]::ToHexString($bytes).ToLowerInvariant()
    $line = "MAINTENANCE_CONTROL_TOKEN=$token"
    $updated = if ($match.Success) {
        [regex]::Replace($content, '(?m)^MAINTENANCE_CONTROL_TOKEN=.*$', $line)
    } else {
        "$content`r`n$line`r`n"
    }
    Set-Content -LiteralPath $envFile -Value $updated -NoNewline
}

try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Không tìm thấy Node.js trên PATH.' }
    if (-not (Test-Path -LiteralPath $envFile)) {
        throw "Thiếu $envFile. Hãy copy .env.local.example thành .env.local. Gemini credentials được đọc từ .env hiện hữu; token local sẽ tự sinh khi khởi chạy."
    }
    Ensure-MaintenanceToken
    if (-not (Test-Path -LiteralPath (Join-Path $backendRoot 'node_modules'))) { throw 'Backend chưa có dependencies. Chạy npm ci trong med-translator-backend một lần.' }
    if (-not (Test-Path -LiteralPath (Join-Path $frontendRoot 'node_modules'))) { throw 'Frontend chưa có dependencies. Chạy npm ci trong med-translator-frontend một lần.' }

    New-Item -ItemType Directory -Path $resolvedDataRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $logsPath -Force | Out-Null
    if (Test-Path -LiteralPath $lockPath) {
        $running = Get-LockProcess
        if ($running) { throw "StudyMed local đang chạy (PID $($running.Id)). Dùng Stop-StudyMedLocal.ps1 để dừng an toàn." }
        Remove-Item -LiteralPath $lockPath -Recurse -Force
    }
    New-Item -ItemType Directory -Path $lockPath -ErrorAction Stop | Out-Null
    $lockOwned = $true

    $mongoService = Get-Service -Name 'MongoDB' -ErrorAction SilentlyContinue
    if (-not $mongoService) { throw 'Không tìm thấy Windows service MongoDB. Cài MongoDB Community (loopback-only) trước khi chạy launcher.' }
    $mongoStartedByLauncher = $false
    if ($mongoService.Status -ne 'Running') {
        Start-Service -Name 'MongoDB'
        $mongoStartedByLauncher = $true
    }

    # Always build the production SPA: it prevents a source update from being
    # silently paired with a stale dist directory.
    $env:VITE_RUNTIME_MODE = 'local'
    Push-Location $frontendRoot
    try { & npm.cmd run build } finally { Pop-Location }

    $stdout = Join-Path $logsPath 'backend.out.log'
    $stderr = Join-Path $logsPath 'backend.err.log'
    Rotate-Log $stdout
    Rotate-Log $stderr
    $env:RUNTIME_MODE = 'local'
    $env:PORT = [string]$Port
    $env:DATA_ROOT = $resolvedDataRoot
    $process = Start-Process -FilePath 'node.exe' -ArgumentList '--max-old-space-size=1536', 'src/server.js' -WorkingDirectory $backendRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $process.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
    @{ pid = $process.Id; port = $Port; mongoStartedByLauncher = $mongoStartedByLauncher; startedAt = (Get-Date).ToString('o') } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $lockPath 'launcher.json') -NoNewline

    $ready = $false
    foreach ($attempt in 1..60) {
        Start-Sleep -Seconds 1
        if ($process.HasExited) { throw "Backend đã dừng khi khởi động. Xem $stderr" }
        try {
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/readiness" -TimeoutSec 2
            if ($response.status -eq 'ready' -and $response.runtimeMode -eq 'local') { $ready = $true; break }
        } catch { }
    }
    if (-not $ready) { throw "Backend không đạt readiness trong 60 giây. Xem $stderr" }
    $lockOwned = $false
    Write-Host "StudyMed local sẵn sàng tại http://127.0.0.1:$Port (PID $($process.Id))."
    if ($OpenBrowser) { Start-Process "http://127.0.0.1:$Port" }
    $dashboardArguments = @{ DataRoot = $resolvedDataRoot; Port = $Port; Once = $DashboardOnce }
    try {
        & (Join-Path $PSScriptRoot 'Show-StudyMedLocalDashboard.ps1') @dashboardArguments
    } catch {
        Write-Warning "Dashboard không thể tiếp tục: $($_.Exception.Message)"
        Write-Host 'Backend vẫn chạy. Dùng Open StudyMed Local.cmd để mở UI hoặc Stop StudyMed Local.cmd để dừng.' -ForegroundColor Yellow
    }
} catch {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    if ($lockOwned -and (Test-Path -LiteralPath $lockPath)) { Remove-Item -LiteralPath $lockPath -Recurse -Force }
    throw
}
