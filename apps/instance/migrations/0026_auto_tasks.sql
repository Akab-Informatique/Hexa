-- Automatic tasks from the tax follow-up: which slips a client has (T4 / RL-1 / T4A), and a log so a task is created once.
alter table client_tracking
  add column if not exists t4_on boolean not null default false,
  add column if not exists rl1_on boolean not null default false,
  add column if not exists t4a_on boolean not null default false;

-- Start from what the follow-up already knows: a slip that was ticked or given an amount (not N/A) is "on".
insert into client_tracking (client_id)
  select distinct client_id from client_filings where kind = 't4rl1' on conflict (client_id) do nothing;
update client_tracking t set
  t4_on = exists (select 1 from client_filings f where f.client_id = t.client_id and f.kind = 't4rl1' and f.item = 't4' and f.status <> 'na'),
  rl1_on = exists (select 1 from client_filings f where f.client_id = t.client_id and f.kind = 't4rl1' and f.item = 'rl1' and f.status <> 'na'),
  t4a_on = exists (select 1 from client_filings f where f.client_id = t.client_id and f.kind = 't4rl1' and f.item = 't4a' and f.status <> 'na');

create table if not exists auto_task_log (
  client_id uuid not null references clients(id) on delete cascade,
  rule text not null,              -- tax, das, payroll, ye_verify, ye_file, t4rl1
  period text not null,            -- what the task is for (month, week's Monday, year...)
  task_id uuid references tasks(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (client_id, rule, period)
);
