-- Demo data profile a new instance seeds on first start ('none' = empty, the normal case for a real firm).
alter table clients add column if not exists seed_profile text not null default 'none';
