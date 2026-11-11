-- Fiche d'information client (A Bezeau): identification numbers, tax / payroll-remittance schedules, accounting software.
-- Frequency keys: monthly, quarterly, annual. The "date" is free text (e.g. "15" for the 15th, or "03-31").
alter table clients
  add column if not exists identification_number text not null default '',
  add column if not exists neq text not null default '',
  add column if not exists ccq text not null default '',
  add column if not exists rbq text not null default '',
  add column if not exists tax_frequency text not null default '',
  add column if not exists tax_date text not null default '',
  add column if not exists das_frequency text not null default '',
  add column if not exists das_date text not null default '',
  add column if not exists software text not null default '';
