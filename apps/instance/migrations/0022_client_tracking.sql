-- Tax follow-up calendar (replaces the firm's "Clients calendrier" spreadsheet).
-- One settings row per client, and one row per ticked box of the calendar (a missing row means "to do").
create table if not exists client_tracking (
  client_id uuid primary key references clients(id) on delete cascade,
  resource_id uuid references users(id) on delete set null,       -- who looks after the file ("Ressource")
  fiscal_month smallint check (fiscal_month between 1 and 12),    -- month the fiscal year ends ("FA")
  books_through date,                                             -- bookkeeping done up to ("TL fait jusqu'à")
  check_frequency text not null default '' check (check_frequency in ('', 'monthly', 'quarterly', 'semiannual')),
  das_filer text not null default '' check (das_filer in ('', 'us', 'them', 'them_ccq_us')),   -- who files the DAS
  payroll_period text not null default '' check (payroll_period in ('', 'weekly', 'biweekly', 'semimonthly', 'monthly')),
  payroll_system text not null default '',
  payroll_note text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists client_filings (
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null check (kind in ('das', 'tax', 'payroll', 'yearend', 't4rl1', 'rl31', 't5', 'verify')),
  period text not null,            -- 'YYYY-MM' for monthly kinds, 'YYYY' for yearly ones
  item text not null default '',   -- das: fed|prov|ccq; yearend: stage; t4rl1: t4|t4sum|rl1|t4a|rl1sum|car|cnesst; others ''
  status text not null default 'done' check (status in ('done', 'na', 'progress', 'review')),
  amount numeric(14, 2),           -- T4/RL1 summary and T5 amounts
  note text not null default '',
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (client_id, kind, period, item)
);
create index if not exists client_filings_period_idx on client_filings (kind, period);
