alter table projects
  add column if not exists is_template boolean not null default false;

create index if not exists idx_projects_is_template
  on projects(is_template);

create table if not exists project_template_organization_access (
  project_id uuid not null references projects(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  granted_by uuid references users(id),
  granted_at timestamptz not null,
  primary key (project_id, organization_id)
);

create index if not exists idx_project_template_org_access_org
  on project_template_organization_access(organization_id);

create table if not exists project_thumbnails (
  project_id uuid primary key references projects(id) on delete cascade,
  content_type text not null,
  image_data bytea not null,
  updated_by uuid references users(id),
  updated_at timestamptz not null
);

