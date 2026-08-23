[CmdletBinding()]
param(
    [string]$DataRoot = 'D:\StudyMedData',
    [int]$Port = 8080,
    [int]$RefreshSeconds = 3,
    [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$apiBase = "http://127.0.0.1:$Port"

function Get-PropertyValue([object]$Object, [string]$Name, $Fallback = $null) {
    if ($null -eq $Object) { return $Fallback }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return $Fallback }
    return $property.Value
}

function Format-Bytes($Bytes) {
    if ($null -eq $Bytes) { return '-' }
    $value = [double]$Bytes
    if ($value -ge 1GB) { return ('{0:N1} GB' -f ($value / 1GB)) }
    if ($value -ge 1MB) { return ('{0:N0} MB' -f ($value / 1MB)) }
    return ('{0:N0} KB' -f ($value / 1KB))
}

function Clear-DashboardHost {
    try { Clear-Host } catch { }
}

function Get-LauncherPid {
    $lockFile = Join-Path ([IO.Path]::GetFullPath($DataRoot)) '.launcher.lock\launcher.json'
    if (-not (Test-Path -LiteralPath $lockFile)) { return '-' }
    try {
        return (Get-Content -Raw -LiteralPath $lockFile | ConvertFrom-Json).pid
    } catch {
        return '-'
    }
}

function Get-ApiJson([string]$Path) {
    return Invoke-RestMethod -Uri "$apiBase$Path" -TimeoutSec 2
}

function Get-DashboardSnapshot {
    try {
        return [pscustomobject]@{
            readiness = Get-ApiJson '/api/readiness'
            status = Get-ApiJson '/api/translate/status'
            stats = Get-ApiJson '/api/translate/jobs/stats'
            active = Get-ApiJson '/api/translate/jobs/active'
            failures = Get-ApiJson '/api/translate/jobs/terminal-failures?limit=1'
            error = $null
        }
    } catch {
        return [pscustomobject]@{
            readiness = $null
            status = $null
            stats = $null
            active = $null
            failures = $null
            error = $_.Exception.Message
        }
    }
}

function Write-Dashboard([object]$Snapshot) {
    Clear-DashboardHost
    Write-Host 'StudyMed Local — Dashboard dịch' -ForegroundColor Cyan
    Write-Host ("Cập nhật: {0}  |  Nhấn Q để đóng dashboard (backend vẫn chạy)." -f (Get-Date -Format 'HH:mm:ss')) -ForegroundColor DarkGray
    Write-Host ''

    if ($Snapshot.error) {
        Write-Host 'Không đọc được trạng thái backend.' -ForegroundColor Red
        Write-Host $Snapshot.error -ForegroundColor DarkYellow
        Write-Host ''
        Write-Host 'Dashboard sẽ tự thử lại; file Open chỉ mở UI, còn Stop mới dừng StudyMed.' -ForegroundColor DarkGray
        return
    }

    $status = $Snapshot.status
    $readiness = $Snapshot.readiness
    $stats = $Snapshot.stats
    $worker = $status.worker
    $dispatcher = $status.dispatcher
    $storage = $status.storage
    $resource = $status.resourceGovernor.snapshot
    $launcherPid = Get-LauncherPid
    $storageState = if ($readiness.storage.available) { 'sẵn sàng' } else { 'lỗi' }
    $maintenance = if ($status.isMaintenancePaused) { $status.maintenanceState } else { 'running' }

    Write-Host ("Dịch vụ : API/MongoDB sẵn sàng | Lưu trữ local {0} | PID {1}" -f $storageState, $launcherPid) -ForegroundColor Green
    Write-Host ("URL      : http://127.0.0.1:{0}  |  Hàng đợi: {1}" -f $Port, $maintenance)
    Write-Host ("Queue    : chờ {0} | đang dịch {1} | hoàn tất {2} | lỗi {3}" -f $stats.pending, $stats.processing, $stats.completed, $stats.failed)
    Write-Host ("Worker   : {0}/{1} job | Gemini stage: active {2}, chờ {3}" -f $worker.activeJobs, $worker.concurrency, $dispatcher.activeStages, $dispatcher.waitingStages)
    Write-Host ("Tài nguyên: CPU {0}% | RAM trống {1} | RSS backend {2} | Disk {3} (reserve {4})" -f $resource.systemCpuPercent, (Format-Bytes $resource.availableMemoryBytes), (Format-Bytes $resource.rssBytes), (Format-Bytes $storage.freeBytes), (Format-Bytes $storage.diskReserveBytes))

    $blockReason = Get-PropertyValue $dispatcher 'blockedReason'
    if ($status.isHibernating -or $blockReason) {
        $reason = if ($blockReason) { $blockReason } else { 'Gemini circuit đang hibernating' }
        Write-Host ("Chờ xử lý: {0}" -f $reason) -ForegroundColor Yellow
    }

    Write-Host ''
    Write-Host 'File đang dịch' -ForegroundColor Cyan
    $items = @($Snapshot.active.items)
    if ($items.Count -eq 0) {
        Write-Host '  Không có file nào đang dịch.' -ForegroundColor DarkGray
    } else {
        foreach ($job in $items) {
            $stage = Get-PropertyValue $job 'currentQualityStage'
            if (-not $stage) { $stage = Get-PropertyValue $job 'translationMode' 'đang chuẩn bị' }
            $total = Get-PropertyValue $job 'chunkCount' 0
            $completed = Get-PropertyValue $job 'completedChunks' 0
            $passed = Get-PropertyValue $job 'passedChunks' 0
            Write-Host ("  • {0} [{1}] — {2}; chunk {3}/{4}, đạt {5}" -f $job.originalName, $job.folderName, $stage, $completed, $total, $passed)
        }
    }

    Write-Host ''
    $failure = @($Snapshot.failures.items) | Select-Object -First 1
    if ($failure) {
        $message = [string](Get-PropertyValue $failure 'error' 'Không có chi tiết')
        if ($message.Length -gt 180) { $message = "$($message.Substring(0, 177))..." }
        Write-Host ("Lỗi gần nhất: {0} — {1}: {2}" -f $failure.originalName, $failure.errorCode, $message) -ForegroundColor Yellow
    } else {
        Write-Host 'Lỗi gần nhất: không có file lỗi terminal.' -ForegroundColor DarkGray
    }
}

function Test-QPressed {
    try {
        if (-not $Host.UI.RawUI.KeyAvailable) { return $false }
        $key = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
        return $key.Character -eq 'q' -or $key.Character -eq 'Q'
    } catch {
        return $false
    }
}

while ($true) {
    # The dashboard is only an observer.  A rendering problem must never turn
    # into a launcher failure that stops the already-ready backend.
    try {
        Write-Dashboard (Get-DashboardSnapshot)
    } catch {
        Clear-DashboardHost
        Write-Host 'Dashboard gặp lỗi hiển thị, nhưng backend vẫn đang chạy.' -ForegroundColor Yellow
        Write-Host $_.Exception.Message -ForegroundColor DarkYellow
    }
    if ($Once) { return }
    $deadline = (Get-Date).AddSeconds([Math]::Max(1, $RefreshSeconds))
    while ((Get-Date) -lt $deadline) {
        if (Test-QPressed) {
            Clear-DashboardHost
            Write-Host 'Đã đóng dashboard. Backend vẫn chạy; dùng Stop StudyMed Local.cmd để dừng an toàn.' -ForegroundColor Green
            return
        }
        Start-Sleep -Milliseconds 100
    }
}
