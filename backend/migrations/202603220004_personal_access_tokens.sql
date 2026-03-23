create table if not exists personal_access_tokens (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  label text not null,
  token_prefix text not null,
  token_hash text not null unique,
  created_at timestamptz not null,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists idx_pat_user_id on personal_access_tokens(user_id);
create index if not exists idx_pat_last_used_at on personal_access_tokens(last_used_at desc);
