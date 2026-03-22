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

echo "[ci] cargo check (core-api)"
(cd services/core-api && cargo check)

echo "[ci] npm ci + build (web)"
(cd apps/web && npm ci)
(cd apps/web && npm run build)

echo "[ci] start core-api monolith"
(cd services/core-api && DATABASE_URL="$DB_URL" CORE_API_PORT="$CORE_API_PORT" GIT_STORAGE_PATH="/tmp/typst-git" AUTH_DEV_HEADER_ENABLED=1 WEB_STATIC_DIR="../../apps/web/dist" cargo run >/tmp/typst-core.log 2>&1) &
CORE_PID=$!
for _ in $(seq 1 60); do
  if curl -fsS "$CORE_API_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "$CORE_API_URL/health" >/dev/null

echo "[ci] run API-level collaboration and git checks"
node apps/web/scripts/realtime-multiuser-test.mjs
bash apps/web/scripts/git-multiuser-test.sh

echo "[ci] run headless browser checks"
WEB_BASE_URL="$CORE_API_URL" node apps/web/scripts/headless-smoke.mjs
WEB_BASE_URL="$CORE_API_URL" CORE_API_URL="$CORE_API_URL" node apps/web/scripts/headless-collab-git.mjs

echo "[ci] all checks passed"
