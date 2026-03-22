create table if not exists git_repositories (
  project_id uuid primary key references projects(id) on delete cascade,
  remote_url text,
  local_path text not null,
  default_branch text not null default 'main',
  updated_at timestamptz not null
);

