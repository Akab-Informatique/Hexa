-- Command center message board, documentation links, integration credentials.
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  pinned boolean not null default false,
  audience text not null default 'all' check (audience in ('all', 'selected')),
  author_id uuid references users(id) on delete set null,
  email_copy boolean not null default false,
  email_status text not null default 'none' check (email_status in ('none', 'pending', 'sent')),
  created_at timestamptz not null default now()
);

create table if not exists message_targets (
  message_id uuid not null references messages(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  primary key (message_id, client_id)
);

create table if not exists doc_links (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  url text not null,
  description text not null default '',
  category text not null default 'Général',
  client_id uuid references clients(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists integrations (
  provider text primary key,
  config jsonb not null default '{}',        -- non-secret settings
  secret_enc text,                           -- AES-GCM sealed JSON, never returned by the API
  enabled boolean not null default false,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
