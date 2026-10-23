-- Checkpoint account storage
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.
-- It creates one table where each person's library is saved as a single record,
-- and locks it so people can only ever see and change their own data.

create table if not exists public.checkpoint_data (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint data_not_too_big check (pg_column_size(data) < 3000000)
);

alter table public.checkpoint_data enable row level security;

drop policy if exists "Read own data"   on public.checkpoint_data;
drop policy if exists "Add own data"    on public.checkpoint_data;
drop policy if exists "Change own data" on public.checkpoint_data;
drop policy if exists "Delete own data" on public.checkpoint_data;

create policy "Read own data" on public.checkpoint_data
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "Add own data" on public.checkpoint_data
  for insert to authenticated with check ((select auth.uid()) = user_id);

create policy "Change own data" on public.checkpoint_data
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Delete own data" on public.checkpoint_data
  for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.checkpoint_data to authenticated;
