#!/usr/bin/env bash
set -euo pipefail

timestamp="$(date +%Y%m%d_%H%M%S)"
out_dir="${1:-./tmp/backups}"
mkdir -p "$out_dir"

if [[ -z "${POSTGRES_USER:-}" || -z "${POSTGRES_DB:-}" ]]; then
  echo "POSTGRES_USER and POSTGRES_DB are required"
  exit 1
fi

docker exec typst-postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > "${out_dir}/postgres_${timestamp}.sql"
echo "Wrote ${out_dir}/postgres_${timestamp}.sql"

