create table if not exists organization_memberships (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  joined_at timestamptz not null,
  primary key (organization_id, user_id)
);

create index if not exists idx_organization_memberships_user
  on organization_memberships(user_id);

insert into organization_memberships (organization_id, user_id, joined_at)
select oa.organization_id, oa.user_id, oa.granted_at
from org_admins oa
on conflict (organization_id, user_id) do nothing;

insert into organization_memberships (organization_id, user_id, joined_at)
select o.id, u.id, now()
from users u
join lateral (
  select id from organizations order by created_at asc limit 1
) o on true
where not exists (
    select 1 from organization_memberships om where om.user_id = u.id
)
and not exists (
    select 1 from org_admins oa where oa.user_id = u.id
)
on conflict (organization_id, user_id) do nothing;

create table if not exists project_organization_access (
  project_id uuid not null references projects(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  permission text not null check (permission in ('read', 'write')),
  granted_by uuid references users(id),
  granted_at timestamptz not null,
  primary key (project_id, organization_id)
);

create index if not exists idx_project_organization_access_org
  on project_organization_access(organization_id);

alter table project_share_links
  add column if not exists token_value text;

with active_ranked as (
  select id,
         row_number() over (
           partition by project_id, permission
           order by created_at desc
         ) as rn
  from project_share_links
  where revoked_at is null
)
update project_share_links p
set revoked_at = now()
from active_ranked ar
where p.id = ar.id
  and ar.rn > 1
  and p.revoked_at is null;

create unique index if not exists idx_project_share_links_active_unique
  on project_share_links(project_id, permission)
  where revoked_at is null;
