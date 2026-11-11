-- Traceability of the tax follow-up: an unticked box keeps its row (status "todo") so "who last changed it" survives,
-- and every change is also written to a log.
alter table client_filings drop constraint if exists client_filings_status_check;
alter table client_filings add constraint client_filings_status_check check (status in ('todo', 'done', 'na', 'progress', 'review'));
alter table client_filings add column if not exists prev_status text not null default '';

create table if not exists client_filing_log (
  id bigserial primary key,
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null, period text not null, item text not null default '',
  from_status text not null, to_status text not null,
  user_id uuid references users(id) on delete set null,
  at timestamptz not null default now()
);
create index if not exists client_filing_log_idx on client_filing_log (client_id, kind, period, item, at desc);
