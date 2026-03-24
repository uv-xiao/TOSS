alter table revisions
  add column if not exists parent_revision_id uuid references revisions(id) on delete set null;

alter table revisions
  add column if not exists storage_kind text not null default 'full';

update revisions
set storage_kind = 'full'
where storage_kind is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'revisions_storage_kind_check'
  ) then
    alter table revisions
      add constraint revisions_storage_kind_check
      check (storage_kind in ('full', 'diff'));
  end if;
end $$;

create index if not exists idx_revisions_parent_revision on revisions(parent_revision_id);

create table if not exists revision_document_changes (
  revision_id uuid not null references revisions(id) on delete cascade,
  path text not null,
  change_kind text not null check (change_kind in ('upsert', 'delete')),
  content text,
  primary key (revision_id, path)
);

create table if not exists revision_directory_changes (
  revision_id uuid not null references revisions(id) on delete cascade,
  path text not null,
  change_kind text not null check (change_kind in ('upsert', 'delete')),
  primary key (revision_id, path)
);

create table if not exists revision_asset_changes (
  revision_id uuid not null references revisions(id) on delete cascade,
  path text not null,
  change_kind text not null check (change_kind in ('upsert', 'delete')),
  object_key text,
  content_type text,
  size_bytes bigint,
  inline_data bytea,
  primary key (revision_id, path)
);

create index if not exists idx_revision_document_changes_revision on revision_document_changes(revision_id);
create index if not exists idx_revision_directory_changes_revision on revision_directory_changes(revision_id);
create index if not exists idx_revision_asset_changes_revision on revision_asset_changes(revision_id);
