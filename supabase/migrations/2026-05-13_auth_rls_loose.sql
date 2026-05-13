-- 2026-05-13_auth_rls_loose.sql
-- Enables RLS on every public table touched by the app, with permissive
-- "using (true)" policies so existing anon/service-role behavior is preserved.
-- Phase 5 will tighten these to role-based policies.

-- Group A (TXD)
alter table public.product_details      enable row level security;
alter table public.product_images       enable row level security;
alter table public.sales_weekly         enable row level security;
alter table public.sales_weekly_totals  enable row level security;

-- Group B (internal)
alter table public.products                     enable row level security;
alter table public.product_files                enable row level security;
alter table public.research_results             enable row level security;
alter table public.discovered_products          enable row level security;
alter table public.discovery_runs               enable row level security;
alter table public.discovery_sessions           enable row level security;
alter table public.discovery_product_analyses   enable row level security;
alter table public.learning_state               enable row level security;
alter table public.learning_insights            enable row level security;
alter table public.broadcasts                   enable row level security;
alter table public.qvc_products                 enable row level security;
alter table public.md_strategies                enable row level security;
alter table public.live_commerce_strategies     enable row level security;

-- Group C
alter table public.product_feedback enable row level security;

-- Group D
alter table public.profiles enable row level security;

-- Loose policies — every authenticated user can do everything for now.
-- These are temporary; Phase 5 (Task 22) will drop them and add role-based ones.
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
    execute format(
      'create policy "loose_all" on public.%I for all to authenticated, anon using (true) with check (true)', t
    );
  end loop;
end $$;
