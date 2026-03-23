alter table projects
  add column if not exists owner_user_id uuid references users(id);

update projects p
set owner_user_id = ranked.user_id
from (
  select project_id,
         user_id,
         row_number() over (
           partition by project_id
           order by case role when 'Owner' then 0 else 1 end, granted_at asc
         ) as rn
  from project_roles
) ranked
where p.id = ranked.project_id
  and ranked.rn = 1
  and p.owner_user_id is null;

create index if not exists idx_projects_owner_user on projects(owner_user_id);

alter table projects
  add column if not exists archived_at timestamptz;

alter table projects
  add column if not exists archived_by uuid references users(id);

create index if not exists idx_projects_archived_at on projects(archived_at);
