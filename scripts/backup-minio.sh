#!/usr/bin/env bash
set -euo pipefail

timestamp="$(date +%Y%m%d_%H%M%S)"
out_dir="${1:-./tmp/backups}"
mkdir -p "$out_dir"

if [[ ! -d "./tmp/minio/data" ]]; then
  echo "MinIO data directory not found"
  exit 1
fi

tar -czf "${out_dir}/minio_${timestamp}.tgz" ./tmp/minio/data
echo "Wrote ${out_dir}/minio_${timestamp}.tgz"
