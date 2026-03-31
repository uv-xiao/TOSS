create extension if not exists "uuid-ossp";

-- Organization membership now carries ownership semantics.
alter table organization_memberships
  add column if not exists role text;

update organization_memberships
set role = coalesce(nullif(role, ''), 'member');

-- Backfill legacy org_admins into owner memberships before dropping it.
insert into organization_memberships (organization_id, user_id, joined_at, role)
select oa.organization_id, oa.user_id, oa.granted_at, 'owner'
from org_admins oa
on conflict (organization_id, user_id) do update
set role = 'owner';

alter table organization_memberships
  alter column role set default 'member';
alter table organization_memberships
  alter column role set not null;
alter table organization_memberships
  drop constraint if exists organization_memberships_role_check;
alter table organization_memberships
  add constraint organization_memberships_role_check
  check (role in ('member', 'owner'));

-- Site admins are represented by owners of a dedicated site-admin organization.
insert into organizations (id, name, created_at)
values ('00000000-0000-0000-0000-000000000001', 'Site Admins', now())
on conflict (id) do nothing;

insert into organization_memberships (organization_id, user_id, joined_at, role)
select '00000000-0000-0000-0000-000000000001'::uuid, u.id, now(), 'owner'
from users u
where lower(u.email) = 'admin@example.com'
on conflict (organization_id, user_id) do update
set role = 'owner';

drop table if exists org_admins;

-- Simplify project role model.
alter table project_roles
  drop constraint if exists project_roles_role_check;

update project_roles
set role = case role
  when 'Owner' then 'Owner'
  when 'ReadWrite' then 'ReadWrite'
  when 'ReadOnly' then 'ReadOnly'
  else 'ReadWrite'
end;
alter table project_roles
  add constraint project_roles_role_check
  check (role in ('Owner', 'ReadWrite', 'ReadOnly'));

alter table project_group_roles
  drop constraint if exists project_group_roles_role_check;

update project_group_roles
set role = case role
  when 'Owner' then 'Owner'
  when 'ReadWrite' then 'ReadWrite'
  when 'ReadOnly' then 'ReadOnly'
  else 'ReadWrite'
end;
alter table project_group_roles
  add constraint project_group_roles_role_check
  check (role in ('Owner', 'ReadWrite', 'ReadOnly'));

-- OIDC group mappings now map to organization membership role.
alter table org_oidc_group_role_mappings
  drop constraint if exists org_oidc_group_role_mappings_role_check;

update org_oidc_group_role_mappings
set role = case role
  when 'Owner' then 'owner'
  when 'Teacher' then 'owner'
  when 'TA' then 'owner'
  when 'Student' then 'member'
  when 'Viewer' then 'member'
  when 'ReadWrite' then 'member'
  when 'ReadOnly' then 'member'
  else 'member'
end;
alter table org_oidc_group_role_mappings
  add constraint org_oidc_group_role_mappings_role_check
  check (role in ('member', 'owner'));
