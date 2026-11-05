-- Invoicing: payments (partial payments), PO number, emailed mark, due date rule.
alter table invoices add column if not exists po_number text not null default '';
alter table invoices add column if not exists emailed_at timestamptz;
alter table invoices add column if not exists due_manual boolean not null default false;   -- a due date typed by hand is never recomputed

create table if not exists invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  paid_on date not null default current_date,
  amount_cents integer not null check (amount_cents > 0),
  method text not null default 'other',
  reference text not null default '',
  note text not null default '',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists invoice_payments_invoice_idx on invoice_payments (invoice_id);

-- Invoices already marked paid before this migration get one payment for their total so balances add up.
insert into invoice_payments (invoice_id, paid_on, amount_cents, method, note)
select id, coalesce(paid_at::date, current_date), round(total * 100)::int, 'other', 'migrated' from invoices where status = 'paid' and total > 0
 and not exists (select 1 from invoice_payments p where p.invoice_id = invoices.id);
