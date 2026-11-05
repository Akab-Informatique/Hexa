-- Pipeline like the reference: task kinds (normal, continuous with a reminder, daily that starts over each day),
-- times on a task, a checklist item with its own day, and files.
alter table tasks add column if not exists kind text not null default 'normal' check (kind in ('normal', 'continuous', 'daily'));
alter table tasks add column if not exists start_time text;               -- not planned before this time of the start day
alter table tasks add column if not exists due_time text;
alter table tasks add column if not exists remind_every_days integer;     -- continuous tasks: come back every n days
alter table tasks add column if not exists last_checked_on date;          -- continuous: last "checked" day
alter table tasks add column if not exists last_reset_on date;            -- daily: the day it was last started over
alter table task_checklist add column if not exists due_date date;

create table if not exists task_files (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  name text not null,
  content_type text not null default 'application/octet-stream',
  size integer not null,
  data_b64 text not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists task_files_task_idx on task_files (task_id);
