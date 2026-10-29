-- Hafeez Helfer: cloud storage for signed-in users.
-- Run this once in your Supabase project: Dashboard → SQL Editor → New query → paste → Run.
-- Every row belongs to one user; Row Level Security makes it readable and writable only by that user.

create table if not exists public.user_records (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  tbl        text        not null check (tbl in ('mistakes', 'reviews', 'mistakeEvents', 'plans', 'sessions', 'settings')),
  id         text        not null check (char_length(id) between 1 and 200),
  data       jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  -- Server-assigned change counter: clients download rows with seq greater than their cursor.
  seq        bigint      not null default 0,
  primary key (user_id, tbl, id),
  -- Keep single records small (a mistake with a long note is well under this).
  constraint user_records_data_size check (data is null or pg_column_size(data) < 65536)
);

create sequence if not exists public.user_records_seq;

create index if not exists user_records_user_seq on public.user_records (user_id, seq);

-- Every insert or update gets a fresh sequence number and timestamp.
create or replace function public.user_records_touch() returns trigger
language plpgsql as $$
begin
  new.seq := nextval('public.user_records_seq');
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists user_records_touch on public.user_records;
create trigger user_records_touch before insert or update on public.user_records
  for each row execute function public.user_records_touch();

alter table public.user_records enable row level security;

drop policy if exists "own rows: select" on public.user_records;
drop policy if exists "own rows: insert" on public.user_records;
drop policy if exists "own rows: update" on public.user_records;
drop policy if exists "own rows: delete" on public.user_records;
create policy "own rows: select" on public.user_records for select to authenticated using (user_id = (select auth.uid()));
create policy "own rows: insert" on public.user_records for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own rows: update" on public.user_records for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows: delete" on public.user_records for delete to authenticated using (user_id = (select auth.uid()));

-- Anonymous visitors get nothing.
revoke all on public.user_records from anon;
grant select, insert, update, delete on public.user_records to authenticated;
grant usage on sequence public.user_records_seq to authenticated;

-- "Delete account" in Settings: removes the signed-in user and (by cascade) all of their rows.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  delete from auth.users where id = auth.uid();
end $$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
