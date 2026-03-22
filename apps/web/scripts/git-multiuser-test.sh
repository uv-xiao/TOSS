#!/usr/bin/env bash
set -euo pipefail

CORE_API_URL="${CORE_API_URL:-http://127.0.0.1:18080}"
PROJECT_ID="${PROJECT_ID:-00000000-0000-0000-0000-000000000010}"
TEACHER_ID="${TEACHER_ID:-00000000-0000-0000-0000-000000000100}"
STUDENT_ID="${STUDENT_ID:-00000000-0000-0000-0000-000000000101}"

api_json() {
  local method="$1"
  local path="$2"
  local user_id="$3"
  local body="${4:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" \
      -H "content-type: application/json" \
      -H "x-user-id: $user_id" \
      --data "$body" \
      "$CORE_API_URL$path"
  else
    curl -sS -X "$method" \
      -H "x-user-id: $user_id" \
      "$CORE_API_URL$path"
  fi
}

extract_json_field() {
  local field="$1"
  node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j['$field'] ?? '');});"
}

teacher_pat_json="$(api_json POST "/v1/security/tokens" "$TEACHER_ID" '{"label":"qa-teacher-token"}')"
student_pat_json="$(api_json POST "/v1/security/tokens" "$STUDENT_ID" '{"label":"qa-student-token"}')"
TEACHER_PAT="$(printf '%s' "$teacher_pat_json" | extract_json_field token)"
STUDENT_PAT="$(printf '%s' "$student_pat_json" | extract_json_field token)"

api_json PUT "/v1/projects/$PROJECT_ID/documents/by-path/main.typ" "$TEACHER_ID" '{"content":"= Git QA\n\nInitial from API.\n"}' >/dev/null

TMP_DIR="$(mktemp -d /tmp/typst-git-qa.XXXXXX)"
REPO_A="$TMP_DIR/teacher-clone"
REPO_B="$TMP_DIR/student-clone"

REMOTE_TEACHER="http://qa:${TEACHER_PAT}@127.0.0.1:18080/v1/git/repo/${PROJECT_ID}"
REMOTE_STUDENT="http://qa:${STUDENT_PAT}@127.0.0.1:18080/v1/git/repo/${PROJECT_ID}"

git clone "$REMOTE_TEACHER" "$REPO_A" >/dev/null 2>&1 || true
git clone "$REMOTE_STUDENT" "$REPO_B" >/dev/null 2>&1 || true

if [[ ! -d "$REPO_A/.git" ]]; then
  echo '{"ok":false,"error":"teacher clone failed"}'
  exit 1
fi

cd "$REPO_A"
git config user.name "QA Teacher"
git config user.email "teacher@example.edu"

if [[ ! -f main.typ ]]; then
  # repo might start empty if no server commit yet; fetch once.
  git pull origin main >/dev/null 2>&1 || true
fi

printf '\nOffline edit by teacher.\n' >> main.typ
git add main.typ
git commit -m "Teacher offline change" >/dev/null

api_json PUT "/v1/projects/$PROJECT_ID/documents/by-path/main.typ" "$STUDENT_ID" '{"content":"= Git QA\n\nInitial from API.\n\nCollaborative update by student.\n"}' >/dev/null

set +e
git push origin HEAD:main >/tmp/typst-git-push1.log 2>&1
PUSH1_EXIT=$?
set -e

set +e
git pull --rebase origin main >/tmp/typst-git-rebase.log 2>&1
REBASE_EXIT=$?
set -e

if [[ "$REBASE_EXIT" -ne 0 ]]; then
  git rebase --abort >/dev/null 2>&1 || true
  set +e
  git pull --no-rebase origin main >/tmp/typst-git-merge.log 2>&1
  MERGE_EXIT=$?
  set -e
  if [[ "$MERGE_EXIT" -ne 0 ]]; then
    cat > main.typ <<'EOF'
= Git QA

Initial from API.

Collaborative update by student.
Offline edit by teacher.
EOF
    git add main.typ
    git commit -m "Resolve server/offline merge conflict" >/dev/null
  fi
fi

SERVER_COMMIT_MSG="$(git log --max-count=3 --pretty=%B | tr '\n' ' ' | sed 's/  */ /g')"

git push origin HEAD:main >/dev/null

printf '\nCommit for force push test.\n' >> main.typ
git add main.typ
git commit -m "Force push candidate" >/dev/null
git push origin HEAD:main >/dev/null
git reset --hard HEAD~1 >/dev/null

set +e
git push --force origin HEAD:main >/tmp/typst-git-force.log 2>&1
FORCE_EXIT=$?
set -e

STATUS_JSON="$(api_json GET "/v1/git/status/$PROJECT_ID" "$TEACHER_ID")"

node -e "
const status = JSON.parse(process.argv[1]);
const out = {
  ok: true,
  push_rejected_when_server_advanced: Number(process.argv[2]) !== 0,
  rebase_or_merge_needed: Number(process.argv[5]) !== 0,
  force_push_rejected: Number(process.argv[3]) !== 0,
  server_commit_message_contains_marker: process.argv[4].includes('Recent updates on Typst server'),
  status
};
console.log(JSON.stringify(out, null, 2));
" "$STATUS_JSON" "$PUSH1_EXIT" "$FORCE_EXIT" "$SERVER_COMMIT_MSG" "$REBASE_EXIT"
