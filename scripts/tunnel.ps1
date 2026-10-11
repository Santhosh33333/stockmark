# TradeMind — free public URL helper (Cloudflare quick tunnel, no account needed).
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\tunnel.ps1
# Starts cloudflared (must be on PATH or at $env:TEMP\cloudflared.exe), waits for
# the tunnel URL, prints it and saves it to data\tunnel.url. Re-run to restart.
# The URL is EPHEMERAL — it changes each run. For a permanent URL see DEPLOY.md.
$ErrorActionPreference = 'SilentlyContinue'
$exe = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($exe) { $bin = $exe.Source } else { $bin = "$env:TEMP\cloudflared.exe" }
if (-not (Test-Path $bin)) {
  Write-Host "cloudflared not found. Download it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
}

$port = if ($env:PORT) { $env:PORT } else { 5124 }
# Stop any previous quick tunnel started by this script (kept in data\tunnel.pid)
$pidFile = Join-Path $PSScriptRoot '..\data\tunnel.pid'
if (Test-Path $pidFile) {
  $old = [int](Get-Content $pidFile -Raw)
  Stop-Process -Id $old -Force -ErrorAction SilentlyContinue
  Remove-Item $pidFile -Force
}

$out = Join-Path $PSScriptRoot '..\data\tunnel.out.log'
$err = Join-Path $PSScriptRoot '..\data\tunnel.err.log'
Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
$p = Start-Process $bin -ArgumentList 'tunnel','--url',"http://127.0.0.1:$port",'--no-autoupdate' -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
$p.Id | Set-Content $pidFile

Write-Host "Waiting for tunnel (pid $($p.Id))…"
$url = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $err) {
    $m = Select-String -Path $err -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value; break }
  }
}
if ($url) {
  $url | Set-Content (Join-Path $PSScriptRoot '..\data\tunnel.url')
  Write-Host ""
  Write-Host "  Live URL: $url"
  Write-Host "  Stored in: data\tunnel.url  |  logs: data\tunnel.err.log"
  Write-Host "  Stop it with: Stop-Process -Id $($p.Id) -Force"
} else {
  Write-Host "Tunnel did not come up in 30s. Check data\tunnel.err.log. Server must be running first (npm start)."
}