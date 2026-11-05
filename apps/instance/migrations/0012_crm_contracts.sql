-- CRM: classification, billing contact and per-client invoice settings; service catalogue; contract services and activity.

create table if not exists client_classes (
  key text primary key,
  label_fr text not null,
  label_en text not null,
  color text not null default '#7c3aed',
  position integer not null default 0
);
insert into client_classes (key, label_fr, label_en, color, position) values
  ('bronze', 'Bronze', 'Bronze', '#b45309', 10),
  ('silver', 'Argent', 'Silver', '#94a3b8', 20),
  ('gold', 'Or', 'Gold', '#f59e0b', 30)
on conflict (key) do nothing;

alter table clients add column if not exists class_key text references client_classes(key) on delete set null;
alter table clients add column if not exists billing_contact_id uuid references client_contacts(id) on delete set null;
alter table clients add column if not exists billing_email text not null default '';
alter table clients add column if not exists terms_days integer;                       -- null = the firm's default
alter table clients add column if not exists po_required boolean not null default false;
alter table clients add column if not exists auto_approve_kinds text[] not null default '{}';  -- kinds of work to bill approved on arrival
alter table clients add column if not exists invoice_notes text not null default '';

-- Catalogue of what the firm sells besides hours.
create table if not exists services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  kind text not null default 'monthly' check (kind in ('monthly', 'yearly', 'one_time')),
  price_cents integer not null default 0,
  cost_cents integer not null default 0,
  taxable boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists services_name_idx on services (lower(name));

alter table client_contracts add column if not exists billing_period text not null default 'monthly' check (billing_period in ('monthly', 'yearly'));
alter table client_contracts add column if not exists billed_through date;             -- charges up to this day were invoiced elsewhere
alter table client_contracts add column if not exists support_default boolean not null default false;
alter table client_contracts add column if not exists bank_hours numeric(8, 2);

-- A service on a contract keeps its own name and price (changing the catalogue never moves a contract).
create table if not exists contract_services (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references client_contracts(id) on delete cascade,
  service_id uuid references services(id) on delete set null,
  name text not null,
  kind text not null default 'monthly' check (kind in ('monthly', 'yearly', 'one_time')),
  unit_price_cents integer not null default 0,
  quantity numeric(8, 2) not null default 1 check (quantity > 0),
  added_on date not null,
  created_at timestamptz not null default now()
);
create index if not exists contract_services_contract_idx on contract_services (contract_id);

create table if not exists contract_events (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references client_contracts(id) on delete cascade,
  kind text not null,
  detail text not null default '',
  user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists contract_events_contract_idx on contract_events (contract_id, created_at desc);

-- Existing contracts without a start day take their creation day (the schedule needs one).
update client_contracts set starts_on = created_at::date where starts_on is null;

-- Work to bill made from contract services remembers its contract (so a contract that billed anything is stopped, not deleted).
alter table billing_items add column if not exists contract_id uuid references client_contracts(id) on delete set null;
alter table billing_items add column if not exists excluded_reason text not null default '';
