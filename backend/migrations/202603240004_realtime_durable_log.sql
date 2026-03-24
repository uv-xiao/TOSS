create table if not exists collab_doc_updates (
  id bigint generated always as identity primary key,
  project_id uuid not null references projects(id) on delete cascade,
  doc_id text not null,
  user_id uuid references users(id) on delete set null,
  kind text not null check (kind in ('yjs.update', 'yjs.sync')),
  payload bytea not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_collab_doc_updates_doc
  on collab_doc_updates(project_id, doc_id, id);

create table if not exists collab_doc_latest_snapshots (
  project_id uuid not null references projects(id) on delete cascade,
  doc_id text not null,
  upto_update_id bigint not null,
  state_update bytea not null,
  updated_at timestamptz not null default now(),
  primary key (project_id, doc_id)
);

create index if not exists idx_collab_doc_latest_snapshots_updated
  on collab_doc_latest_snapshots(updated_at desc);
