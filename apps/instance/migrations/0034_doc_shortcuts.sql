-- Documentation is only the firm's SharePoint (browsed through the portal): the locally stored link list is gone.
drop table if exists doc_links;

-- Folder shortcuts shown above the documents. user_id null = shared with everyone who can open the folder
-- (set by managers); otherwise a personal shortcut. A shortcut never grants access: folder rules still decide.
create table if not exists doc_shortcuts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  drive_id text not null,
  path text not null default '',
  label text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists doc_shortcuts_unique on doc_shortcuts (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), drive_id, lower(path));
