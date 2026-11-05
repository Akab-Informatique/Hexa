-- SharePoint folder access managed in the portal. A rule grants a user or a group a level on a folder
-- (path inside a library, '' = the library root); it applies to everything below (inheritance by path prefix).
create table if not exists doc_access (
  id uuid primary key default gen_random_uuid(),
  drive_id text not null,
  drive_name text not null default '',
  path text not null default '',
  principal_type text not null check (principal_type in ('user', 'group')),
  principal_id uuid not null,
  level text not null check (level in ('view', 'edit')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (drive_id, path, principal_type, principal_id)
);
create index if not exists doc_access_drive_idx on doc_access (drive_id);
