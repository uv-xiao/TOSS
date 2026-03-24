create table if not exists project_sync_queue (
  project_id uuid primary key references projects(id) on delete cascade,
  dirty_since timestamptz not null,
  last_enqueued_at timestamptz not null,
  last_attempt_at timestamptz,
  attempt_count integer not null default 0,
  last_error text
);

create index if not exists idx_project_sync_queue_dirty_since
  on project_sync_queue(dirty_since asc);
