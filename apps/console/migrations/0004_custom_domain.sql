-- Optional custom host name a client points its own DNS at (CNAME to the default address). Primary address when set.
alter table clients add column if not exists custom_domain text;
create unique index if not exists clients_custom_domain_uidx on clients (custom_domain) where custom_domain is not null;
