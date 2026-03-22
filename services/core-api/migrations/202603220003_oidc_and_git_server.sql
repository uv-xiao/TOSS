alter table users
  add column if not exists oidc_subject text unique,
  add column if not exists oidc_issuer text;

create table if not exists auth_sessions (
  session_token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  user_agent text,
  ip_address text
);

create index if not exists idx_auth_sessions_user_id on auth_sessions(user_id);
create index if not exists idx_auth_sessions_expires_at on auth_sessions(expires_at);

create table if not exists oidc_states (
  state text primary key,
  nonce text not null,
  created_at timestamptz not null
);

alter table git_repositories
  add column if not exists pending_sync boolean not null default false,
  add column if not exists last_server_sync_at timestamptz;

create table if not exists git_pending_authors (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  touched_at timestamptz not null,
  primary key (project_id, user_id)
);

create index if not exists idx_git_pending_authors_project on git_pending_authors(project_id);

