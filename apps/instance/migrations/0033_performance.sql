-- Performance (measured with 5,000 tasks / 1,000 clients / 50,000 timesheet entries).
-- Every task list row counts its subtasks (tasks.parent_id = t.id); with no index each row scanned the whole task table
-- (500 rows x 5,000 tasks per list call). The FK "on delete cascade" on parent_id needed the same index when a task is deleted.
create index if not exists tasks_parent_idx on tasks (parent_id) where parent_id is not null;

-- timesheet_task_idx (0030) and timesheet_entries_task_idx (0029) are the same partial index on timesheet_entries (task_id):
-- keep one, so every timesheet write maintains one index fewer.
drop index if exists timesheet_entries_task_idx;
