alter table users
  add column if not exists username text;

with normalized as (
  select
    id,
    lower(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            coalesce(
              nullif(split_part(email, '@', 1), ''),
              nullif(display_name, ''),
              'user'
            ),
            '[^a-zA-Z0-9._-]+',
            '-',
            'g'
          ),
          '-{2,}',
          '-',
          'g'
        ),
        '^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$',
        '',
        'g'
      )
    ) as base_raw
  from users
),
prepared as (
  select
    id,
    case
      when base_raw is null or base_raw = '' then concat('user-', substr(md5(id::text), 1, 8))
      when length(base_raw) < 3 then concat(base_raw, substr(md5(id::text), 1, 3 - length(base_raw)))
      else base_raw
    end as base_pretrim
  from normalized
),
bounded as (
  select
    id,
    left(base_pretrim, 32) as base
  from prepared
),
ranked as (
  select
    id,
    base,
    count(*) over (partition by base) as duplicate_count
  from bounded
)
update users u
set username = case
    when duplicate_count = 1 then base
    else concat(left(base, 23), '-', substr(md5(u.id::text), 1, 8))
  end
from ranked
where u.id = ranked.id
  and (u.username is null or btrim(u.username) = '');

update users
set username = concat('user-', substr(md5(id::text), 1, 8))
where username is null
  or btrim(username) = '';

alter table users
  alter column username set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_username_format'
  ) then
    alter table users
      add constraint users_username_format
      check (username ~ '^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])$');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_username_key'
  ) then
    alter table users
      add constraint users_username_key unique (username);
  end if;
end $$;
