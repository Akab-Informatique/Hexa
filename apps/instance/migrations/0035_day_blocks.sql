-- "My day" planning. A reserved block is time a person sets aside by hand (not a task, not a calendar event);
-- tasks and events are laid out around it. A pin only moves a task block inside one person's day: the task itself is untouched.
create table if not exists day_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  day date not null,
  start_time text not null,
  end_time text not null,
  title text not null,
  created_at timestamptz not null default now()
);
create index if not exists day_blocks_user_day on day_blocks (user_id, day);

create table if not exists day_task_pins (
  user_id uuid not null references users(id) on delete cascade,
  day date not null,
  task_id uuid not null references tasks(id) on delete cascade,
  start_time text not null,
  primary key (user_id, day, task_id)
);
