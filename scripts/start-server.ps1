# Luxora local API server launcher (used by start.bat).
# Runs the Beta-0.1 API on port 2222 with persisted local secrets.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step-Message([string]$text) {
  Write-Host "[Luxora] $text"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "[Luxora] Node.js not found. Install Node 22+ from https://nodejs.org" -ForegroundColor Red
  exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "[Luxora] npm not found." -ForegroundColor Red
  exit 1
}

Step-Message "Workspace: $root"

if (-not (Test-Path "packages\protocol\node_modules")) {
  Step-Message "Installing protocol dependencies..."
  cmd /c "npm --prefix packages/protocol ci --no-audit --no-fund"
  if ($LASTEXITCODE -ne 0) { exit 1 }
}
if (-not (Test-Path "services\api\node_modules")) {
  Step-Message "Installing API dependencies..."
  cmd /c "npm --prefix services/api ci --no-audit --no-fund"
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

Step-Message "Building protocol..."
cmd /c "npm --prefix packages/protocol run build"
if ($LASTEXITCODE -ne 0) { exit 1 }
Step-Message "Building API..."
cmd /c "npm --prefix services/api run build"
if ($LASTEXITCODE -ne 0) { exit 1 }

$dataDir = Join-Path $root "data"
if (-not (Test-Path $dataDir)) {
  New-Item -ItemType Directory -Path $dataDir | Out-Null
}

$envFile = Join-Path $dataDir "luxora-server.env"
if (-not (Test-Path $envFile)) {
  Step-Message "First run: generating local secrets in data\luxora-server.env (never committed)."
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  function New-Secret([int]$bytes) {
    $buf = New-Object byte[] $bytes
    $rng.GetBytes($buf)
    return [Convert]::ToBase64String($buf).TrimEnd('=').Replace('+','-').Replace('/','_')
  }
  $jwt = New-Secret 48
  $dataKey = New-Secret 32
  $phoneHmac = New-Secret 48
  $otp = (Get-Random -Minimum 0 -Maximum 1000000).ToString("D6")
  $lines = @(
    "JWT_SECRET=$jwt",
    "LUXORA_DATA_ENCRYPTION_KEY=$dataKey",
    "LUXORA_PHONE_HMAC_SECRET=$phoneHmac",
    "LUXORA_DEV_OTP_CODE=$otp"
  )
  $lines | Set-Content -Path $envFile -Encoding ascii
  Step-Message "Local development OTP code for phone login: $otp (stored in data\luxora-server.env)"
}

$secrets = @{}
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^([A-Z0-9_]+)=(.*)$') {
    $secrets[$Matches[1]] = $Matches[2]
  }
}
if ($secrets.Keys.Count -lt 4) {
  Write-Host "[Luxora] Secrets file is damaged. Delete data\luxora-server.env and start again." -ForegroundColor Red
  exit 1
}

$env:NODE_ENV = "development"
$env:HOST = "127.0.0.1"
$env:PORT = "2222"
$env:DATABASE_PATH = "data/luxora.db"
$env:STORAGE_DRIVER = "local"
$env:STORAGE_LOCAL_PATH = "data/blobs"
$env:UPLOAD_STAGING_PATH = "data/uploads"
$env:JWT_SECRET = $secrets["JWT_SECRET"]
$env:DATA_ENCRYPTION_KEYS = ('{"main":"' + $secrets["LUXORA_DATA_ENCRYPTION_KEY"] + '"}')
$env:ACTIVE_DATA_ENCRYPTION_KEY_ID = "main"
$env:PHONE_AUTH_ENABLED = "true"
$env:PHONE_AUTH_PROVIDER = "development"
$env:PHONE_AUTH_HMAC_SECRET = $secrets["LUXORA_PHONE_HMAC_SECRET"]
$env:PHONE_AUTH_DEVELOPMENT_CODE = $secrets["LUXORA_DEV_OTP_CODE"]
$env:PHONE_AUTH_RECOVERY_DELAY_SECONDS = "0"
$env:PHONE_AUTH_RECOVERY_TTL_SECONDS = "86400"
$env:CORS_ORIGINS = "http://localhost:4173,http://localhost:5173,http://localhost:3000,http://127.0.0.1:4173"

Step-Message "Starting API on http://127.0.0.1:2222 (Ctrl+C to stop)"
node --enable-source-maps services/api/dist/server.js
