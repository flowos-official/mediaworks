-- Per-session product / feedback rollup, computed by Postgres on demand.
-- Replaces the API's row-fetch-then-count approach so that response cost
-- does not grow with discovered_products volume.
--
-- security_invoker so RLS on underlying tables still applies when read
-- through anon/authenticated clients. (Service role bypasses RLS anyway.)

create or replace view public.discovery_run_feedback_stats
with (security_invoker = true) as
select
  r.id,
  r.run_at,
  r.completed_at,
  r.status,
  r.target_count,
  r.produced_count,
  r.iterations,
  r.context,
  coalesce(p.product_count, 0)::int as product_count,
  coalesce(p.feedback_count, 0)::int as feedback_count
from public.discovery_runs r
left join (
  select
    session_id,
    count(*)::int as product_count,
    count(*) filter (where user_action is not null)::int as feedback_count
  from public.discovered_products
  where session_id is not null
  group by session_id
) p on p.session_id = r.id;

comment on view public.discovery_run_feedback_stats is
  'discovery_runs rows augmented with product_count and feedback_count aggregated from discovered_products. Used by the discovery history calendar.';
