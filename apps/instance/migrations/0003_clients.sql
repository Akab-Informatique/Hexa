-- Clients (the firm's customers): profile, contacts, contracts.
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  legal_name text not null default '',
  parent_id uuid references clients(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'inactive', 'prospect')),
  business_number text not null default '',
  fiscal_year_end text not null default '',
  phone text not null default '',
  email text not null default '',
  website text not null default '',
  address text not null default '',
  city text not null default '',
  province text not null default '',
  postal_code text not null default '',
  notes text not null default '',
  quickbooks_id text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists clients_name_idx on clients (lower(name));

create table if not exists client_contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  email text not null default '',
  phone text not null default '',
  title text not null default '',
  is_primary boolean not null default false,
  is_billing boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists client_contacts_client_idx on client_contacts (client_id);

create table if not exists client_contracts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  kind text not null default 'recurring' check (kind in ('recurring', 'hourly', 'fixed', 'hours_bank')),
  amount numeric(12, 2) not null default 0,
  hourly_rate numeric(10, 2),
  cycle text not null default 'monthly' check (cycle in ('monthly', 'quarterly', 'yearly', 'one_time')),
  starts_on date,
  ends_on date,
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  notes text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists client_contracts_client_idx on client_contracts (client_id);
