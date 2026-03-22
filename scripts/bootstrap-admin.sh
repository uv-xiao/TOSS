#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required"
  exit 1
fi

psql "$DATABASE_URL" <<'SQL'
insert into users (id, email, display_name, created_at)
values ('00000000-0000-0000-0000-000000000102', 'admin@example.edu', 'School Admin', now())
on conflict (email) do nothing;
SQL

echo "Admin bootstrap complete."
