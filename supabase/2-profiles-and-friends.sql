-- Checkpoint: public profiles, unique usernames and follows
-- Run this AFTER 1-accounts.sql. Paste it into Supabase → SQL Editor → New query → Run.
-- Safe to run more than once.

-- ---------- Public profiles ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text not null unique,
  data       jsonb not null default '{}'::jsonb,
  joined_at  timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[a-z0-9_]{3,20}$'),
  constraint profile_not_too_big check (pg_column_size(data) < 1500000)
);

alter table public.profiles enable row level security;

drop policy if exists "Anyone can view profiles"  on public.profiles;
drop policy if exists "Create own profile"        on public.profiles;
drop policy if exists "Change own profile"        on public.profiles;
drop policy if exists "Delete own profile"        on public.profiles;

create policy "Anyone can view profiles" on public.profiles
  for select to anon, authenticated using (true);
create policy "Create own profile" on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);
create policy "Change own profile" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy "Delete own profile" on public.profiles
  for delete to authenticated using ((select auth.uid()) = id);

-- Only these columns can be written (so nobody can fake their join date)
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to anon, authenticated;
grant insert (id, username, data, updated_at) on public.profiles to authenticated;
grant update (username, data, updated_at) on public.profiles to authenticated;
grant delete on public.profiles to authenticated;

-- ---------- Follows (two people following each other = friends) ----------
create table if not exists public.follows (
  follower   uuid not null references auth.users (id) on delete cascade,
  following  uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower, following),
  constraint no_self_follow check (follower <> following)
);
create index if not exists follows_following_idx on public.follows (following);

alter table public.follows enable row level security;

drop policy if exists "Anyone can view follows" on public.follows;
drop policy if exists "Follow as yourself"      on public.follows;
drop policy if exists "Unfollow as yourself"    on public.follows;

create policy "Anyone can view follows" on public.follows
  for select to anon, authenticated using (true);
create policy "Follow as yourself" on public.follows
  for insert to authenticated with check ((select auth.uid()) = follower);
create policy "Unfollow as yourself" on public.follows
  for delete to authenticated using ((select auth.uid()) = follower);

revoke all on public.follows from anon, authenticated;
grant select on public.follows to anon, authenticated;
grant insert (follower, following) on public.follows to authenticated;
grant delete on public.follows to authenticated;
