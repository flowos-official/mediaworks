-- 2026-05-13_auth_rls_summary_tables.sql
-- Follow-up: the spec assumed product_summaries / monthly_summaries / category_summaries
-- / annual_summaries were views (inheriting RLS from underlying tables). They are
-- actually tables, so we must enable RLS and attach policies directly.
--
-- product_summaries, monthly_summaries  -> Group A (viewer-readable)
-- category_summaries, annual_summaries  -> Group B (internal)

-- Enable RLS
alter table public.product_summaries  enable row level security;
alter table public.monthly_summaries  enable row level security;
alter table public.category_summaries enable row level security;
alter table public.annual_summaries   enable row level security;

-- Group A — viewer-readable: product_summaries, monthly_summaries
do $$
declare t text;
begin
  foreach t in array array['product_summaries','monthly_summaries']
  loop
    execute format('drop policy if exists "auth_read"      on public.%I', t);
    execute format('drop policy if exists "member_write"   on public.%I', t);
    execute format('drop policy if exists "member_update"  on public.%I', t);
    execute format('drop policy if exists "admin_delete"   on public.%I', t);

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

-- Group B — internal: category_summaries, annual_summaries
do $$
declare t text;
begin
  foreach t in array array['category_summaries','annual_summaries']
  loop
    execute format('drop policy if exists "member_read" on public.%I', t);
    execute format('drop policy if exists "member_all"  on public.%I', t);

    execute format(
      'create policy "member_read" on public.%I for select to authenticated using (public.current_user_role() in (''member'',''admin''))', t);
    execute format(
      'create policy "member_all" on public.%I for all to authenticated using (public.current_user_role() in (''member'',''admin'')) with check (public.current_user_role() in (''member'',''admin''))', t);
  end loop;
end $$;
