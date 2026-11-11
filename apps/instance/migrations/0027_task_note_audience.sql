-- A task comment is either internal (the team only) or addressed to the client.
alter table task_notes add column if not exists audience text not null default 'internal' check (audience in ('internal', 'client'));
