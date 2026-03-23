create table if not exists project_user_archives (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  archived_at timestamptz not null,
  primary key (project_id, user_id)
);

create index if not exists idx_project_user_archives_user
  on project_user_archives(user_id);

insert into project_user_archives (project_id, user_id, archived_at)
select p.id, pr.user_id, coalesce(p.archived_at, now())
from projects p
join project_roles pr on pr.project_id = p.id
where p.archived_at is not null
on conflict (project_id, user_id) do nothing;

drop index if exists idx_projects_archived_at;
alter table projects drop column if exists archived_by;
alter table projects drop column if exists archived_at;
