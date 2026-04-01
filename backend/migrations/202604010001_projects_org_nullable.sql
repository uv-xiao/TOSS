drop index if exists idx_projects_org;

alter table projects
  drop column if exists organization_id;
