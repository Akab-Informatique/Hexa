-- Tasks: the unit of work for Tasks, the Pipeline, the weekly meeting and timesheets.
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  status text not null default 'todo' check (status in ('todo', 'doing', 'blocked', 'done')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assignee_id uuid references users(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  client_id uuid references clients(id) on delete set null,
  start_date date,
  due_date date,
  estimate_minutes integer,
  visibility text not null default 'team' check (visibility in ('team', 'private', 'selected')),
  parent_id uuid references tasks(id) on delete cascade,
  waits_for_id uuid references tasks(id) on delete set null,
  recurrence jsonb,                          -- {every, unit: day|week|month|year, until?}
  tags text[] not null default '{}',
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tasks_assignee_idx on tasks (assignee_id, status);
create index if not exists tasks_due_idx on tasks (due_date);
create index if not exists tasks_client_idx on tasks (client_id);

create table if not exists task_checklist (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  text text not null,
  done boolean not null default false,
  position integer not null default 0
);
create index if not exists task_checklist_task_idx on task_checklist (task_id);

create table if not exists task_notes (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists task_notes_task_idx on task_notes (task_id);

create table if not exists task_viewers (
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (task_id, user_id)
);
