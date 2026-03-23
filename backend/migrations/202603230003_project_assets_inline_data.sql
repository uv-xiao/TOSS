alter table project_assets
  add column if not exists inline_data bytea;

