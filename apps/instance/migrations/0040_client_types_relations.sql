-- Business or individual, and family / other links between clients. Each client stays its own record.
alter table clients add column if not exists client_type text not null default 'business' check (client_type in ('business','individual'));

-- A row (client_a, client_b, 'parent') reads "client_a is the parent of client_b". 'child' is accepted but the API stores the flipped 'parent' row.
-- spouse / married / other are symmetric. This is the family link; the grouping hierarchy stays clients.parent_id.
create table if not exists client_relations (
  id uuid primary key default gen_random_uuid(),
  client_a uuid not null references clients(id) on delete cascade,
  client_b uuid not null references clients(id) on delete cascade,
  kind text not null check (kind in ('spouse','married','parent','child','other')),
  label text not null default '',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (client_a <> client_b)
);
create unique index if not exists client_relations_pair_uq on client_relations (least(client_a::text, client_b::text), greatest(client_a::text, client_b::text), kind);
create index if not exists client_relations_a_idx on client_relations (client_a);
create index if not exists client_relations_b_idx on client_relations (client_b);

-- Where the client came from.
alter table clients add column if not exists referral_source text not null default '' check (referral_source in ('','word_of_mouth','facebook','website','other'));
alter table clients add column if not exists referral_name text not null default '';
alter table clients add column if not exists referral_client_id uuid references clients(id) on delete set null;
alter table clients add column if not exists referral_detail text not null default '';
