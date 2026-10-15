-- Run once in the Supabase SQL editor, signed in as the project owner.
begin;

create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
  interest text check (interest in ('Individual trading', 'Business hedging', 'Partnership')),
  use_case text check (char_length(use_case) <= 280),
  created_at timestamptz not null default now()
);

alter table public.waitlist enable row level security;
-- No public policies: browser users cannot read or write the list.
revoke all on public.waitlist from public, anon, authenticated;
grant select, insert, delete on public.waitlist to service_role;

commit;
