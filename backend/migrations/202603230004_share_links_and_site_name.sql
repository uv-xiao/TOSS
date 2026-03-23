alter table auth_settings
  add column if not exists site_name text not null default 'Typst Collaboration';

update auth_settings
set site_name = 'Typst Collaboration'
where site_name is null or btrim(site_name) = '';

alter table project_roles
  drop constraint if exists project_roles_role_check;
alter table project_roles
  add constraint project_roles_role_check
  check (role in ('Owner', 'Teacher', 'Student', 'TA', 'Viewer'));

alter table project_group_roles
  drop constraint if exists project_group_roles_role_check;
alter table project_group_roles
  add constraint project_group_roles_role_check
  check (role in ('Owner', 'Teacher', 'Student', 'TA', 'Viewer'));

alter table org_oidc_group_role_mappings
  drop constraint if exists org_oidc_group_role_mappings_role_check;
alter table org_oidc_group_role_mappings
  add constraint org_oidc_group_role_mappings_role_check
  check (role in ('Owner', 'Teacher', 'Student', 'TA', 'Viewer'));

create table if not exists project_share_links (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  token_prefix text not null,
  token_hash text not null unique,
  permission text not null check (permission in ('read', 'write')),
  created_by uuid references users(id),
  created_at timestamptz not null,
  expires_at timestamptz,
  revoked_at timestamptz
);

create index if not exists idx_project_share_links_project_created
  on project_share_links(project_id, created_at desc);
