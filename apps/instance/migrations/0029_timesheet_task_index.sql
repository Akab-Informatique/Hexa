create index if not exists timesheet_entries_task_idx on timesheet_entries (task_id) where task_id is not null;
