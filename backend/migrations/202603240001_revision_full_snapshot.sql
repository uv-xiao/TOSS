alter table revisions
  add column if not exists entry_file_path text;

create table if not exists revision_directories (
  revision_id uuid not null references revisions(id) on delete cascade,
  path text not null,
  primary key (revision_id, path)
);

create table if not exists revision_assets (
  revision_id uuid not null references revisions(id) on delete cascade,
  path text not null,
  object_key text not null,
  content_type text not null,
  size_bytes bigint not null,
  inline_data bytea,
  primary key (revision_id, path)
);

create index if not exists idx_revision_directories_revision on revision_directories(revision_id);
create index if not exists idx_revision_assets_revision on revision_assets(revision_id);
