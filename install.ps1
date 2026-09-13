<#
.SYNOPSIS
  Simorgh Grid — one-command installer for Windows.

.DESCRIPTION
  Brings the whole system up from a fresh clone:
    1. checks prerequisites and reports exactly what is missing
    2. creates .env with real generated secrets (never ships fixed ones)
    3. starts the stack
    4. waits for the database, runs migrations, seeds demo data
    5. verifies the API actually answers before claiming success
    6. prints the URLs and the sign-in account

  Safe to re-run. It will not overwrite an existing .env, and migrations are idempotent.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -NoSeed          # skip demo data (for a real deployment)
  .\install.ps1 -Rebuild         # force a rebuild of the images
  .\install.ps1 -Reset           # DESTROY all data and start clean
#>

[CmdletBinding()]
param(
  [switch]$NoSeed,
  [switch]$Rebuild,
  [switch]$Reset
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# ------------------------------------------------------------------------------------------------
# Output helpers
# ------------------------------------------------------------------------------------------------
function Write-Step  ($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok    ($m) { Write-Host "    [OK] $m" -ForegroundColor Green }
function Write-Warn2 ($m) { Write-Host "    [!]  $m" -ForegroundColor Yellow }
function Write-Err   ($m) { Write-Host "    [X]  $m" -ForegroundColor Red }

Write-Host ""
Write-Host "  SIMORGH GRID" -ForegroundColor Yellow
Write-Host "  Electrical Projects and Protection Command Center" -ForegroundColor DarkGray
Write-Host "  ------------------------------------------------" -ForegroundColor DarkGray

# ------------------------------------------------------------------------------------------------
# 1. Prerequisites
# ------------------------------------------------------------------------------------------------
Write-Step "Checking prerequisites"

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

if (-not (Test-Command 'docker')) {
  Write-Err "Docker is not installed, or is not on PATH."
  Write-Host ""
  Write-Host "    Install Docker Desktop:  https://www.docker.com/products/docker-desktop/"
  Write-Host "    After installing, start Docker Desktop and wait for the whale icon to stop animating,"
  Write-Host "    then run this script again."
  exit 1
}
Write-Ok "docker found"

# `docker info` is the only reliable way to tell a *running* engine from a merely installed one.
try {
  docker info 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "engine not responding" }
  Write-Ok "Docker engine is running"
} catch {
  Write-Err "Docker is installed but the engine is not running."
  Write-Host "    Start Docker Desktop, wait until it reports 'Engine running', then re-run this script."
  exit 1
}

# Compose v2 is a docker subcommand; v1 was a separate binary. Support both, prefer v2.
$composeCmd = $null
docker compose version 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
  $composeCmd = 'docker compose'
  Write-Ok "docker compose (v2) available"
} elseif (Test-Command 'docker-compose') {
  $composeCmd = 'docker-compose'
  Write-Warn2 "using legacy docker-compose v1 — v2 is recommended"
} else {
  Write-Err "Docker Compose is not available. Update Docker Desktop to a recent version."
  exit 1
}

function Invoke-Compose {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  if ($composeCmd -eq 'docker compose') { & docker compose @Args } else { & docker-compose @Args }
}

# Free disk space: a first run pulls several images and builds two.
try {
  $drive = (Get-Item $PSScriptRoot).PSDrive
  $freeGb = [math]::Round($drive.Free / 1GB, 1)
  if ($freeGb -lt 6) { Write-Warn2 "only ${freeGb} GB free on $($drive.Name): — the first build needs roughly 6 GB" }
  else { Write-Ok "${freeGb} GB free on $($drive.Name):" }
} catch { }

# ------------------------------------------------------------------------------------------------
# 2. Reset (explicit opt-in only)
# ------------------------------------------------------------------------------------------------
if ($Reset) {
  Write-Step "Reset requested"
  Write-Warn2 "This DELETES the database, all projects, relays and history."
  $answer = Read-Host "    Type RESET to confirm"
  if ($answer -cne 'RESET') { Write-Host "    Cancelled."; exit 0 }
  Invoke-Compose down -v
  Write-Ok "containers and volumes removed"
}

# ------------------------------------------------------------------------------------------------
# 3. Configuration
# ------------------------------------------------------------------------------------------------
Write-Step "Configuration"

function New-Secret([int]$bytes = 32) {
  # Cryptographic RNG. Shipping a fixed secret, or deriving one from the clock, would mean every
  # installation signs tokens with a value an attacker can reproduce.
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return [Convert]::ToBase64String($b) -replace '[+/=]', ''
}

if (Test-Path '.env') {
  Write-Ok ".env already exists — leaving it untouched"
} else {
  if (-not (Test-Path '.env.example')) {
    Write-Err ".env.example is missing. Is this a complete copy of the project?"
    exit 1
  }
  $env_content = Get-Content '.env.example' -Raw

  $jwt    = New-Secret 48
  $ingest = New-Secret 32
  $dbpass = New-Secret 24

  # Replace the placeholder values rather than appending, so there is exactly one definition of each.
  $env_content = $env_content -replace '(?m)^POSTGRES_PASSWORD=.*$',       "POSTGRES_PASSWORD=$dbpass"
  $env_content = $env_content -replace '(?m)^JWT_SECRET=.*$',              "JWT_SECRET=$jwt"
  $env_content = $env_content -replace '(?m)^INGEST_TOKEN=.*$',            "INGEST_TOKEN=$ingest"

  # Ensure the keys exist even if .env.example did not carry them.
  foreach ($pair in @(@('POSTGRES_PASSWORD', $dbpass), @('JWT_SECRET', $jwt), @('INGEST_TOKEN', $ingest))) {
    if ($env_content -notmatch "(?m)^$($pair[0])=") { $env_content += "`n$($pair[0])=$($pair[1])" }
  }

  Set-Content -Path '.env' -Value $env_content -NoNewline -Encoding UTF8
  Write-Ok "created .env with freshly generated secrets"
}

# ------------------------------------------------------------------------------------------------
# 4. Start the stack
# ------------------------------------------------------------------------------------------------
Write-Step "Starting containers (first run pulls images and can take several minutes)"

if ($Rebuild) { Invoke-Compose up -d --build } else { Invoke-Compose up -d }
if ($LASTEXITCODE -ne 0) {
  Write-Err "docker compose failed to start the stack."
  Write-Host "    Look at the output above; the usual causes are a port already in use (3000, 4000 or 5432)"
  Write-Host "    or Docker Desktop running low on memory."
  exit 1
}
Write-Ok "containers started"

# ------------------------------------------------------------------------------------------------
# 5. Database
# ------------------------------------------------------------------------------------------------
Write-Step "Waiting for PostgreSQL"

$ready = $false
for ($i = 1; $i -le 60; $i++) {
  Invoke-Compose exec -T postgres pg_isready -q 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 2
  if ($i % 5 -eq 0) { Write-Host "    still waiting... ($($i*2)s)" -ForegroundColor DarkGray }
}
if (-not $ready) {
  Write-Err "PostgreSQL did not become ready within 2 minutes."
  Write-Host "    Check the logs:  $composeCmd logs postgres"
  exit 1
}
Write-Ok "PostgreSQL is accepting connections"

Write-Step "Applying database migrations$(if (-not $NoSeed) { ' and demo data' })"
if ($NoSeed) { $env:SKIP_SEED = '1' }
Invoke-Compose run --rm migrate
if ($LASTEXITCODE -ne 0) {
  Write-Err "Migrations or seeding failed — see the output above."
  exit 1
}
Write-Ok "database ready"

# ------------------------------------------------------------------------------------------------
# 6. Verify (do not claim success without checking)
# ------------------------------------------------------------------------------------------------
Write-Step "Verifying services"

function Wait-Http($url, $label, $tries = 45) {
  for ($i = 1; $i -le $tries; $i++) {
    try {
      $r = Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
      if ($r.StatusCode -eq 200) { Write-Ok "$label responding"; return $true }
    } catch { }
    Start-Sleep -Seconds 2
  }
  Write-Warn2 "$label did not respond at $url"
  return $false
}

$apiOk = Wait-Http 'http://localhost:4000/health' 'API'
$webOk = Wait-Http 'http://localhost:3000'        'Web app'

if ($apiOk) {
  try {
    $accounts = Invoke-RestMethod -Uri 'http://localhost:4000/api/auth/demo-accounts' -TimeoutSec 5
    $fixed = @($accounts.accounts | Where-Object { $_.email -like '*@simorgh.local' })
    if ($fixed.Count -gt 0) { Write-Ok "$($fixed.Count) sign-in accounts available" }
    elseif (-not $NoSeed)   { Write-Warn2 "no demo accounts found — run '$composeCmd run --rm migrate' again" }
  } catch { }
}

# ------------------------------------------------------------------------------------------------
# 7. Done
# ------------------------------------------------------------------------------------------------
Write-Host ""
if ($apiOk -and $webOk) {
  Write-Host "  READY" -ForegroundColor Green
} else {
  Write-Host "  STARTED, BUT SOMETHING IS NOT ANSWERING" -ForegroundColor Yellow
  Write-Host "  Check the logs:  $composeCmd logs -f" -ForegroundColor DarkGray
}
Write-Host "  ------------------------------------------------" -ForegroundColor DarkGray
Write-Host "  Web app     http://localhost:3000"
Write-Host "  API         http://localhost:4000/health"
Write-Host "  Database    http://localhost:8081   (Adminer)"
Write-Host ""
if (-not $NoSeed) {
  Write-Host "  Sign in     admin@simorgh.local" -ForegroundColor Cyan
  Write-Host "  Password    Demo@1234" -ForegroundColor Cyan
  Write-Host "              (demo accounts - remove before real use)" -ForegroundColor DarkGray
} else {
  Write-Host "  No demo data was created. Create the first admin user before signing in." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  Stop        $composeCmd down" -ForegroundColor DarkGray
Write-Host "  Logs        $composeCmd logs -f" -ForegroundColor DarkGray
Write-Host "  Trial guide docs\TRIAL_GUIDE_FA.md" -ForegroundColor DarkGray
Write-Host ""

if ($webOk) {
  try { Start-Process 'http://localhost:3000' } catch { }
}
