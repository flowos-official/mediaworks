-- 2026-05-18_profiles_company_must_change_password.sql
-- Extend profiles with company info + forced password change flag for
-- admin-created accounts.

alter table public.profiles
  add column if not exists company_name text,
  add column if not exists must_change_password boolean not null default false;

create index if not exists profiles_must_change_password_idx
  on public.profiles (must_change_password)
  where must_change_password = true;

-- Tighten the no-self-escalate trigger so it ALSO permits must_change_password
-- updates by the user themselves (so the user can clear their own flag after
-- changing password). Roles still require admin / service_role.
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
