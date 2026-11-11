-- Resource kept as plain text when the person has no staff account yet (the spreadsheet import), and "annual" checks.
alter table client_tracking add column if not exists resource_label text not null default '';
alter table client_tracking drop constraint if exists client_tracking_check_frequency_check;
alter table client_tracking add constraint client_tracking_check_frequency_check check (check_frequency in ('', 'monthly', 'quarterly', 'semiannual', 'annual'));
