-- Task status "taken over" (prise en charge) between new and in progress.
-- Keys stay as they were so everything else keeps working: todo = New, taken = Taken over, doing = In progress,
-- blocked = Waiting for customer, done = Completed.
alter table tasks drop constraint if exists tasks_status_check;
alter table tasks add constraint tasks_status_check check (status in ('todo', 'taken', 'doing', 'blocked', 'done'));

-- One running timer per person. It lives on the server so it keeps running when the task is closed or the page is left.
create table if not exists task_timers (
  user_id uuid primary key references users(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  started_at timestamptz not null default now()
);

-- Every stopped stretch of time: waits as "pending" until it becomes a time entry (now or later) or is dropped.
create table if not exists task_time_segments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  started_at timestamptz not null,
  stopped_at timestamptz not null default now(),
  minutes integer not null check (minutes >= 1),
  status text not null default 'pending' check (status in ('pending', 'logged', 'discarded')),
  entry_id uuid references timesheet_entries(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists task_time_segments_task_idx on task_time_segments (task_id, status);
create index if not exists task_time_segments_user_idx on task_time_segments (user_id, status);
