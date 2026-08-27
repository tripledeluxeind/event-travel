$root = $PSScriptRoot
$log = Join-Path $root "serve.log"
$errLog = Join-Path $root "serve.err.log"
$pidFile = Join-Path $root "serve.pid"

if (Test-Path $pidFile) {
  $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Write-Output "Already running (PID $oldPid). Use stop-server.ps1 first if you want to restart it."
    exit
  }
}

if (Test-Path $log) { Remove-Item $log -Force }
if (Test-Path $errLog) { Remove-Item $errLog -Force }

$proc = Start-Process -FilePath "powershell.exe" `
  -ArgumentList "-ExecutionPolicy Bypass -NoLogo -NonInteractive -File `"$root\serve.ps1`"" `
  -WindowStyle Hidden `
  -RedirectStandardOutput $log `
  -RedirectStandardError $errLog `
  -PassThru

$proc.Id | Out-File $pidFile -Encoding ascii

Start-Sleep -Seconds 1
try {
  $resp = Invoke-WebRequest -Uri "http://localhost:8837/index.html" -UseBasicParsing -TimeoutSec 3
  Write-Output "Server is up (PID $($proc.Id)) - http://localhost:8837 responded with $($resp.StatusCode)."
} catch {
  Write-Output "Started PID $($proc.Id), but http://localhost:8837 isn't responding yet."
  Write-Output "Check $log and $errLog for what happened."
}
