-- Client portal: a CRM contact can be given a sign-in (a client user), set up through a one-time link.
alter table client_contacts add column if not exists user_id uuid references users(id) on delete set null;
create unique index if not exists client_contacts_user_idx on client_contacts (user_id) where user_id is not null;

-- One-time links to set a password (welcome email). Only the hash is stored.
create table if not exists password_tokens (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists password_tokens_user_idx on password_tokens (user_id);

-- A folder rule can also be given to a whole client (all of its portal users).
alter table doc_access drop constraint if exists doc_access_principal_type_check;
alter table doc_access add constraint doc_access_principal_type_check check (principal_type in ('user', 'group', 'client'));
