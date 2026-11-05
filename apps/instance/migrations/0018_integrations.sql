-- Real integrations: Mailjet sending, Microsoft 365 per-person sign-in, QuickBooks.
alter table messages drop constraint if exists messages_email_status_check;
alter table messages add constraint messages_email_status_check check (email_status in ('none', 'pending', 'sent', 'failed'));

-- Each person connects their own Microsoft 365 account; only the refresh token is kept (sealed with APP_SECRET).
create table if not exists ms_connections (
  user_id uuid primary key references users(id) on delete cascade,
  email text not null default '',
  refresh_enc text not null,
  access_enc text,
  expires_at timestamptz,
  needs_reauth boolean not null default false,
  connected_at timestamptz not null default now()
);

-- Automatic invoice reminders: one per invoice and level, never twice.
create table if not exists invoice_reminders (
  invoice_id uuid not null references invoices(id) on delete cascade,
  level integer not null,
  sent_at timestamptz not null default now(),
  primary key (invoice_id, level)
);

alter table invoices add column if not exists quickbooks_synced_at timestamptz;
alter table invoices add column if not exists quickbooks_error text not null default '';
