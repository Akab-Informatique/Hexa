create table if not exists clients (
  id text primary key,                       -- slug, e.g. "acme"
  name text not null,
  domain text not null,
  plan text not null default 'standard',
  max_users integer,
  modules text[] not null default '{}',
  flags jsonb not null default '{}',
  branding jsonb not null default '{}',
  pinned_version text not null,
  channel text not null default 'stable',
  license_key_enc text not null,             -- AES-256-GCM, so the bundle can be re-downloaded
  secrets_enc text not null,                 -- encrypted JSON: db password, updater + admin tokens
  active boolean not null default true,
  expires_at timestamptz,
  app_port integer not null default 3000,
  notes text not null default '',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_version text,
  last_health text,
  last_user_count integer
);

create table if not exists releases (
  version text primary key,
  channel text not null default 'stable',
  notes text not null default '',
  created_at timestamptz not null default now()
);
