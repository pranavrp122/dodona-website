-- Demo platform CRM mirror. Run once in the Supabase SQL editor, signed in as the project owner.
-- The demo server's SQLite database stays the source of truth; lib/crm-mirror.mjs upserts these tables
-- through PostgREST when DEMO_SUPABASE_MIRROR=1 and deletes rows a demo reset removed. Primary keys are the SQLite ids, so re-running a sync
-- updates rows in place. No password hashes, session tokens or card details are ever sent here.
begin;

create table if not exists public.demo_accounts (
  id text primary key,
  email text not null,
  company text,
  role text not null check (role in ('buyer', 'lender', 'provider', 'admin')),
  kyb text check (kyb in ('pending', 'verified', 'rejected')),
  stage text check (stage in ('lead', 'demo', 'kyb', 'active', 'churned')),
  phone text,
  neocloud_id text,
  demo_now timestamptz,
  scenario text,
  last_active_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists public.demo_notes (
  id text primary key,
  account_id text not null,
  author text,
  text text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists public.demo_orders (
  ref text primary key,
  account_id text not null,
  offer_id text,
  neocloud_id text,
  gpu text,
  gpu_count integer,
  region text,
  kind text,
  strike numeric(12, 4),
  window_start timestamptz,
  window_end timestamptz,
  status text not null,
  delivery_choice text,
  premium_per_gpu_hour numeric(12, 4),
  premium_total numeric(14, 2),
  platform_fee numeric(14, 2),
  pay_now numeric(14, 2),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

-- Orders no longer carry a flat per-order fee. Re-running this file drops the old column from an existing project.
alter table public.demo_orders drop column if exists booking_fee;

-- A payment summary: amount and outcome only. The card brand, last four digits and every other card detail stay out.
create table if not exists public.demo_payments (
  id text primary key,
  order_ref text not null,
  account_id text,
  amount numeric(14, 2),
  status text not null,
  outcome text,                       -- empty when approved, else card_declined, insufficient_funds or invalid_card
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists public.demo_settlements (
  order_ref text primary key,
  account_id text,
  kind text,
  window_avg numeric(12, 4),
  strike numeric(12, 4),
  hours numeric(14, 2),
  compute_bill numeric(14, 2),
  saving numeric(14, 2),
  payout numeric(14, 2),
  resale_proceeds numeric(14, 2),
  premium_paid numeric(14, 2),
  net_result numeric(14, 2),
  computed_at timestamptz,
  updated_at timestamptz not null
);

-- Failures from the per-account activity log: failed API calls (status 400 or more), browser errors and failed sign-ins.
-- detail holds the method, path, status, time taken and the error code and message; never a request body, an input value or card data.
create table if not exists public.demo_activity_failures (
  id bigint primary key,
  account_id text,
  session_id text,                    -- first eight characters of the session token's hash, not the token
  at timestamptz not null,
  kind text not null check (kind in ('api', 'error', 'auth')),
  page text,
  target text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null
);

create index if not exists demo_notes_account_idx on public.demo_notes (account_id);
create index if not exists demo_activity_failures_account_idx on public.demo_activity_failures (account_id, at desc);
create index if not exists demo_orders_account_idx on public.demo_orders (account_id);
create index if not exists demo_payments_order_idx on public.demo_payments (order_ref);

-- Row level security on, with no public policies: only the server's service role key can read or write.
alter table public.demo_accounts enable row level security;
alter table public.demo_notes enable row level security;
alter table public.demo_orders enable row level security;
alter table public.demo_payments enable row level security;
alter table public.demo_settlements enable row level security;
alter table public.demo_activity_failures enable row level security;

revoke all on public.demo_accounts, public.demo_notes, public.demo_orders, public.demo_payments, public.demo_settlements, public.demo_activity_failures from public, anon, authenticated;
grant select, insert, update, delete on public.demo_accounts, public.demo_notes, public.demo_orders, public.demo_payments, public.demo_settlements, public.demo_activity_failures to service_role;

commit;
