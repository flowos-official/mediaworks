-- 2026-05-13_auth_schema.sql

-- profiles: 1:1 with auth.users, app-owned role
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'viewer'
    check (role in ('admin','member','viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles (role);

-- Auto-create profile row whenever an auth.users row appears
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'viewer')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Track who submitted each feedback row (nullable for pre-auth rows)
alter table public.product_feedback
  add column if not exists user_id uuid references public.profiles(id)
  on delete set null;

create index if not exists product_feedback_user_id_created_idx
  on public.product_feedback (user_id, created_at desc);

-- Helper function reused by every RLS policy
create or replace function public.current_user_role() returns text
  language sql security definer stable set search_path = public as $$
    select role from public.profiles where id = auth.uid()
$$;

-- Trigger to forbid non-admin role changes. Direct Postgres connections
-- (current_user = 'postgres' or 'supabase_admin') and PostgREST-via-service-role
-- (current_user = 'service_role') bypass the check so admin bootstrap and
-- Admin SDK calls can still mutate roles.
create or replace function public.prevent_role_self_escalation() returns trigger
  language plpgsql as $$
begin
  if new.role is distinct from old.role
     and current_user not in ('service_role', 'postgres', 'supabase_admin')
     and (public.current_user_role() is null or public.current_user_role() <> 'admin') then
    raise exception 'role can only be changed by admin';
  end if;
  return new;
end $$;

drop trigger if exists profiles_no_self_escalate on public.profiles;
create trigger profiles_no_self_escalate
  before update on public.profiles
  for each row execute function public.prevent_role_self_escalation();
