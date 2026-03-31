alter table auth_settings
  add column if not exists anonymous_mode text not null default 'off';

alter table auth_settings
  drop constraint if exists auth_settings_anonymous_mode_check;
alter table auth_settings
  add constraint auth_settings_anonymous_mode_check
  check (anonymous_mode in ('off', 'read_only', 'read_write_named'));

create table if not exists anonymous_share_sessions (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  share_link_id uuid not null references project_share_links(id) on delete cascade,
  session_token_hash text not null unique,
  display_name text not null,
  permission text not null check (permission in ('read', 'write')),
  created_at timestamptz not null,
  expires_at timestamptz,
  last_used_at timestamptz
);

create index if not exists idx_anonymous_share_sessions_project
  on anonymous_share_sessions(project_id, created_at desc);
create index if not exists idx_anonymous_share_sessions_link
  on anonymous_share_sessions(share_link_id);

create table if not exists git_pending_guest_authors (
  project_id uuid not null references projects(id) on delete cascade,
  display_name text not null,
  touched_at timestamptz not null,
  primary key (project_id, display_name)
);

create index if not exists idx_git_pending_guest_authors_project
  on git_pending_guest_authors(project_id);
