#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAI_DIR="${ROOT_DIR}/d-ai"
DAI_PORT="${DAI_PORT:-5174}"

BOOTSTRAP_HOSTS="${BOOTSTRAP_HOSTS:-true}"
BOOTSTRAP_DAI="${BOOTSTRAP_DAI:-true}"
BOOTSTRAP_DAI_BUILD="${BOOTSTRAP_DAI_BUILD:-true}"
BOOTSTRAP_START_DAI="${BOOTSTRAP_START_DAI:-true}"

usage() {
  cat <<'EOF'
Usage: ./scripts/bootstrap.sh [options]

Options:
  --skip-hosts      Do not update /etc/hosts
  --no-dai          Skip npm install/build and skip starting the D-AI dev server
  --no-build        Run npm install but skip npm run build
  --no-start-dai    Do not start the D-AI dev server

Environment:
  DAI_PORT=5174
  BOOTSTRAP_HOSTS=true|false
  BOOTSTRAP_DAI=true|false
  BOOTSTRAP_DAI_BUILD=true|false
  BOOTSTRAP_START_DAI=true|false
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-hosts)
      BOOTSTRAP_HOSTS=false
      ;;
    --no-dai)
      BOOTSTRAP_DAI=false
      BOOTSTRAP_START_DAI=false
      ;;
    --no-build)
      BOOTSTRAP_DAI_BUILD=false
      ;;
    --no-start-dai)
      BOOTSTRAP_START_DAI=false
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

log() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|y|Y)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

wait_until() {
  local label="$1"
  local timeout_seconds="$2"
  shift 2

  local start
  start="$(date +%s)"
  while true; do
    if "$@" >/dev/null 2>&1; then
      printf 'Ready: %s\n' "$label"
      return 0
    fi

    if [ $(( $(date +%s) - start )) -ge "$timeout_seconds" ]; then
      fail "Timed out waiting for ${label}"
    fi

    sleep 2
  done
}

wait_for_http() {
  local label="$1"
  local url="$2"
  local timeout_seconds="${3:-180}"
  wait_until "$label" "$timeout_seconds" curl -fsS "$url"
}

wait_for_mysql() {
  local container="$1"
  local timeout_seconds="${2:-180}"
  wait_until "${container} MySQL" "$timeout_seconds" \
    docker exec "$container" mysqladmin ping -h 127.0.0.1 -uroot -p123456 --silent
}

sql_scalar() {
  local container="$1"
  local database="$2"
  local query="$3"
  docker exec "$container" mysql -uroot -p123456 -N -B "$database" -e "$query" 2>/dev/null | tr -d '\r'
}

wait_for_sql_scalar() {
  local label="$1"
  local container="$2"
  local database="$3"
  local query="$4"
  local expected="$5"
  local timeout_seconds="${6:-180}"

  local start
  start="$(date +%s)"
  while true; do
    local value
    value="$(sql_scalar "$container" "$database" "$query" || true)"

    if [ "$value" = "$expected" ]; then
      printf 'Ready: %s\n' "$label"
      return 0
    fi

    if [ $(( $(date +%s) - start )) -ge "$timeout_seconds" ]; then
      fail "Timed out waiting for ${label}; last value was '${value}'"
    fi

    sleep 2
  done
}

wait_for_container_done() {
  local container="$1"
  local timeout_seconds="${2:-120}"
  local start
  start="$(date +%s)"

  while true; do
    local status
    local exit_code
    status="$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || true)"
    exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$container" 2>/dev/null || true)"

    if [ "$status" = "exited" ] && [ "$exit_code" = "0" ]; then
      printf 'Ready: %s completed\n' "$container"
      return 0
    fi

    if [ "$status" = "exited" ] && [ "$exit_code" != "0" ]; then
      docker logs --tail 80 "$container" >&2 || true
      fail "${container} exited with code ${exit_code}"
    fi

    if [ $(( $(date +%s) - start )) -ge "$timeout_seconds" ]; then
      docker logs --tail 80 "$container" >&2 || true
      fail "Timed out waiting for ${container} to finish"
    fi

    sleep 2
  done
}

ensure_hosts() {
  if ! is_true "$BOOTSTRAP_HOSTS"; then
    log "Skipping /etc/hosts update"
    return
  fi

  local missing=()
  local host
  for host in casdoor.local casibase.local; do
    if ! grep -Eq "^[[:space:]]*127\\.0\\.0\\.1[[:space:]].*[[:space:]]${host}([[:space:]]|\$)" /etc/hosts; then
      missing+=("$host")
    fi
  done

  if [ "${#missing[@]}" -eq 0 ]; then
    log "/etc/hosts already contains casdoor.local and casibase.local"
    return
  fi

  local line
  line="127.0.0.1 ${missing[*]}"
  log "Adding missing local hostnames to /etc/hosts: ${missing[*]}"

  if [ -w /etc/hosts ]; then
    printf '\n%s\n' "$line" >> /etc/hosts
  elif command -v sudo >/dev/null 2>&1; then
    printf '\n%s\n' "$line" | sudo tee -a /etc/hosts >/dev/null
  else
    fail "Cannot update /etc/hosts and sudo is not available. Add this line manually: ${line}"
  fi
}

check_prerequisites() {
  log "Checking prerequisites"
  require_command docker
  require_command curl

  docker compose version >/dev/null

  if is_true "$BOOTSTRAP_DAI"; then
    require_command node
    require_command npm
    local node_major
    node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
    if [ "$node_major" -lt 20 ]; then
      fail "Node.js 20 or newer is required; found $(node --version)"
    fi
  fi
}

bootstrap_docker() {
  cd "$ROOT_DIR"

  log "Starting Casdoor database and Casdoor"
  docker compose up -d casdoor-db casdoor
  wait_for_mysql casdoor-db 180
  wait_for_http "Casdoor HTTP" "http://localhost:8000" 180

  log "Seeding Casdoor"
  "${ROOT_DIR}/scripts/seed-casdoor.sh"

  log "Starting Casibase, MinIO, OpenMeter, ClickHouse, and OpenTelemetry"
  docker compose up -d \
    casibase-db \
    minio \
    minio-init \
    openmeter \
    openmeter-sink-worker \
    openmeter-balance-worker \
    d-ai-clickhouse \
    d-ai-otel-collector \
    casibase

  wait_for_mysql casibase-db 180
  wait_for_http "MinIO API" "http://localhost:9000/minio/health/live" 180
  wait_for_container_done minio-init 120
  wait_for_http "OpenMeter API" "http://localhost:48888/api/v1/debug/metrics" 240
  wait_for_http "D-AI ClickHouse" "http://localhost:18123/ping" 180
  wait_for_http "Casibase HTTP" "http://localhost:14000" 240
  wait_for_sql_scalar "Casibase built-in store" casibase-db casibase \
    "select count(*) from store where owner = 'admin' and name = 'store-built-in';" \
    "1" 180

  log "Seeding Casibase MinIO stores"
  "${ROOT_DIR}/scripts/seed-casibase-minio-store.sh"

  log "Restarting Casibase after store/provider seed"
  docker compose restart casibase
  wait_for_http "Casibase HTTP after restart" "http://localhost:14000" 180
  wait_for_sql_scalar "D-AI shared MinIO store" casibase-db casibase \
    "select count(*) from store where owner = 'admin' and name = 'ifm-v0' and storage_provider = 'provider-storage-ifm-minio-v1';" \
    "1" 60
}

bootstrap_dai() {
  if ! is_true "$BOOTSTRAP_DAI"; then
    log "Skipping D-AI npm bootstrap"
    return
  fi

  log "Installing D-AI dependencies"
  cd "$DAI_DIR"
  npm install

  if is_true "$BOOTSTRAP_DAI_BUILD"; then
    log "Building D-AI"
    npm run build
  fi

  if ! is_true "$BOOTSTRAP_START_DAI"; then
    log "Skipping D-AI dev server startup"
    return
  fi

  log "Starting D-AI dev server on port ${DAI_PORT}"
  mkdir -p "${DAI_DIR}/.d-ai-state"

  local session_name
  session_name="d-ai-vite-${DAI_PORT}"

  if command -v screen >/dev/null 2>&1; then
    screen -S "$session_name" -X quit >/dev/null 2>&1 || true
    screen -dmS "$session_name" bash -lc "cd '${DAI_DIR}' && npm run dev -- --port '${DAI_PORT}' > .d-ai-state/vite.log 2>&1"
  else
    if [ -f "${DAI_DIR}/.d-ai-state/vite.pid" ]; then
      kill "$(cat "${DAI_DIR}/.d-ai-state/vite.pid")" >/dev/null 2>&1 || true
    fi
    (cd "$DAI_DIR" && nohup npm run dev -- --port "$DAI_PORT" > .d-ai-state/vite.log 2>&1 & echo "$!" > .d-ai-state/vite.pid)
  fi

  wait_for_http "D-AI dev server" "http://localhost:${DAI_PORT}" 60
}

main() {
  check_prerequisites
  ensure_hosts
  bootstrap_docker
  bootstrap_dai

  log "Bootstrap complete"
  printf 'Casdoor:  http://casdoor.local:8000\n'
  printf 'Casibase: http://casibase.local:14000\n'
  printf 'D-AI:     http://localhost:%s\n' "$DAI_PORT"
}

main "$@"
