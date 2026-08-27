$root = $PSScriptRoot
$pidFile = Join-Path $root "serve.pid"

if (-not (Test-Path $pidFile)) {
  Write-Output "No serve.pid found - nothing tracked as running."
  exit
}

$trackedPid = Get-Content $pidFile -ErrorAction SilentlyContinue
if ($trackedPid -and (Get-Process -Id $trackedPid -ErrorAction SilentlyContinue)) {
  Stop-Process -Id $trackedPid -Force
  Write-Output "Stopped PID $trackedPid."
} else {
  Write-Output "PID $trackedPid isn't running (already stopped)."
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
