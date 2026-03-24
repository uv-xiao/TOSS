alter table revisions
  add column if not exists is_complete boolean not null default true;

update revisions
set is_complete = true
where is_complete is null;

create index if not exists idx_revisions_project_complete_created
  on revisions(project_id, created_at desc, id desc)
  where is_complete = true;
