-- Vendor payments: bills may have no due date; recurring payments; a weekly payroll plan.
alter table vendor_bills alter column due_date drop not null;
alter table vendor_bills alter column due_date drop default;

create table if not exists recurring_payments (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid references vendors(id) on delete set null,
  label text not null,
  amount numeric(12, 2) not null check (amount >= 0),
  frequency text not null check (frequency in ('weekly', 'monthly', 'yearly')),
  next_date date not null,                      -- one date of the payment; the others follow the frequency
  active boolean not null default true,
  in_quickbooks boolean not null default false, -- already entered as bills in QuickBooks: shown, not counted twice in the forecast
  notes text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists payroll_plan (
  user_id uuid primary key references users(id) on delete cascade,
  weekly_amount numeric(12, 2) not null default 0 check (weekly_amount >= 0)
);
