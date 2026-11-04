-- HR: one profile per staff member, and absences (shared with the weekly meeting).
create table if not exists hr_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  job_title text not null default '',
  hire_date date,
  phone text not null default '',
  emergency_contact text not null default '',
  hourly_wage numeric(10, 2),
  vacation_hours numeric(8, 2) not null default 0,
  sick_days numeric(6, 2) not null default 0,
  notes text not null default ''
);

create table if not exists absences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null default 'vacation' check (kind in ('vacation', 'sick', 'training', 'personal', 'other')),
  starts_on date not null,
  ends_on date not null,
  note text not null default '',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index if not exists absences_dates_idx on absences (starts_on, ends_on);
