-- The firm's own recurring automatic tasks. Each occurrence is created once through auto_task_log (rule = 'custom:<id>').
create table if not exists auto_task_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  enabled boolean not null default true,
  title_template text not null check (char_length(title_template) between 1 and 200),
  description_template text not null default '' check (char_length(description_template) <= 5000),
  bullets text[] not null default '{}' check (cardinality(bullets) <= 50),   -- each bullet <= 300 chars is enforced by the API
  cadence text not null check (cadence in ('weekly', 'monthly', 'quarterly', 'yearly')),
  weekday smallint check (weekday between 1 and 7),            -- weekly: 1 = Monday
  day_of_month smallint check (day_of_month between 1 and 31), -- 31 = last day of the month
  month smallint check (month between 1 and 12),               -- yearly: the month; quarterly: 1-3 = month within the quarter
  due_after_days integer check (due_after_days between 0 and 365),
  due_day_of_month smallint check (due_day_of_month between 1 and 31),
  scope text not null default 'all' check (scope in ('all', 'class', 'clients')),
  scope_class_key text,
  assignee_mode text not null default 'resource' check (assignee_mode in ('resource', 'user', 'none')),
  assignee_user_id uuid references users(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (due_after_days is null or due_day_of_month is null)
);
create index if not exists auto_task_rules_enabled_idx on auto_task_rules (enabled) where enabled;

create table if not exists auto_task_rule_clients (
  rule_id uuid not null references auto_task_rules(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  primary key (rule_id, client_id)
);
create index if not exists auto_task_rule_clients_client_idx on auto_task_rule_clients (client_id);

-- The tick only looks at recent log rows.
create index if not exists auto_task_log_created_idx on auto_task_log (created_at);
