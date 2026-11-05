-- Dashboards: built-in ones, a personal layout over a shared dashboard, a default dashboard per person.
alter table dashboards add column if not exists slug text unique;                  -- built-in dashboards have a slug and cannot be deleted
alter table dashboards add column if not exists builtin boolean not null default false;

-- "Just for me": a person's own arrangement of a shared dashboard. Without a row, the shared layout is shown.
create table if not exists dashboard_layouts (
  dashboard_id uuid not null references dashboards(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  layout jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  primary key (dashboard_id, user_id)
);

create table if not exists dashboard_defaults (
  user_id uuid primary key references users(id) on delete cascade,
  dashboard_id uuid not null references dashboards(id) on delete cascade
);
