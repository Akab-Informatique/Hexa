-- Several people on one task. tasks.assignee_id stays as the "main" (first) assignee, kept in sync by the API.
create table if not exists task_assignees (
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id)
);
create index if not exists task_assignees_user_idx on task_assignees (user_id);
insert into task_assignees (task_id, user_id) select id, assignee_id from tasks where assignee_id is not null on conflict do nothing;

-- Any writer that only knows assignee_id (auto tasks, seed, imports) still gets its task_assignees row.
create or replace function task_assignee_sync() returns trigger language plpgsql as $$
begin
  if new.assignee_id is not null then
    insert into task_assignees (task_id, user_id) values (new.id, new.assignee_id) on conflict do nothing;
  end if;
  return null;
end $$;
drop trigger if exists tasks_assignee_sync on tasks;
create trigger tasks_assignee_sync after insert or update of assignee_id on tasks for each row execute function task_assignee_sync();
