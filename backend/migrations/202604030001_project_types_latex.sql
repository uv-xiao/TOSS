alter table projects
  add column if not exists project_type text;

update projects p
set project_type = 'latex'
where coalesce(project_type, '') = ''
  and exists (
    select 1
    from project_settings ps
    where ps.project_id = p.id
      and ps.entry_file_path ~* '\.tex$'
  );

update projects
set project_type = coalesce(nullif(project_type, ''), 'typst');

alter table projects
  alter column project_type set default 'typst';

alter table projects
  alter column project_type set not null;

alter table projects
  drop constraint if exists projects_project_type_check;

alter table projects
  add constraint projects_project_type_check
  check (project_type in ('typst', 'latex'));

alter table project_settings
  add column if not exists latex_engine text;

update project_settings ps
set latex_engine = 'xetex'
where coalesce(ps.latex_engine, '') = ''
  and exists (
    select 1
    from projects p
    where p.id = ps.project_id
      and p.project_type = 'latex'
  );

alter table project_settings
  drop constraint if exists project_settings_latex_engine_check;

alter table project_settings
  add constraint project_settings_latex_engine_check
  check (latex_engine is null or latex_engine in ('pdftex', 'xetex'));
