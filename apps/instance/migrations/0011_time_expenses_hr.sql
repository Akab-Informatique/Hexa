-- Timesheets with typed entries and weekly approval, expenses, and the HR ledger (modelled on the reference portal).

-- ---------- Time types (admin-managed labels; the kind drives the rules and is fixed) ----------
create table if not exists time_types (
  key text primary key,
  kind text not null check (kind in ('work', 'workday', 'bankpay', 'other', 'travel', 'vacation', 'sick', 'holiday')),
  label_fr text not null,
  label_en text not null,
  active boolean not null default true,
  built_in boolean not null default false,
  position integer not null default 0
);
insert into time_types (key, kind, label_fr, label_en, built_in, position) values
  ('work', 'work', 'Travail client', 'Client work', true, 10),
  ('workday', 'workday', 'Journée de travail', 'Work day', true, 20),
  ('bankpay', 'bankpay', 'Paiement de banque d''heures', 'Hours bank payout', true, 30),
  ('training', 'other', 'Formation', 'Training', false, 40),
  ('meeting', 'other', 'Réunion', 'Meeting', false, 50),
  ('travel', 'travel', 'Déplacement', 'Travel', true, 60),
  ('vacation', 'vacation', 'Vacances', 'Vacation', true, 70),
  ('sick', 'sick', 'Maladie', 'Sick', true, 80),
  ('holiday', 'holiday', 'Férié', 'Holiday', true, 90)
on conflict (key) do nothing;

alter table timesheet_entries add column if not exists type_key text not null default 'work' references time_types(key);
alter table timesheet_entries add column if not exists start_time text;
alter table timesheet_entries add column if not exists end_time text;
alter table timesheet_entries add column if not exists lunch_minutes integer not null default 0;
alter table timesheet_entries add column if not exists bank_minutes integer not null default 0;
alter table timesheet_entries add column if not exists amount_cents integer;
alter table timesheet_entries add column if not exists billable_minutes integer;
create index if not exists timesheet_type_idx on timesheet_entries (type_key);

-- One row per person and Monday: the unit that is sent, approved, paid.
create table if not exists timesheet_weeks (
  user_id uuid not null references users(id) on delete cascade,
  week_start date not null,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected', 'paid')),
  submitted_at timestamptz,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  reject_reason text not null default '',
  paid_at timestamptz,
  primary key (user_id, week_start)
);
create index if not exists timesheet_weeks_status_idx on timesheet_weeks (status);

-- Weeks that already had entries before this migration keep working: they were sent per entry.
insert into timesheet_weeks (user_id, week_start, status, submitted_at)
select user_id, work_date - ((extract(isodow from work_date)::int) - 1), case when bool_and(status = 'approved') then 'approved' when bool_or(status = 'submitted') then 'submitted' when bool_or(status = 'rejected') then 'rejected' else 'draft' end, case when bool_or(status in ('submitted','approved')) then now() end
  from timesheet_entries group by user_id, work_date - ((extract(isodow from work_date)::int) - 1)
on conflict do nothing;

-- ---------- HR: wage details and the ledger ----------
alter table hr_profiles add column if not exists overtime_hours numeric(5, 2) not null default 40;

-- Three accounts. bank and vacation are in cents (hours x wage), sick is in hundredths of an hour.
create table if not exists hr_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  account text not null check (account in ('bank', 'vacation', 'sick')),
  delta bigint not null,
  kind text not null default 'entry' check (kind in ('entry', 'accrual', 'adjust')),
  reason text not null default '',
  entry_id uuid references timesheet_entries(id) on delete cascade,
  week_start date,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists hr_ledger_user_idx on hr_ledger (user_id, account);
create unique index if not exists hr_ledger_accrual_idx on hr_ledger (user_id, week_start) where kind = 'accrual';

-- ---------- Expenses ----------
create table if not exists expense_types (
  key text primary key,
  label_fr text not null,
  label_en text not null,
  unit text not null default 'none' check (unit in ('none', 'km')),
  rate_cents integer not null default 0,      -- per km for unit 'km'
  billable boolean not null default false,    -- default for new items: billed back to a client
  active boolean not null default true,
  position integer not null default 0
);
insert into expense_types (key, label_fr, label_en, unit, rate_cents, billable, position) values
  ('mileage', 'Kilométrage', 'Mileage', 'km', 70, false, 10),
  ('meal', 'Repas', 'Meals', 'none', 0, false, 20),
  ('parking', 'Stationnement', 'Parking', 'none', 0, true, 30),
  ('supplies', 'Fournitures', 'Supplies', 'none', 0, true, 40),
  ('training', 'Formation', 'Training', 'none', 0, false, 50),
  ('other', 'Autre', 'Other', 'none', 0, false, 60)
on conflict (key) do nothing;

create table if not exists expense_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  title text not null,
  period_start date not null,
  period_end date not null,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  check (period_end >= period_start)
);
create index if not exists expense_reports_user_idx on expense_reports (user_id);

create table if not exists expense_items (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references expense_reports(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  spent_on date not null,
  type_key text not null references expense_types(key),
  description text not null default '',
  amount_cents integer not null default 0,    -- computed (km x rate) for mileage; never shown to the employee
  km numeric(8, 1),
  from_place text not null default '',
  to_place text not null default '',
  client_id uuid references clients(id) on delete set null,
  billable boolean not null default false,
  receipt_name text,
  receipt_type text,
  receipt_b64 text,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'refused', 'paid')),
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  reject_reason text not null default '',
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists expense_items_report_idx on expense_items (report_id);
create index if not exists expense_items_status_idx on expense_items (status);

create table if not exists expense_favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  label text not null,
  type_key text not null references expense_types(key),
  description text not null default '',
  amount_cents integer not null default 0,
  km numeric(8, 1),
  from_place text not null default '',
  to_place text not null default '',
  client_id uuid references clients(id) on delete set null,
  billable boolean not null default false
);
create index if not exists expense_favorites_user_idx on expense_favorites (user_id);

-- Billable expenses become work to bill like billable time.
alter table billing_items drop constraint if exists billing_items_source_check;
alter table billing_items add constraint billing_items_source_check check (source in ('time', 'task', 'manual', 'contract', 'expense'));
