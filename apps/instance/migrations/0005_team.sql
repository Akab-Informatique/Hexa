-- Team: customizable dashboards (shareable, lockable) and the weekly team meeting.
create table if not exists dashboards (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references users(id) on delete cascade,
  visibility text not null default 'private' check (visibility in ('private', 'team')),
  team_access text not null default 'view' check (team_access in ('view', 'edit')),
  locked boolean not null default false,     -- locked: only holders of team.dashboard.lock can change the layout
  layout jsonb not null default '[]',        -- [{id, type, size}]
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists dashboard_members (
  dashboard_id uuid not null references dashboards(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  access text not null default 'view' check (access in ('view', 'edit')),
  primary key (dashboard_id, user_id)
);

create table if not exists meeting_points (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,                  -- the Monday of the week the point is for
  kind text not null default 'point' check (kind in ('point', 'hot', 'issue')),
  title text not null,
  body text not null default '',
  author_id uuid references users(id) on delete set null,
  done boolean not null default false,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists meeting_points_week_idx on meeting_points (week_start);
