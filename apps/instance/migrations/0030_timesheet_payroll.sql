-- Timesheet as the payroll record: entries made by the task timer, an audit history, and indexes for the payroll queries.

-- Where an entry came from, the minutes the timer really measured, and the original day when a stretch had to be carried
-- to the next open week (the week of that day was already sent or approved).
alter table timesheet_entries add column if not exists source text not null default 'manual';
alter table timesheet_entries add column if not exists measured_minutes integer;
alter table timesheet_entries add column if not exists origin_date date;
alter table timesheet_entries add column if not exists updated_at timestamptz not null default now();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'timesheet_entries_source_check') then
    alter table timesheet_entries add constraint timesheet_entries_source_check check (source in ('timer', 'manual'));
  end if;
end $$;

-- Every create, edit, delete and reopen of an entry. No foreign key on entry_id: the trail outlives a deleted entry.
create table if not exists timesheet_entry_history (
  id bigserial primary key,
  entry_id uuid not null,
  user_id uuid not null,
  actor_id uuid,
  action text not null check (action in ('create', 'update', 'delete', 'reopen')),
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);
create index if not exists timesheet_entry_history_entry_idx on timesheet_entry_history (entry_id, at);
create index if not exists timesheet_entry_history_user_idx on timesheet_entry_history (user_id, at);

-- Payroll queries: all employees over a date range, one employee over a date range, grouped by client and task.
create index if not exists timesheet_date_user_idx on timesheet_entries (work_date, user_id);
create index if not exists timesheet_user_status_date_idx on timesheet_entries (user_id, status, work_date);
create index if not exists timesheet_task_idx on timesheet_entries (task_id) where task_id is not null;
create index if not exists timesheet_client_idx on timesheet_entries (client_id) where client_id is not null;
create index if not exists timesheet_weeks_week_idx on timesheet_weeks (week_start, user_id);
create unique index if not exists task_time_segments_entry_idx on task_time_segments (entry_id) where entry_id is not null;

-- Stretches still waiting from before this change become draft entries, so no minute stays outside the timesheet.
-- Only when the week of the day is still open; the others are finished by the person (they carry to the next open week).
with src as (
  select gen_random_uuid() as eid, s.id as sid, s.user_id, s.task_id, s.minutes, t.client_id, left(t.title, 1000) as title,
         (s.started_at at time zone 'America/Toronto')::date as d
    from task_time_segments s join tasks t on t.id = s.task_id
   where s.status = 'pending' and s.entry_id is null
), open_src as (
  select * from src x
   where not exists (select 1 from timesheet_weeks w where w.user_id = x.user_id and w.week_start = x.d - (extract(isodow from x.d)::int - 1) and w.status not in ('draft', 'rejected'))
), ins as (
  insert into timesheet_entries (id, user_id, work_date, type_key, minutes, client_id, task_id, description, billable, status, source, measured_minutes)
  select eid, user_id, d, 'work', least(minutes, 1440), client_id, task_id, title, client_id is not null, 'draft', 'timer', least(minutes, 1440) from open_src
  returning id
)
update task_time_segments s set status = 'logged', entry_id = o.eid from open_src o where s.id = o.sid and o.eid in (select id from ins);
