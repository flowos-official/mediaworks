-- 2026-05-13_auth_rls_tight.sql
-- Drops loose policies from migration 02 and installs role-based ones.

-- 1) Drop loose policies first
do $$
declare t text;
begin
  foreach t in array array[
    'product_details','product_images','sales_weekly','sales_weekly_totals',
    'products','product_files','research_results',
    'discovered_products','discovery_runs','discovery_sessions','discovery_product_analyses',
    'learning_state','learning_insights','broadcasts','qvc_products',
    'md_strategies','live_commerce_strategies','product_feedback','profiles'
  ] loop
    execute format('drop policy if exists "loose_all" on public.%I', t);
  end loop;
end $$;

-- Drop any pre-existing tight policies (idempotent re-run support)
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname='public'
      and policyname in (
        'auth_read','member_write','member_update','admin_delete',
        'member_read','member_all',
        'feedback_read','feedback_insert_own','feedback_delete_own_or_admin',
        'profiles_self_read','profiles_self_update','profiles_admin_all'
      )
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- 2) Group A — TXD (viewer-readable)
do $$
declare t text;
begin
  foreach t in array array[
    'product_details','product_images','sales_weekly','sales_weekly_totals'
  ] loop
    execute format(
      'create policy "auth_read" on public.%I for select to authenticated using (true)', t);
    execute format(
      'create policy "member_write" on public.%I for insert to authenticated with check (public.current_user_role() in (''member'',''admin''))', t);
    execute format(
      'create policy "member_update" on public.%I for update to authenticated using (public.current_user_role() in (''member'',''admin'')) with check (public.current_user_role() in (''member'',''admin''))', t);
    execute format(
      'create policy "admin_delete" on public.%I for delete to authenticated using (public.current_user_role() = ''admin'')', t);
  end loop;
end $$;

-- 3) Group B — Internal
do $$
declare t text;
begin
  foreach t in array array[
    'products','product_files','research_results',
    'discovered_products','discovery_runs','discovery_sessions','discovery_product_analyses',
    'learning_state','learning_insights','broadcasts','qvc_products',
    'md_strategies','live_commerce_strategies'
  ] loop
    execute format(
      'create policy "member_read" on public.%I for select to authenticated using (public.current_user_role() in (''member'',''admin''))', t);
    execute format(
      'create policy "member_all" on public.%I for all to authenticated using (public.current_user_role() in (''member'',''admin'')) with check (public.current_user_role() in (''member'',''admin''))', t);
  end loop;
end $$;

-- 4) Group C — product_feedback
create policy "feedback_read" on public.product_feedback
  for select to authenticated
  using (public.current_user_role() in ('member','admin'));

create policy "feedback_insert_own" on public.product_feedback
  for insert to authenticated
  with check (
    public.current_user_role() in ('member','admin')
    and user_id = auth.uid()
  );

create policy "feedback_delete_own_or_admin" on public.product_feedback
  for delete to authenticated
  using (user_id = auth.uid() or public.current_user_role() = 'admin');

-- 5) Group D — profiles
create policy "profiles_self_read" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.current_user_role() = 'admin');

create policy "profiles_self_update" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "profiles_admin_all" on public.profiles
  for all to authenticated
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');
