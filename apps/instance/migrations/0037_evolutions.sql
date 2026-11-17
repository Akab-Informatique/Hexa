-- Portal backlog: what the firm wants added or changed in the portal. Additive only.
create table if not exists portal_evolutions (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 300),
  details text not null default '' check (length(details) <= 10000),
  priority integer not null default 5 check (priority between 1 and 10),
  status text not null default 'todo' check (status in ('todo', 'review', 'done')),
  sop_id uuid references procedures(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists portal_evolutions_status_idx on portal_evolutions (status, priority desc, created_at);

create table if not exists evolution_comments (
  id uuid primary key default gen_random_uuid(),
  evolution_id uuid not null references portal_evolutions(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  body text not null check (length(body) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index if not exists evolution_comments_idx on evolution_comments (evolution_id, created_at);

create table if not exists evolution_images (
  id uuid primary key default gen_random_uuid(),
  evolution_id uuid not null references portal_evolutions(id) on delete cascade,
  name text not null,
  content_type text not null check (content_type in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  size integer not null,
  data_b64 text not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists evolution_images_idx on evolution_images (evolution_id);
