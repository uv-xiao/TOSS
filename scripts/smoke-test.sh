#!/usr/bin/env bash
set -euo pipefail

core="${CORE_API_URL:-http://localhost:8080}"

echo "[1/2] core-api health"
curl -fsS "${core}/health" >/dev/null
echo "ok"

echo "[2/2] list projects"
curl -fsS "${core}/v1/projects" >/dev/null
echo "ok"

echo "Smoke test passed."
