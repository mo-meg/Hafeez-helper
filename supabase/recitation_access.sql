-- Recitation tracker access control: users ask for access, the admin approves.
-- Run once in the Supabase SQL editor (safe to re-run). The admin is identified by a CONFIRMED
-- account email; change it here and in src/core/recitation/access.ts / scripts/asr_server.py.

create table if not exists public.recitation_access (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  email        text not null default '',
  status       text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  requested_at timestamptz not null default now(),
  decided_at   timestamptz
);

create or replace function public.is_recitation_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    where u.id = auth.uid() and lower(u.email) = 'mmm_megahed@hotmail.com' and u.email_confirmed_at is not null
  );
$$;

-- The stored email always comes from the account, never from the client.
create or replace function public.recitation_access_fill() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.email := coalesce((select email from auth.users where id = new.user_id), '');
  return new;
end $$;

drop trigger if exists recitation_access_fill on public.recitation_access;
create trigger recitation_access_fill before insert on public.recitation_access
  for each row execute function public.recitation_access_fill();

alter table public.recitation_access enable row level security;

drop policy if exists "access: read own or admin" on public.recitation_access;
drop policy if exists "access: request" on public.recitation_access;
drop policy if exists "access: admin decides" on public.recitation_access;
create policy "access: read own or admin" on public.recitation_access for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_recitation_admin()));
-- Users can only create their own request, and only as "pending".
create policy "access: request" on public.recitation_access for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'pending');
create policy "access: admin decides" on public.recitation_access for update to authenticated
  using ((select public.is_recitation_admin())) with check ((select public.is_recitation_admin()));

revoke all on public.recitation_access from anon;
revoke all on public.recitation_access from authenticated;
grant select, insert on public.recitation_access to authenticated;
grant update (status, decided_at) on public.recitation_access to authenticated;
