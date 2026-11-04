-- Internal accounting: work to bill, invoices, vendors and the bills we owe.
create sequence if not exists invoice_number_seq start 1001;

create table if not exists billing_items (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete restrict,
  source text not null default 'manual' check (source in ('time', 'task', 'manual', 'contract')),
  source_id uuid,
  description text not null,
  quantity numeric(10, 2) not null default 1,
  unit_price numeric(12, 2) not null default 0,
  status text not null default 'pending' check (status in ('pending', 'approved', 'excluded', 'invoiced')),
  reason text not null default '',
  work_date date,
  created_by uuid references users(id) on delete set null,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  invoice_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists billing_items_status_idx on billing_items (status, client_id);
create unique index if not exists billing_items_source_idx on billing_items (source, source_id) where source_id is not null;

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  client_id uuid not null references clients(id) on delete restrict,
  status text not null default 'draft' check (status in ('draft', 'sent', 'paid', 'void')),
  issue_date date not null default current_date,
  due_date date not null default current_date,
  notes text not null default '',
  subtotal numeric(12, 2) not null default 0,
  gst numeric(12, 2) not null default 0,
  qst numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,
  sent_at timestamptz,
  paid_at timestamptz,
  quickbooks_id text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists invoices_client_idx on invoices (client_id);

create table if not exists invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  position integer not null default 0,
  description text not null,
  quantity numeric(10, 2) not null default 1,
  unit_price numeric(12, 2) not null default 0,
  taxable boolean not null default true,
  amount numeric(12, 2) not null default 0,
  billing_item_id uuid
);
create index if not exists invoice_lines_idx on invoice_lines (invoice_id, position);

create table if not exists vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text not null default '',
  email text not null default '',
  phone text not null default '',
  payment_terms text not null default '',
  notes text not null default '',
  active boolean not null default true,
  quickbooks_id text,
  created_at timestamptz not null default now()
);

create table if not exists vendor_bills (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  number text not null default '',
  bill_date date not null default current_date,
  due_date date not null default current_date,
  amount numeric(12, 2) not null default 0,
  status text not null default 'unpaid' check (status in ('unpaid', 'scheduled', 'paid')),
  paid_on date,
  notes text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists vendor_bills_status_idx on vendor_bills (status, due_date);
