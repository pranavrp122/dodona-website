-- Run once in the Supabase SQL editor, signed in as the project owner.
begin;

create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  email text not null check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
  company text check (char_length(company) <= 120),
  message text not null check (char_length(message) between 1 and 2000),
  created_at timestamptz not null default now()
);

alter table public.contact_messages enable row level security;
-- No public policies: browser users cannot read or write messages.
revoke all on public.contact_messages from public, anon, authenticated;
grant select, insert, delete on public.contact_messages to service_role;

commit;
