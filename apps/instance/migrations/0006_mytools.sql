-- My tools: timesheets, knowledge base, procedures.
create table if not exists timesheet_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  work_date date not null,
  minutes integer not null check (minutes > 0 and minutes <= 1440),
  client_id uuid references clients(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  description text not null default '',
  billable boolean not null default true,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected')),
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists timesheet_user_date_idx on timesheet_entries (user_id, work_date);
create index if not exists timesheet_status_idx on timesheet_entries (status);

create table if not exists kb_articles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null default 'Général',
  body text not null default '',
  published boolean not null default true,
  author_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists procedures (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  category text not null default 'Général',
  status text not null default 'draft' check (status in ('draft', 'published')),
  author_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists procedure_steps (
  id uuid primary key default gen_random_uuid(),
  procedure_id uuid not null references procedures(id) on delete cascade,
  position integer not null default 0,
  title text not null,
  body text not null default ''
);
create index if not exists procedure_steps_idx on procedure_steps (procedure_id, position);
