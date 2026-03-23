create table if not exists project_snapshots (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  object_key text not null unique,
  created_by uuid references users(id),
  created_at timestamptz not null,
  document_count integer not null,
  byte_size bigint not null
);

create index if not exists idx_project_snapshots_project on project_snapshots(project_id, created_at desc);

create table if not exists project_assets (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  path text not null,
  object_key text not null unique,
  content_type text not null,
  size_bytes bigint not null,
  uploaded_by uuid references users(id),
  created_at timestamptz not null
);

create index if not exists idx_project_assets_project on project_assets(project_id, created_at desc);
create unique index if not exists uniq_project_assets_path on project_assets(project_id, path);

create table if not exists git_bundle_artifacts (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  event_type text not null,
  object_key text not null unique,
  size_bytes bigint not null,
  created_at timestamptz not null
);

create index if not exists idx_git_bundle_artifacts_project on git_bundle_artifacts(project_id, created_at desc);
