-- Checkpoint: verified Steam accounts
-- Run this AFTER 2-profiles-and-friends.sql. Paste into Supabase → SQL Editor → New query → Run.
-- Safe to run more than once.
--
-- Only the Steam helper (which checks Steam's real sign-in) can add rows here,
-- so nobody can pretend to own someone else's Steam account.

create table if not exists public.linked_accounts (
  user_id      uuid not null references auth.users (id) on delete cascade,
  provider     text not null check (provider in ('steam')),
  account_id   text not null,
  display_name text,
  avatar       text,
  linked_at    timestamptz not null default now(),
  primary key (user_id, provider),
  unique (provider, account_id)        -- one Steam account can only be linked once
);

alter table public.linked_accounts enable row level security;

drop policy if exists "Anyone can view linked accounts" on public.linked_accounts;
drop policy if exists "Unlink your own account"         on public.linked_accounts;

create policy "Anyone can view linked accounts" on public.linked_accounts
  for select to anon, authenticated using (true);
create policy "Unlink your own account" on public.linked_accounts
  for delete to authenticated using ((select auth.uid()) = user_id);

-- People can look and unlink, but never add or edit rows themselves
revoke all on public.linked_accounts from anon, authenticated;
grant select on public.linked_accounts to anon, authenticated;
grant delete on public.linked_accounts to authenticated;
