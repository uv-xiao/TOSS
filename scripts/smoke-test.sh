#!/usr/bin/env bash
set -euo pipefail

core="${CORE_API_URL:-http://localhost:8080}"
user="${SMOKE_USER_ID:-00000000-0000-0000-0000-000000000100}"

echo "[1/2] core-api health"
curl -fsS "${core}/health" >/dev/null
echo "ok"

echo "[2/2] list projects"
curl -fsS -H "x-user-id: ${user}" "${core}/v1/projects" >/dev/null
echo "ok"

echo "Smoke test passed."
