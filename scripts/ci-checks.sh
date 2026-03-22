#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB_URL="${DATABASE_URL:-postgres://typstapp:iv61v6mRPCGxvWjt@127.0.0.1:5432/typstappdb}"
CORE_API_PORT="${CORE_API_PORT:-18080}"
REALTIME_PORT="${REALTIME_PORT:-18090}"
CORE_API_URL="http://127.0.0.1:${CORE_API_PORT}"
REALTIME_URL="ws://127.0.0.1:${REALTIME_PORT}"

cd "$ROOT_DIR"

cleanup() {
  if [[ -n "${WEB_PID:-}" ]]; then kill "$WEB_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "${REALTIME_PID:-}" ]]; then kill "$REALTIME_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "${CORE_PID:-}" ]]; then kill "$CORE_PID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

if [[ -d "/opt/homebrew/opt/rustup/bin" ]]; then
  export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
fi

echo "[ci] cargo check (core-api)"
(cd services/core-api && cargo check)
echo "[ci] cargo check (realtime)"
(cd services/realtime && cargo check)

echo "[ci] npm ci + build (web)"
(cd apps/web && npm ci)
(cd apps/web && npm run build)

echo "[ci] start core-api"
(cd services/core-api && DATABASE_URL="$DB_URL" CORE_API_PORT="$CORE_API_PORT" GIT_STORAGE_PATH="/tmp/typst-git" cargo run >/tmp/typst-core.log 2>&1) &
CORE_PID=$!
sleep 2
curl -fsS "$CORE_API_URL/health" >/dev/null

echo "[ci] start realtime"
(cd services/realtime && CORE_API_URL="$CORE_API_URL" REALTIME_PORT="$REALTIME_PORT" cargo run >/tmp/typst-realtime.log 2>&1) &
REALTIME_PID=$!
sleep 1
curl -fsS "http://127.0.0.1:${REALTIME_PORT}/health" >/dev/null

echo "[ci] run API-level collaboration and git checks"
node apps/web/scripts/realtime-multiuser-test.mjs
bash apps/web/scripts/git-multiuser-test.sh

echo "[ci] start web dev server for browser e2e checks"
(cd apps/web && NEXT_PUBLIC_CORE_API_URL="$CORE_API_URL" NEXT_PUBLIC_REALTIME_URL="$REALTIME_URL" npm run dev >/tmp/typst-web.log 2>&1) &
WEB_PID=$!
sleep 4
curl -fsS "http://127.0.0.1:3000" >/dev/null

echo "[ci] run headless browser checks"
WEB_BASE_URL="http://127.0.0.1:3000" node apps/web/scripts/headless-smoke.mjs
WEB_BASE_URL="http://127.0.0.1:3000" CORE_API_URL="$CORE_API_URL" node apps/web/scripts/headless-collab-git.mjs

echo "[ci] all checks passed"
