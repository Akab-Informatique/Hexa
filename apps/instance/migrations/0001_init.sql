-- Core instance tables. Migrations must be additive/idempotent: clients may skip versions.
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
