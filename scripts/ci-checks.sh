#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB_URL="${DATABASE_URL:-postgres://typstapp:iv61v6mRPCGxvWjt@127.0.0.1:5432/typstappdb}"
CORE_API_PORT="${CORE_API_PORT:-18080}"
CORE_API_URL="http://127.0.0.1:${CORE_API_PORT}"
REALTIME_URL="ws://127.0.0.1:${CORE_API_PORT}"

cd "$ROOT_DIR"

cleanup() {
  if [[ -n "${CORE_PID:-}" ]]; then kill "$CORE_PID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

if [[ -d "/opt/homebrew/opt/rustup/bin" ]]; then
  export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
fi

echo "[ci] cargo check (backend)"
(cd backend && cargo check)

echo "[ci] npm ci + build (web)"
(cd web && npm ci)
(cd web && npm run build)

echo "[ci] start backend monolith"
(cd backend && DATABASE_URL="$DB_URL" CORE_API_PORT="$CORE_API_PORT" GIT_STORAGE_PATH="/tmp/typst-git" AUTH_DEV_HEADER_ENABLED=1 WEB_STATIC_DIR="../web/dist" cargo run >/tmp/typst-core.log 2>&1) &
CORE_PID=$!
for _ in $(seq 1 180); do
  if curl -fsS "$CORE_API_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "$CORE_API_URL/health" >/dev/null

echo "[ci] run API-level collaboration and git checks"
CORE_API_URL="$CORE_API_URL" REALTIME_WS_URL="$REALTIME_URL" node web/scripts/realtime-multiuser-test.mjs
CORE_API_URL="$CORE_API_URL" bash web/scripts/git-multiuser-test.sh

echo "[ci] run headless browser checks"
WEB_BASE_URL="$CORE_API_URL" node web/scripts/headless-smoke.mjs
WEB_BASE_URL="$CORE_API_URL" CORE_API_URL="$CORE_API_URL" node web/scripts/headless-collab-git.mjs
WEB_BASE_URL="$CORE_API_URL" CORE_API_URL="$CORE_API_URL" node web/scripts/headless-revision-collab-regression.mjs

echo "[ci] all checks passed"
