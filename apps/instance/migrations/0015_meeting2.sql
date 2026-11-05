-- Weekly meeting like the reference: a running list of points (notes, snooze, archive, order), the week planner
-- (events), and engagements in progress.
alter table meeting_points add column if not exists archived_at timestamptz;
alter table meeting_points add column if not exists snooze_until date;
alter table meeting_points add column if not exists position integer not null default 0;
update meeting_points set archived_at = done_at where done and archived_at is null;      -- a settled point goes to the archive

create table if not exists meeting_point_notes (
  id uuid primary key default gen_random_uuid(),
  point_id uuid not null references meeting_points(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists meeting_point_notes_idx on meeting_point_notes (point_id, created_at);

create table if not exists meeting_events (
  id uuid primary key default gen_random_uuid(),
  event_date date not null,
  start_time text,
  end_time text,
  title text not null,
  note text not null default '',
  user_id uuid references users(id) on delete set null,       -- the person it concerns, if any
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists meeting_events_date_idx on meeting_events (event_date);

-- Engagements in progress (files being worked on): client, due day, team, notes.
create table if not exists meeting_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  client_id uuid references clients(id) on delete set null,
  due_date date,
  status text not null default 'open' check (status in ('open', 'done')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists meeting_project_members (
  project_id uuid not null references meeting_projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (project_id, user_id)
);
create table if not exists meeting_project_notes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references meeting_projects(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
