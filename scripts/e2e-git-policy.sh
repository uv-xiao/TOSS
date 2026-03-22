#!/usr/bin/env bash
set -euo pipefail

CORE_API_URL="${CORE_API_URL:-http://127.0.0.1:8080}"
PROJECT_ID="${PROJECT_ID:-00000000-0000-0000-0000-000000000010}"
DEV_USER_ID="${DEV_USER_ID:-00000000-0000-0000-0000-000000000100}"
WORK_DIR="${WORK_DIR:-/tmp/typst-e2e-git}"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

echo "[1/7] create PAT"
resp="$(curl -sS -H "x-user-id: ${DEV_USER_ID}" -X POST \
  -H "content-type: application/json" \
  -d '{"label":"e2e-git-policy","expires_at":null}' \
  "${CORE_API_URL}/v1/security/tokens")"
token="$(echo "$resp" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
token_id="$(echo "$resp" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
if [[ -z "$token" ]]; then
  echo "failed to create PAT"
  exit 1
fi

echo "[2/7] confirm git auth works"
git ls-remote "http://oauth2:${token}@${CORE_API_URL#http://}/v1/git/repo/${PROJECT_ID}" >/dev/null

echo "[3/7] write collaborative server update"
curl -sS -H "x-user-id: ${DEV_USER_ID}" -X PUT \
  -H "content-type: application/json" \
  -d '{"content":"= E2E Server Edit\n\npending sync commit\n"}' \
  "${CORE_API_URL}/v1/projects/${PROJECT_ID}/documents/by-path/main.typ" >/dev/null

echo "[4/7] trigger git endpoint to flush server commit"
git ls-remote "http://oauth2:${token}@${CORE_API_URL#http://}/v1/git/repo/${PROJECT_ID}" >/dev/null

echo "[5/7] clone and push one normal commit"
git clone "http://oauth2:${token}@${CORE_API_URL#http://}/v1/git/repo/${PROJECT_ID}" "$WORK_DIR/client" >/dev/null 2>&1
cd "$WORK_DIR/client"
git checkout -B main >/dev/null
printf '= E2E Client Commit\n\nnormal push\n' > main.typ
git add main.typ
git -c user.name='E2E User' -c user.email='e2e@example.com' commit -m 'e2e normal push' >/dev/null
git push origin main >/dev/null

echo "[6/7] make server dirty again and verify force push reject"
curl -sS -H "x-user-id: ${DEV_USER_ID}" -X PUT \
  -H "content-type: application/json" \
  -d '{"content":"= E2E Dirty Again\n\nmust reject force push\n"}' \
  "${CORE_API_URL}/v1/projects/${PROJECT_ID}/documents/by-path/main.typ" >/dev/null
printf '= E2E Force Push Attempt\n\nshould fail\n' > main.typ
git add main.typ
git -c user.name='E2E User' -c user.email='e2e@example.com' commit -m 'e2e force push attempt' >/dev/null
set +e
git push --force origin main >/tmp/typst_e2e_force_push.log 2>&1
force_exit=$?
set -e
if [[ $force_exit -eq 0 ]]; then
  echo "force push unexpectedly succeeded"
  cat /tmp/typst_e2e_force_push.log
  exit 1
fi

echo "[7/7] revoke PAT and verify auth fails"
curl -sS -X DELETE -H "x-user-id: ${DEV_USER_ID}" \
  "${CORE_API_URL}/v1/security/tokens/${token_id}" >/dev/null
set +e
git ls-remote "http://oauth2:${token}@${CORE_API_URL#http://}/v1/git/repo/${PROJECT_ID}" >/dev/null 2>&1
auth_exit=$?
set -e
if [[ $auth_exit -eq 0 ]]; then
  echo "revoked PAT still works unexpectedly"
  exit 1
fi

echo "e2e git policy check passed"
