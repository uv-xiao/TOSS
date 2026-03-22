#!/usr/bin/env bash
set -euo pipefail

core="${CORE_API_URL:-http://localhost:8080}"
realtime="${REALTIME_URL:-http://localhost:8090}"

echo "[1/3] core-api health"
curl -fsS "${core}/health" >/dev/null
echo "ok"

echo "[2/3] realtime health"
curl -fsS "${realtime}/health" >/dev/null
echo "ok"

echo "[3/3] list projects"
curl -fsS "${core}/v1/projects" >/dev/null
echo "ok"

echo "Smoke test passed."

