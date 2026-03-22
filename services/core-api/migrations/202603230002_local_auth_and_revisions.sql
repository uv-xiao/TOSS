create table if not exists local_accounts (
  user_id uuid primary key references users(id) on delete cascade,
  password_hash text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists auth_settings (
  id int primary key check (id = 1),
  allow_local_login boolean not null default true,
  allow_local_registration boolean not null default true,
  allow_oidc boolean not null default true,
  oidc_issuer text,
  oidc_client_id text,
  oidc_client_secret text,
  oidc_redirect_uri text,
  oidc_groups_claim text not null default 'groups',
  updated_at timestamptz not null
);

insert into auth_settings (
  id,
  allow_local_login,
  allow_local_registration,
  allow_oidc,
  oidc_issuer,
  oidc_client_id,
  oidc_client_secret,
  oidc_redirect_uri,
  oidc_groups_claim,
  updated_at
)
values (1, true, true, true, null, null, null, null, 'groups', now())
on conflict (id) do nothing;

create table if not exists revision_documents (
  revision_id uuid not null references revisions(id) on delete cascade,
  path text not null,
  content text not null,
  primary key (revision_id, path)
);

create table if not exists revision_authors (
  revision_id uuid not null references revisions(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (revision_id, user_id)
);

create index if not exists idx_revision_documents_revision on revision_documents(revision_id);
create index if not exists idx_revision_authors_revision on revision_authors(revision_id);
