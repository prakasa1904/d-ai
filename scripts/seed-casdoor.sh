#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQL_FILE="${ROOT_DIR}/scripts/seed-casdoor.sql"
CONTAINER_NAME="${CASDOOR_DB_CONTAINER:-casdoor-db}"
MYSQL_USER="${CASDOOR_DB_USER:-root}"
MYSQL_PASSWORD="${CASDOOR_DB_PASSWORD:-123456}"
MYSQL_DATABASE="${CASDOOR_DB_NAME:-casdoor}"

if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  echo "Casdoor DB container '${CONTAINER_NAME}' is not running." >&2
  echo "Start the stack first: docker compose up -d casdoor-db casdoor" >&2
  exit 1
fi

echo "Seeding Casdoor organization/application data into ${CONTAINER_NAME}/${MYSQL_DATABASE}..."
docker exec -i "${CONTAINER_NAME}" mysql \
  -u"${MYSQL_USER}" \
  -p"${MYSQL_PASSWORD}" \
  "${MYSQL_DATABASE}" < "${SQL_FILE}"

echo "Casdoor seed complete."
echo "Restart Casibase if it was already running: docker compose restart casibase"
