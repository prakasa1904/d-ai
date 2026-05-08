#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Configuring Casibase stores to use MinIO in casibase-db/casibase..."
docker exec -i casibase-db mysql -uroot -p123456 casibase < scripts/seed-casibase-minio-store.sql

created_count="$(
  docker exec casibase-db mysql -uroot -p123456 -N -B casibase \
    -e "select count(*) from store where owner = 'admin' and name = 'ifm-minio-v0';" 2>/dev/null
)"

if [ "$created_count" != "1" ]; then
  echo "MinIO store was not created. Make sure Casibase has already created admin/ifm-v0, then run this script again."
  exit 1
fi

echo "Casibase MinIO storage ready: admin/ifm-v0 and admin/ifm-minio-v0"
