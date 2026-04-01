alter table auth_settings
  add column if not exists announcement text not null default '';

