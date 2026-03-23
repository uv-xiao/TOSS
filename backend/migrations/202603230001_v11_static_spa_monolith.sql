create table if not exists org_admins (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  granted_at timestamptz not null,
  primary key (organization_id, user_id)
);

create index if not exists idx_org_admins_user on org_admins(user_id);

create table if not exists org_oidc_group_role_mappings (
  organization_id uuid not null references organizations(id) on delete cascade,
  group_name text not null,
  role text not null check (role in ('Owner', 'Teacher', 'Student', 'TA')),
  granted_at timestamptz not null,
  primary key (organization_id, group_name)
);

create index if not exists idx_org_oidc_group_role_org on org_oidc_group_role_mappings(organization_id);

create table if not exists project_directories (
  project_id uuid not null references projects(id) on delete cascade,
  path text not null,
  created_at timestamptz not null,
  primary key (project_id, path)
);

create index if not exists idx_project_directories_project on project_directories(project_id);

create table if not exists project_settings (
  project_id uuid primary key references projects(id) on delete cascade,
  entry_file_path text not null default 'main.typ',
  updated_at timestamptz not null
);

create table if not exists project_pdf_artifacts (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  entry_file_path text not null,
  content_type text not null,
  pdf_bytes bytea not null,
  size_bytes bigint not null,
  created_by uuid references users(id),
  created_at timestamptz not null
);

create index if not exists idx_project_pdf_artifacts_latest on project_pdf_artifacts(project_id, created_at desc);
