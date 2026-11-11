-- Services catalogue: fixed recurring services (monthly / quarterly / yearly) and one-time products.
-- The type is derived from services.kind: 'one_time' = product, anything else = recurring (existing rows keep their meaning).

alter table services drop constraint if exists services_kind_check;
alter table services add constraint services_kind_check check (kind in ('monthly', 'quarterly', 'yearly', 'one_time'));
alter table services drop constraint if exists services_price_bounds;
alter table services add constraint services_price_bounds check (price_cents between 0 and 100000000 and cost_cents between 0 and 100000000) not valid;

-- A service attached to a client's contract: own price (already unit_price_cents), own start (added_on), optional end, and a quarterly period.
alter table contract_services drop constraint if exists contract_services_kind_check;
alter table contract_services add constraint contract_services_kind_check check (kind in ('monthly', 'quarterly', 'yearly', 'one_time'));
alter table contract_services add column if not exists ends_on date;
alter table contract_services drop constraint if exists contract_services_dates_check;
alter table contract_services add constraint contract_services_dates_check check (ends_on is null or ends_on >= added_on);
create index if not exists contract_services_service_idx on contract_services (service_id);

-- A product sold to a client is one line of work to bill that remembers its product (null for every other kind of line).
alter table billing_items add column if not exists service_id uuid references services(id) on delete set null;
alter table billing_items add column if not exists taxable boolean not null default true;   -- copied from the service; invoicing reads it
alter table billing_items drop constraint if exists billing_items_service_sane;
alter table billing_items add constraint billing_items_service_sane check (service_id is null or (unit_price >= 0 and quantity > 0 and unit_price * quantity <= 1000000));
create index if not exists billing_items_service_idx on billing_items (service_id) where service_id is not null;
create index if not exists billing_items_client_products_idx on billing_items (client_id, created_at desc) where service_id is not null;
