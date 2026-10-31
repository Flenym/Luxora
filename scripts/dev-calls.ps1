# Local dev stack for manual call testing: LiveKit + coturn + Caddy (Docker),
# Luxora API (with calls media plane) and the web client.
# Development only. Secrets below are throwaway values for this machine.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:LIVEKIT_API_KEY = "lkdevkey"
$env:LIVEKIT_API_SECRET = "lkdevsecret-0123456789abcdef0123456789"
$env:TURN_SHARED_SECRET = "turndevsecret-0123456789abcdef0123456789"
$env:TURN_RELAY_MIN_PORT = "54000"
$env:TURN_RELAY_MAX_PORT = "54040"
# LiveKit delivers signed participant/room webhooks here (host API), which moves
# the call from connecting to active and ends it on media-plane disconnects.
$env:CALLS_WEBHOOK_URL = "http://host.docker.internal:8080/v1/internal/calls/livekit-webhook"

Write-Host "==> Docker: LiveKit, coturn, Caddy"
docker compose -f docker-compose.calls.yml up -d | Out-Null

Write-Host "==> Caddy root CA"
$ca = Join-Path $env:TEMP "luxora-caddy-root.crt"
for ($i = 0; $i -lt 20; $i++) {
  docker cp luxora-calls-tls-1:/data/caddy/pki/authorities/local/root.crt $ca 2>$null
  if ((Test-Path $ca) -and ((Get-Item $ca).Length -gt 0)) { break }
  Start-Sleep -Seconds 2
}

Write-Host "==> API build"
npm --prefix services/api run build | Out-Null

Write-Host "==> API start"
Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

$keyBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($keyBytes)
$dataKey = [Convert]::ToBase64String($keyBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")

$apiEnv = @{
  DATA_ENCRYPTION_KEYS = '{"k1":"' + $dataKey + '"}'
  ACTIVE_DATA_ENCRYPTION_KEY_ID = "k1"
  JWT_SECRET = "dev-only-secret-value-at-least-32-chars-long-xyz"
  DATABASE_PATH = (Join-Path $env:TEMP "luxora-manual.db")
  PORT = "8080"
  NODE_ENV = "development"
  CORS_ORIGINS = "http://localhost:4173,http://localhost:5173"
  CALLS_LIVEKIT_URL = "wss://localhost:7443"
  CALLS_LIVEKIT_API_KEY = $env:LIVEKIT_API_KEY
  CALLS_LIVEKIT_API_SECRET = $env:LIVEKIT_API_SECRET
  CALLS_TURN_SHARED_SECRET = $env:TURN_SHARED_SECRET
  CALLS_TURN_URLS = "turn:localhost:3478?transport=udp"
  NODE_EXTRA_CA_CERTS = $ca
}
Remove-Item (Join-Path $env:TEMP "luxora-manual.db*") -Force -ErrorAction SilentlyContinue
$apiArgs = $apiEnv.GetEnumerator() | ForEach-Object { "set `"$($_.Key)=$($_.Value)`"" }
$apiCmd = ($apiArgs -join " && ") + " && node services/api/dist/server.js"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $apiCmd -WorkingDirectory $root -WindowStyle Minimized | Out-Null

Write-Host "==> Web start (http://localhost:4173/app)"
# The web client must talk to this API directly (port 8080): the Vite proxy
# targets 127.0.0.1:2222, which is the calls-disabled QA instance.
$env:VITE_LUXORA_API = "http://localhost:8080"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run dev -- --port 4173 --strictPort" -WorkingDirectory (Join-Path $root "apps\web") -WindowStyle Minimized | Out-Null

Write-Host "==> Waiting for services"
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  try {
    $api = (Invoke-WebRequest -UseBasicParsing http://localhost:8080/v1/capabilities -TimeoutSec 3).StatusCode
    $web = (Invoke-WebRequest -UseBasicParsing http://localhost:4173/app -TimeoutSec 3).StatusCode
    if ($api -eq 200 -and $web -eq 200) { break }
  } catch { }
}
Write-Host "API: $api  Web: $web"
Write-Host "Open http://localhost:4173/app in two browser windows (two accounts)."
