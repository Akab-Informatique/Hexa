-- The SharePoint folder that holds an employee's HR documents. Only a pointer: who may open it is still decided by the portal's folder rules.
create table if not exists hr_folders (
  user_id uuid primary key references users(id) on delete cascade,
  drive_id text not null,
  path text not null,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
