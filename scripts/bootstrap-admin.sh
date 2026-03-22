#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required"
  exit 1
fi

ORG_ID="${ORG_ID:-00000000-0000-0000-0000-000000000001}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_NAME="${ADMIN_NAME:-Administrator}"
ADMIN_ID="${ADMIN_ID:-$(uuidgen | tr '[:upper:]' '[:lower:]')}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v org_id="$ORG_ID" -v admin_email="$ADMIN_EMAIL" -v admin_name="$ADMIN_NAME" -v admin_id="$ADMIN_ID" <<'SQL'
insert into users (id, email, display_name, created_at)
values (:'admin_id'::uuid, :'admin_email', :'admin_name', now())
on conflict (email) do update set display_name = excluded.display_name;

insert into org_admins (organization_id, user_id, granted_at)
select :'org_id'::uuid, u.id, now()
from users u
where u.email = :'admin_email'
on conflict (organization_id, user_id) do nothing;
SQL

cat <<MSG
Admin bootstrap complete for ${ADMIN_EMAIL}.
If this user needs local-password login, set/reset via the running API using local registration/login flows.
On fresh startup, the seeded admin account password is generated randomly and logged once by core-api:
  INITIAL ADMIN ACCOUNT: email=admin@example.com password=...
MSG
