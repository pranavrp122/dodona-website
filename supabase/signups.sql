-- Run once in the Supabase SQL editor, signed in as the project owner.
begin;

create table if not exists public.signups (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
  company text not null check (char_length(company) between 1 and 120),
  role text not null check (role in ('buyer', 'provider', 'lender', 'other')),
  use_case text check (char_length(use_case) <= 280),
  website text check (char_length(website) <= 200),
  kyb_status text not null default 'pending' check (kyb_status in ('pending', 'verified')),
  created_at timestamptz not null default now()
);

alter table public.signups enable row level security;
-- No public policies: browser users cannot read or write signups.
revoke all on public.signups from public, anon, authenticated;
grant select, insert, delete on public.signups to service_role;

commit;
