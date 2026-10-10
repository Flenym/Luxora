# Starts the Luxora API with the local media stack (LiveKit, coturn, TLS) and
# publishes the API through CloudPub. Run via start.bat.
#
# Order: Docker media stack -> API (port 2222) -> CloudPub publish.
# The public API origin is written to data\public-origins.txt.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Say([string]$text) { Write-Host "[Luxora] $text" }

$clo = Join-Path $env:LOCALAPPDATA "cloudpub\clo.exe"
if (-not (Test-Path $clo)) {
  Say "CloudPub CLI not found at $clo."
  exit 1
}

$dataDir = Join-Path $root "data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

# 1. Media secrets: generated once, kept local (data is gitignored).
$mediaEnv = Join-Path $dataDir "media.env"
if (-not (Test-Path $mediaEnv)) {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  function New-Secret([int]$n) {
    $b = New-Object byte[] $n
    $rng.GetBytes($b)
    [Convert]::ToBase64String($b).TrimEnd("=").Replace("+", "-").Replace("/", "_")
  }
  $lines = @(
    "LIVEKIT_API_KEY=lkdev$(New-Secret 8)",
    "LIVEKIT_API_SECRET=$(New-Secret 40)",
    "TURN_SHARED_SECRET=$(New-Secret 40)",
    "TURN_RELAY_MIN_PORT=54000",
    "TURN_RELAY_MAX_PORT=54040"
  )
  $lines | Set-Content -Path $mediaEnv -Encoding ascii
  Say "Generated media secrets in data\media.env"
}
Get-Content $mediaEnv | ForEach-Object {
  if ($_ -match '^([A-Z0-9_]+)=(.*)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] }
}

# 2. Media stack (Docker).
Say "Starting media stack (LiveKit, coturn, TLS proxy)..."
docker compose -f docker-compose.calls.yml up -d | Out-Null
if ($LASTEXITCODE -ne 0) {
  Say "Docker failed. Start Docker Desktop and run start.bat again."
  exit 1
}

# Trust the local TLS proxy certificate (for Node and the browser).
$caFile = Join-Path $dataDir "caddy-root.crt"
# docker cp reports success on stderr. With ErrorActionPreference=Stop, PowerShell
# 5.1 treats that as a failure, so this step runs with Continue and checks the file.
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
for ($i = 0; $i -lt 30; $i++) {
  cmd /c "docker cp luxora-calls-tls-1:/data/caddy/pki/authorities/local/root.crt `"$caFile`" >nul 2>&1"
  if ((Test-Path $caFile) -and ((Get-Item $caFile).Length -gt 0)) { break }
  Start-Sleep -Seconds 2
}
$ErrorActionPreference = $previousPreference
if (-not (Test-Path $caFile)) {
  Say "Could not read the TLS proxy certificate. Check that the luxora-calls-tls-1 container is running."
  exit 1
}
cmd /c "certutil -user -addstore Root `"$caFile`" >nul 2>&1"

# 3. API with the calls media plane configured.
cmd /c "npm --prefix packages/protocol run build" | Out-Null
cmd /c "npm --prefix services/api run build" | Out-Null

$env:CALLS_LIVEKIT_URL = if ($env:LIVEKIT_URL) { $env:LIVEKIT_URL } else { "wss://localhost:7443" }
$env:CALLS_LIVEKIT_API_KEY = $env:LIVEKIT_API_KEY
$env:CALLS_LIVEKIT_API_SECRET = $env:LIVEKIT_API_SECRET
$env:CALLS_TURN_SHARED_SECRET = $env:TURN_SHARED_SECRET
$env:CALLS_TURN_URLS = if ($env:TURN_URLS) { $env:TURN_URLS } else { "turn:localhost:3478?transport=udp" }
$env:NODE_EXTRA_CA_CERTS = $caFile

Say "Starting API on http://127.0.0.1:2222 ..."
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-server.ps1" `
  -WorkingDirectory $root -WindowStyle Minimized | Out-Null

# 4. CloudPub: publish the API on port 2222.
$logged = (& $clo ls 2>&1 | Out-String)
if ($logged -match "not logged|login required|unauthorized") {
  Say "CloudPub is not logged in. Run once:  `"$clo`" login   then start.bat again."
  exit 1
}

# Publish only when the service is not already online: a second publish of the
# same port closes the working tunnel ("channel closed by a new agent").
$existing = (& $clo ls 2>&1 | Out-String)
if ($existing -notmatch "online .*luxora-api") {
  & $clo publish http 2222 --name luxora-api 2>&1 | Out-Null
  Start-Sleep -Seconds 5
}

$listing = (& $clo ls 2>&1 | Out-String)
# Take the URL from the luxora-api line only (other tunnels are listed too).
$line = ($listing -split "`n" | Where-Object { $_ -match "luxora-api" } | Select-Object -First 1)
$match = [regex]::Match([string]$line, "https://[A-Za-z0-9.-]+")
if ($match.Success) {
  $apiOrigin = $match.Value
  Set-Content -Path (Join-Path $dataDir "public-origins.txt") -Value $apiOrigin -Encoding ascii
  Say "Public API URL: $apiOrigin"
} else {
  Say "CloudPub did not return a URL. See: `"$clo`" ls"
}
Say "Done. Keep this window open. Ctrl+C stops the monitor."
