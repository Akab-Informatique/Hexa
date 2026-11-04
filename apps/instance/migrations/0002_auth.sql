-- Users, groups, permissions, sessions, audit. Additive only.
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'staff' check (kind in ('staff', 'client')),
  client_id uuid,                              -- set for client users (clients table comes later)
  email text not null,
  name text not null,
  password_hash text not null,
  must_change_password boolean not null default false,
  locale text not null default 'fr',
  active boolean not null default true,
  is_master boolean not null default false,
  failed_logins integer not null default 0,
  locked_until timestamptz,
  totp_secret_enc text,
  totp_enabled boolean not null default false,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists users_email_idx on users (lower(email));

create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null default '',
  audience text not null default 'staff' check (audience in ('staff', 'client')),
  permissions jsonb not null default '[]',
  is_system boolean not null default false,
  locked boolean not null default false,       -- locked groups cannot be edited or deleted
  created_at timestamptz not null default now()
);

create table if not exists user_groups (
  user_id uuid not null references users(id) on delete cascade,
  group_id uuid not null references groups(id) on delete cascade,
  primary key (user_id, group_id)
);

create table if not exists user_permissions (
  user_id uuid not null references users(id) on delete cascade,
  permission text not null,
  effect text not null check (effect in ('allow', 'deny')),
  primary key (user_id, permission)
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  mfa_verified boolean not null default false,
  ip text,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_idx on sessions (user_id);

create table if not exists audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid,
  action text not null,
  target text,
  detail jsonb not null default '{}',
  ip text
);
