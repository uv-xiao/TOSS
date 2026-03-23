create table if not exists user_oidc_groups (
  user_id uuid not null references users(id) on delete cascade,
  group_name text not null,
  synced_at timestamptz not null,
  primary key (user_id, group_name)
);

create index if not exists idx_user_oidc_groups_user on user_oidc_groups(user_id);

create table if not exists project_group_roles (
  project_id uuid not null references projects(id) on delete cascade,
  group_name text not null,
  role text not null check (role in ('Owner', 'Teacher', 'Student', 'TA')),
  granted_at timestamptz not null,
  primary key (project_id, group_name)
);

create index if not exists idx_project_group_roles_project on project_group_roles(project_id);
