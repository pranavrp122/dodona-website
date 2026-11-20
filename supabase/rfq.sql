-- Run once in the Supabase SQL editor, signed in as the project owner.
begin;

create table if not exists public.rfq_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
  company text not null check (char_length(company) between 1 and 120),
  gpu text not null check (gpu in ('H100', 'H200', 'B200', 'A100')),
  gpu_count integer not null check (gpu_count between 1 and 100000),
  start_at timestamptz not null,
  end_at timestamptz not null,
  type text not null check (type in ('cap', 'lock', 'floor')),
  strike numeric(10, 2) check (strike > 0),
  notes text check (char_length(notes) <= 500),
  created_at timestamptz not null default now(),
  check (end_at > start_at)
);

alter table public.rfq_requests enable row level security;
-- No public policies: browser users cannot read or write quote requests.
revoke all on public.rfq_requests from public, anon, authenticated;
grant select, insert, delete on public.rfq_requests to service_role;

commit;
