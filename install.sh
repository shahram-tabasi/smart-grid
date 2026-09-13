#!/usr/bin/env bash
#
# Simorgh Grid — one-command installer for Linux and macOS.
# The PowerShell equivalent for Windows is install.ps1 (or double-click START.bat).
#
#   ./install.sh              full install with demo data
#   ./install.sh --no-seed    schema only, no demo data
#   ./install.sh --rebuild    force image rebuild
#   ./install.sh --reset      DESTROY all data and start clean
#
# Safe to re-run: an existing .env is never overwritten and migrations are idempotent.

set -euo pipefail
cd "$(dirname "$0")"

NO_SEED=0; REBUILD=0; RESET=0
for arg in "$@"; do
  case "$arg" in
    --no-seed) NO_SEED=1 ;;
    --rebuild) REBUILD=1 ;;
    --reset)   RESET=1 ;;
    -h|--help) sed -n '3,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$C_CYAN" "$1" "$C_OFF"; }
ok()   { printf '    %s[OK]%s %s\n' "$C_GREEN" "$C_OFF" "$1"; }
warn() { printf '    %s[!] %s %s\n' "$C_YELLOW" "$C_OFF" "$1"; }
err()  { printf '    %s[X] %s %s\n' "$C_RED" "$C_OFF" "$1"; }

printf '\n  %sSIMORGH GRID%s\n' "$C_YELLOW" "$C_OFF"
printf '  %sElectrical Projects and Protection Command Center%s\n' "$C_DIM" "$C_OFF"
printf '  %s------------------------------------------------%s\n' "$C_DIM" "$C_OFF"

# ------------------------------------------------------------------------------------------------
# 1. Prerequisites
# ------------------------------------------------------------------------------------------------
step "Checking prerequisites"

if ! command -v docker >/dev/null 2>&1; then
  err "Docker is not installed, or is not on PATH."
  echo "    Install it:  https://docs.docker.com/get-docker/"
  exit 1
fi
ok "docker found"

# An installed Docker is not a running Docker; only `docker info` distinguishes them.
if ! docker info >/dev/null 2>&1; then
  err "Docker is installed but the daemon is not running."
  echo "    Linux:  sudo systemctl start docker"
  echo "    macOS:  start Docker Desktop and wait for it to report 'running'"
  exit 1
fi
ok "Docker daemon is running"

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"; ok "docker compose (v2) available"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"; warn "using legacy docker-compose v1 — v2 is recommended"
else
  err "Docker Compose is not available."
  exit 1
fi

FREE_GB=$(df -Pk . | awk 'NR==2 {printf "%.1f", $4/1048576}')
if awk "BEGIN{exit !($FREE_GB < 6)}"; then
  warn "only ${FREE_GB} GB free here — the first build needs roughly 6 GB"
else
  ok "${FREE_GB} GB free"
fi

# ------------------------------------------------------------------------------------------------
# 2. Reset
# ------------------------------------------------------------------------------------------------
if [ "$RESET" = "1" ]; then
  step "Reset requested"
  warn "This DELETES the database, all projects, relays and history."
  read -r -p "    Type RESET to confirm: " answer
  [ "$answer" = "RESET" ] || { echo "    Cancelled."; exit 0; }
  $COMPOSE down -v
  ok "containers and volumes removed"
fi

# ------------------------------------------------------------------------------------------------
# 3. Configuration
# ------------------------------------------------------------------------------------------------
step "Configuration"

gen_secret() {
  # Cryptographic RNG. A fixed or clock-derived secret would be reproducible by an attacker.
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$1" | tr -d '+/=\n'
  else
    head -c "$1" /dev/urandom | base64 | tr -d '+/=\n'
  fi
}

if [ -f .env ]; then
  ok ".env already exists — leaving it untouched"
else
  [ -f .env.example ] || { err ".env.example is missing. Is this a complete copy of the project?"; exit 1; }
  JWT=$(gen_secret 48); INGEST=$(gen_secret 32); DBPASS=$(gen_secret 24)
  # sed -E for portability between GNU and BSD sed; write to a temp file then move.
  sed -E \
    -e "s|^POSTGRES_PASSWORD=.*$|POSTGRES_PASSWORD=${DBPASS}|" \
    -e "s|^JWT_SECRET=.*$|JWT_SECRET=${JWT}|" \
    -e "s|^INGEST_TOKEN=.*$|INGEST_TOKEN=${INGEST}|" \
    .env.example > .env.tmp
  for kv in "POSTGRES_PASSWORD=${DBPASS}" "JWT_SECRET=${JWT}" "INGEST_TOKEN=${INGEST}"; do
    key="${kv%%=*}"
    grep -q "^${key}=" .env.tmp || echo "$kv" >> .env.tmp
  done
  mv .env.tmp .env
  chmod 600 .env 2>/dev/null || true
  ok "created .env with freshly generated secrets"
fi

# ------------------------------------------------------------------------------------------------
# 4. Start
# ------------------------------------------------------------------------------------------------
step "Starting containers (first run pulls images and can take several minutes)"
if [ "$REBUILD" = "1" ]; then $COMPOSE up -d --build; else $COMPOSE up -d; fi
ok "containers started"

# ------------------------------------------------------------------------------------------------
# 5. Database
# ------------------------------------------------------------------------------------------------
step "Waiting for PostgreSQL"
READY=0
for i in $(seq 1 60); do
  if $COMPOSE exec -T postgres pg_isready -q >/dev/null 2>&1; then READY=1; break; fi
  sleep 2
  [ $((i % 5)) -eq 0 ] && printf '    %sstill waiting... (%ss)%s\n' "$C_DIM" "$((i*2))" "$C_OFF"
done
[ "$READY" = "1" ] || { err "PostgreSQL did not become ready within 2 minutes."; echo "    Check: $COMPOSE logs postgres"; exit 1; }
ok "PostgreSQL is accepting connections"

if [ "$NO_SEED" = "1" ]; then
  step "Applying database migrations"
  SKIP_SEED=1 $COMPOSE run --rm migrate
else
  step "Applying database migrations and demo data"
  $COMPOSE run --rm migrate
fi
ok "database ready"

# ------------------------------------------------------------------------------------------------
# 6. Verify
# ------------------------------------------------------------------------------------------------
step "Verifying services"

wait_http() {
  local url="$1" label="$2" tries="${3:-45}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -m 3 "$url" >/dev/null 2>&1; then ok "$label responding"; return 0; fi
    sleep 2
  done
  warn "$label did not respond at $url"
  return 1
}

API_OK=0; WEB_OK=0
wait_http http://localhost:4000/health "API"    && API_OK=1
wait_http http://localhost:3000        "Web app" && WEB_OK=1

if [ "$API_OK" = "1" ] && [ "$NO_SEED" != "1" ]; then
  COUNT=$(curl -fsS -m 5 http://localhost:4000/api/auth/demo-accounts 2>/dev/null \
          | grep -o '@simorgh.local' | wc -l | tr -d ' ') || COUNT=0
  if [ "${COUNT:-0}" -gt 0 ]; then ok "${COUNT} sign-in accounts available"
  else warn "no demo accounts found — run '$COMPOSE run --rm migrate' again"; fi
fi

# ------------------------------------------------------------------------------------------------
# 7. Done
# ------------------------------------------------------------------------------------------------
echo
if [ "$API_OK" = "1" ] && [ "$WEB_OK" = "1" ]; then
  printf '  %sREADY%s\n' "$C_GREEN" "$C_OFF"
else
  printf '  %sSTARTED, BUT SOMETHING IS NOT ANSWERING%s\n' "$C_YELLOW" "$C_OFF"
  printf '  %sCheck the logs:  %s logs -f%s\n' "$C_DIM" "$COMPOSE" "$C_OFF"
fi
printf '  %s------------------------------------------------%s\n' "$C_DIM" "$C_OFF"
echo "  Web app     http://localhost:3000"
echo "  API         http://localhost:4000/health"
echo "  Database    http://localhost:8081   (Adminer)"
echo
if [ "$NO_SEED" != "1" ]; then
  printf '  %sSign in     admin@simorgh.local%s\n' "$C_CYAN" "$C_OFF"
  printf '  %sPassword    Demo@1234%s\n' "$C_CYAN" "$C_OFF"
  printf '  %s            (demo accounts - remove before real use)%s\n' "$C_DIM" "$C_OFF"
else
  printf '  %sNo demo data was created. Create the first admin user before signing in.%s\n' "$C_YELLOW" "$C_OFF"
fi
echo
printf '  %sStop        %s down%s\n' "$C_DIM" "$COMPOSE" "$C_OFF"
printf '  %sLogs        %s logs -f%s\n' "$C_DIM" "$COMPOSE" "$C_OFF"
echo
