create extension if not exists "uuid-ossp";

create table if not exists organizations (
  id uuid primary key,
  name text not null,
  created_at timestamptz not null
);

create table if not exists users (
  id uuid primary key,
  email text not null unique,
  display_name text not null,
  created_at timestamptz not null
);

create table if not exists projects (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null
);

create table if not exists project_roles (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('Owner', 'Teacher', 'Student', 'TA')),
  granted_at timestamptz not null,
  primary key (project_id, user_id)
);

create table if not exists documents (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  path text not null,
  content text not null,
  updated_at timestamptz not null,
  unique (project_id, path)
);

create table if not exists revisions (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  actor_user_id uuid references users(id),
  summary text not null,
  created_at timestamptz not null
);

create table if not exists comments (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  actor_user_id uuid references users(id),
  body text not null,
  anchor text,
  created_at timestamptz not null
);

create table if not exists git_sync_states (
  project_id uuid primary key references projects(id) on delete cascade,
  branch text not null default 'main',
  last_pull_at timestamptz,
  last_push_at timestamptz,
  has_conflicts boolean not null default false,
  status text not null default 'clean'
);

create table if not exists audit_events (
  id uuid primary key,
  actor_user_id uuid references users(id),
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null
);

create index if not exists idx_projects_org on projects(organization_id);
create index if not exists idx_documents_project on documents(project_id);
create index if not exists idx_revisions_project on revisions(project_id, created_at desc);
create index if not exists idx_comments_project on comments(project_id, created_at desc);
create index if not exists idx_audit_events_created on audit_events(created_at desc);

