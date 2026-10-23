-- Checkpoint: saved Steam achievement totals
-- Run this AFTER 4-pictures.sql. Paste into Supabase → SQL Editor → New query → Run.
-- Safe to run more than once.
--
-- The Steam helper counts your achievements across all your games and saves
-- the totals here (at most once an hour), so profiles load fast.
-- Only the Steam helper can write these numbers, so they can't be faked.

alter table public.linked_accounts
  add column if not exists ach_unlocked integer,
  add column if not exists ach_total    integer,
  add column if not exists perfect      integer,
  add column if not exists stats_at     timestamptz;
