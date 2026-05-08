#!/usr/bin/env bash
set -euo pipefail

DAI_PORT="${DAI_PORT:-5174}"
SESSION_NAME="${DAI_SESSION_NAME:-d-ai-vite-${DAI_PORT}}"

log() {
  printf '==> %s\n' "$*"
}

stop_screen_session() {
  if ! command -v screen >/dev/null 2>&1; then
    return
  fi

  if screen -list | grep -q "[.]${SESSION_NAME}[[:space:]]"; then
    log "Stopping screen session ${SESSION_NAME}"
    screen -S "$SESSION_NAME" -X quit >/dev/null 2>&1 || true
  fi
}

stop_pid_file() {
  local root_dir
  local pid_file

  root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  pid_file="${root_dir}/d-ai/.d-ai-state/vite.pid"

  if [ ! -f "$pid_file" ]; then
    return
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"

  if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
    log "Stopping D-AI pid ${pid}"
    kill "$pid" >/dev/null 2>&1 || true
  fi

  rm -f "$pid_file"
}

stop_port_listener() {
  if ! command -v lsof >/dev/null 2>&1; then
    return
  fi

  local pids
  pids="$(lsof -tiTCP:"${DAI_PORT}" -sTCP:LISTEN 2>/dev/null || true)"

  if [ -z "$pids" ]; then
    return
  fi

  log "Stopping processes listening on port ${DAI_PORT}: ${pids//$'\n'/ }"
  # shellcheck disable=SC2086
  kill $pids >/dev/null 2>&1 || true
  sleep 1

  pids="$(lsof -tiTCP:"${DAI_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill -9 $pids >/dev/null 2>&1 || true
  fi
}

main() {
  stop_screen_session
  stop_pid_file
  stop_port_listener

  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"${DAI_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'ERROR: port %s is still listening\n' "$DAI_PORT" >&2
    exit 1
  fi

  log "D-AI frontend stopped; port ${DAI_PORT} is clear"
}

main "$@"
