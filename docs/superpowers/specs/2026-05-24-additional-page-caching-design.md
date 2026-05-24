# Additional Page Caching Design

**Date:** 2026-05-24
**Status:** Design
**Predecessor:** [`2026-05-24-broadcasts-page-caching-design.md`](./2026-05-24-broadcasts-page-caching-design.md) (PR #78)

## 1. Goal

Extend the Next.js 16 `'use cache'` pattern proven on `/broadcasts` to the remaining high-traffic, cron-driven pages:

- Discovery: `/analytics/discovery/home`, `/analytics/discovery/live`, `/analytics/discovery/insights`, `/analytics/discovery/history`
- Sales analytics (firm): `/analytics/overview` (uses 3 APIs: overview, trends, products)
- Selections list under `/analytics/discovery/insights` Selection tab

Outcome: cache hit on repeat page loads (DB reads = 0), explicit invalidation on cron completion and on user mutations.

## 2. Non-goals

- No Server-Component conversion of Client-rendered pages (UI code stays the same).
- No new test framework.
- No admin dashboards (`/admin/historical-crawl`, `/admin/archive-status`) — low traffic.
- No streaming endpoints (`/run/[runId]/stream`).
- No live-commerce / md-strategy session-detail endpoints — those are per-resource and largely user-mutated.

## 3. Approach

For each in-scope API route:
1. Extract the data-fetching logic into a helper in `lib/discovery/cached.ts` or `lib/analytics/cached.ts`.
2. Mark the helper with `'use cache'`, attach a `cacheTag` and `cacheLife({ revalidate: 6h, expire: 24h })`.
3. The route handler becomes: `requireUser` → call cached helper → apply per-request filters / role-mask → return.

This mirrors the broadcasts PoC. Page components and client-side fetch calls are unchanged.

## 4. Architecture

### 4.1 New helper files

```
lib/discovery/cached.ts
  ├ getCachedDiscoveryToday(context: 'home_shopping' | 'live_commerce')
  ├ getCachedDiscoveryInsights(context: 'home_shopping' | 'live_commerce' | null, weeks: number)
  ├ getCachedDiscoveryHistory(context: 'home_shopping' | 'live_commerce' | null, fromIso: string, toIso: string)
  ├ getCachedDiscoverySelections(context: 'home_shopping' | 'live_commerce' | null, status: string | null, days: number, page: number, limit: number)
  └ getCachedCategoryDistribution()

lib/analytics/cached.ts
  ├ getCachedSalesOverview(years: number[])
  ├ getCachedSalesTrends(years: number[], period: 'weekly' | 'monthly')
  └ getCachedSalesProducts(years: number[], sort: string, limit: number, category: string | null)
```

All helpers:
- Import `"server-only"`.
- Use `unstable_cacheLife as cacheLife` and `unstable_cacheTag as cacheTag` from `next/cache`.
- Use `getServiceClient()` (RLS bypass — safe because cache is shared across users; role-mask happens at route layer).
- Discovery helpers: `cacheLife({ revalidate: 60 * 60 * 6, expire: 60 * 60 * 24 })` (same as broadcasts PoC — cron-driven invalidation).
- Sales helpers: `cacheLife({ revalidate: 60 * 60 * 24, expire: 60 * 60 * 24 * 7 })` (24h/7d — no cron source, see §6.1).

### 4.2 Cache tag taxonomy

| Tag | Cached helpers under it | Invalidated by |
|---|---|---|
| `discovery:home_shopping` | `getCachedDiscoveryToday("home_shopping")` | `daily-discovery-home` cron + all mutations |
| `discovery:live_commerce` | `getCachedDiscoveryToday("live_commerce")` | `daily-discovery-live` cron + all mutations |
| `discovery:insights` | `getCachedDiscoveryInsights(*)` | `daily-learning`, `weekly-insights` cron + mutations |
| `discovery:history` | `getCachedDiscoveryHistory(*)` | `daily-discovery-home`, `daily-discovery-live` cron + mutations |
| `discovery:selections` | `getCachedDiscoverySelections(*)` | mutations only (no cron — fed by user actions) |
| `discovery:category-distribution` | `getCachedCategoryDistribution()` | `daily-broadcasts`, `daily-historical-broadcasts` cron |
| `analytics:sales` | `getCachedSalesOverview`, `getCachedSalesTrends`, `getCachedSalesProducts` | (none — see §6.1; relies on cacheLife) |

The broadcasts PoC tags (`broadcasts:calendar:YYYY-MM`, `broadcasts:totals`) are unchanged.

### 4.3 Cache lifetime

- Discovery helpers: `cacheLife({ revalidate: 60 * 60 * 6, expire: 60 * 60 * 24 })`. Explicit `revalidateTag` from crons/mutations is the primary freshness mechanism; lifetime is the safety net.
- Sales helpers: `cacheLife({ revalidate: 60 * 60 * 24, expire: 60 * 60 * 24 * 7 })`. No cron source; lifetime IS the primary mechanism (see §6.1).

## 5. Route handler changes

| Route | Caching behavior |
|---|---|
| `app/api/discovery/today/route.ts` | `requireUser` → if `context` ∈ {`home_shopping`,`live_commerce`} call `getCachedDiscoveryToday(context)`, else fall back to uncached service-client path (existing behavior). Apply `status` / `track` filter in-memory on the returned `products` array. |
| `app/api/discovery/insights/route.ts` | `requireUser` → `getCachedDiscoveryInsights(context, weeks)` → return as-is. |
| `app/api/discovery/history/route.ts` | `requireUser` → `getCachedDiscoveryHistory(context, fromIso, toIso)` → return as-is. |
| `app/api/discovery/selections/route.ts` | `requireUser` → `getCachedDiscoverySelections(context, status, days, page, limit)` → return as-is. |
| `app/api/analytics/overview/route.ts` | `requireUser` → `getCachedSalesOverview(years)` → return as-is. **Drops `auth.sb`** in favor of service client inside helper. |
| `app/api/analytics/trends/route.ts` | `requireUser` → `getCachedSalesTrends(years, period)` → return as-is. **Drops `auth.sb`**. |
| `app/api/analytics/products/route.ts` | `requireUser` → `getCachedSalesProducts(years, sort, limit, category)` → **mask `totalCost`/`totalProfit`/`marginRate` to `null` when `auth.role === "viewer"`** → return. **Drops `auth.sb`**. |

The route handler is responsible for:
1. Auth (`requireUser` — never cached).
2. Calling the cached helper.
3. Per-request filtering (in-memory) of user query params that don't affect the cache key.
4. Role-mask for viewer-restricted fields.

## 6. Cron invalidation

Each cron route adds, after its main work completes (best-effort, wrapped in try/catch so cron success is not gated on revalidation success):

| Cron | Tags to revalidate |
|---|---|
| `daily-discovery-home` (23:00 UTC) | `discovery:home_shopping`, `discovery:history` |
| `daily-discovery-live` (23:30 UTC) | `discovery:live_commerce`, `discovery:history` |
| `daily-learning` (22:45 UTC) | `discovery:insights` |
| `weekly-insights` (Mon 01:00 UTC) | `discovery:insights` |
| `daily-broadcasts` (16:00 UTC) | (already invalidates calendar tags) + `discovery:category-distribution` |
| `daily-historical-broadcasts` (16:30 UTC) | (already invalidates calendar tags) + `discovery:category-distribution` |
| `qvc-monthly-refresh` (17:00 UTC) | (already invalidates calendar tags) — no new addition |

All calls use `revalidateTag(tag, "max")` — the two-arg form required by Next.js 16.1.6.

### 6.1 Sales analytics: no source cron

The sales summary tables (`annual_summaries`, `category_summaries`, `sales_weekly_totals`, `product_summaries`) are populated by the manual `scripts/compute-summaries.ts` script after an `scripts/import-sales.ts` upload. The existing `daily-refresh` cron operates on `products`/`research_results` only — it is NOT a source of truth for sales analytics. There is no cron to hook into.

Decision: rely on `cacheLife` alone for sales freshness. Use a longer lifetime: `cacheLife({ revalidate: 60 * 60 * 24, expire: 60 * 60 * 24 * 7 })` (24h revalidate, 7d expire). Updates from `compute-summaries.ts` appear at the next 24h boundary. Explicit invalidation (e.g., a `POST /api/admin/cache/invalidate-sales` endpoint that the script could call) is left as a follow-up — out of scope for this PoC.

## 7. Mutation invalidation

Mutations that change `discovered_products` or `product_feedback` invalidate the user-facing discovery tags. The invalidation is **coarse** (no per-context targeting) because the mutation endpoints don't carry the `context` of the affected product cheaply.

| Endpoint | Tags to revalidate on success |
|---|---|
| `POST /api/discovery/feedback` | `discovery:home_shopping`, `discovery:live_commerce`, `discovery:insights`, `discovery:history`, `discovery:selections` |
| `POST /api/discovery/[productId]/promote-to-research` | same 5 tags |
| `POST /api/discovery/enrich/[productId]/worker` | same 5 tags (the dispatch route only queues; the worker writes c_package) |

Invalidation is best-effort: wrapped in try/catch, failure is logged but does not turn a successful mutation into an error response. The 24h `expire` is the safety net.

## 8. Data flow

### 8.1 Cache hit (steady state)

```
GET /api/discovery/today?context=home_shopping
  → requireUser (always runs, never cached)
  → getCachedDiscoveryToday("home_shopping")    [cache hit, 0 DB reads]
  → apply in-memory filters (status, track)
  → NextResponse.json(...)
```

### 8.2 Cron-driven invalidation

```
23:00 UTC  daily-discovery-home cron triggered
~23:08     cron finishes successfully
~23:08     try { revalidateTag("discovery:home_shopping","max"); revalidateTag("discovery:history","max") } catch { /* logged, not fatal */ }
~23:08+    next GET → cache miss → fresh DB read → re-cached
```

### 8.3 Mutation-driven invalidation

```
User clicks "sourced"
  → POST /api/discovery/feedback
  → DB write succeeds
  → try { revalidateTag x 5 } catch { /* logged */ }
  → 200 response
  → client re-fetches GET /api/discovery/today
  → cache miss → fresh DB read (includes the just-written value)
```

## 9. Edge cases & decisions

**E1. `context` parameter missing on `/api/discovery/today`.** Existing API accepts requests without `context`. Decision: cached helper requires `context`; route handler falls back to the uncached service-client path when `context` is missing or invalid. Preserves existing behavior, no key explosion.

**E2. `discovery:insights` and `discovery:history` accept `null` context.** Function arg `(null, weeks)` hashes to a distinct cache key from `("home_shopping", weeks)`. They share the same tag — cron invalidation flushes all variants in one call.

**E3. Viewer role on sales analytics.** The cache is shared across roles. Cached helpers always return the unmasked rows (including cost, profit, margin). The route handler masks viewer-restricted fields to `null` before responding. This means **no viewer-restricted field may be derived from cached data alone** — must always be re-computed in the route handler if needed. Currently only `/api/analytics/products` has viewer-masked fields; they are top-level row fields, not derived elsewhere.

**E4. Sales summary updates.** `scripts/compute-summaries.ts` writes the summary tables but does not invalidate the cache. New data appears at the next 24h `revalidate` boundary (or 7d `expire` worst case). See §6.1. Explicit manual recovery endpoint (admin POST that calls `revalidateTag("analytics:sales", "max")`) is a follow-up.

**E5. Single coarse `analytics:sales` tag.** Each `(years, period, sort, limit, category)` combination produces a separate cache entry (hashed from helper args), but all share the `analytics:sales` tag. One `revalidateTag` call from `daily-refresh` flushes them all.

**E6. `revalidateTag` two-arg signature.** Next.js 16.1.6 requires `revalidateTag(tag, profile)`. We pass `"max"`, matching the broadcasts PoC.

**E7. Cached helper throws.** Next.js 16 does not cache thrown errors — the next request retries. Route handler wraps the call in `try/catch` and returns `{ error: ... }` 500.

**E8. `'use cache'` build prerequisite.** `experimental.useCache: true` is already set in `next.config.ts` (from broadcasts PoC). No new build config needed.

**E9. `getServiceClient()` inside cached helpers.** Service client is constructed from env vars and has no per-request state — safe to invoke inside a cached function.

**E10. (Removed — `daily-refresh` does not feed sales analytics tables; see §6.1.)**

**E11. `auth.sb` removal from sales routes.** Currently `/api/analytics/overview`, `/api/analytics/trends`, `/api/analytics/products` use `auth.sb` (cookie-RLS client). Since the cached helpers use `getServiceClient()`, the route handlers no longer need `auth.sb`. Auth still happens via `requireUser` — only the SQL client changes.

**E12. Mutation invalidation that fires across both contexts.** The mutation endpoints don't know the product's `context` cheaply. We invalidate both `discovery:home_shopping` and `discovery:live_commerce` as a coarse but safe default.

## 10. Files affected

### New
- `lib/discovery/cached.ts`
- `lib/analytics/cached.ts`

### Modified — route handlers
- `app/api/discovery/today/route.ts`
- `app/api/discovery/insights/route.ts`
- `app/api/discovery/history/route.ts`
- `app/api/discovery/selections/route.ts`
- `app/api/analytics/overview/route.ts`
- `app/api/analytics/trends/route.ts`
- `app/api/analytics/products/route.ts`

### Modified — cron routes (revalidateTag additions)
- `app/api/cron/daily-discovery-home/route.ts`
- `app/api/cron/daily-discovery-live/route.ts`
- `app/api/cron/daily-learning/route.ts`
- `app/api/cron/weekly-insights/route.ts`
- `app/api/cron/daily-broadcasts/route.ts` (extend existing call)
- `app/api/cron/daily-historical-broadcasts/route.ts` (extend existing call)

### Modified — mutation routes (revalidateTag additions)
- `app/api/discovery/feedback/route.ts`
- `app/api/discovery/[productId]/promote-to-research/route.ts`
- `app/api/discovery/enrich/[productId]/worker/route.ts`

### Unchanged
- All page components, all client-side components, all i18n files, `next.config.ts`.

## 11. Testing & verification

No automated tests (project has no test framework).

### Build verification (must pass before commit)
```
npx tsc --noEmit
npm run lint
npm run build
```

### Manual verification (post-deploy checklist for PR body)

**A. Discovery home**
1. Logged in (member or admin), visit `/ja/analytics/discovery/home`.
2. Note `discovered_products` SELECT count in Supabase logs.
3. Refresh → DB reads = 0 (cache hit).
4. Click "sourced" on one card → refresh → DB read occurs, change reflected.
5. Refresh again → DB reads = 0.

**B. Discovery insights**
1. `/ja/analytics/discovery/insights` → Stats tab → note DB reads.
2. Refresh → 0.
3. Trigger feedback elsewhere → return and refresh insights → DB read occurs.

**C. Discovery history**
1. `/ja/analytics/discovery/history` → note DB reads.
2. Refresh → 0.
3. After feedback elsewhere → refresh → DB read occurs.

**D. Sales overview**
1. `/ja/analytics/overview` → 3 APIs each hit DB.
2. Refresh → all 3 → 0 DB reads.
3. With viewer account → call `/api/analytics/products?year=2026&limit=5` → confirm `totalCost`, `totalProfit`, `marginRate` are `null`.
4. (No cron-based invalidation to verify — see §6.1.)

**E. Cron invalidation**
- Inspect Vercel cron logs for each modified cron — confirm no errors from the `revalidateTag` additions.

## 12. Risk register

| Risk | Mitigation |
|---|---|
| Viewer sees cost/profit due to forgotten mask | E3 + manual check D-4 |
| Mutation invalidation silently fails → stale UI | best-effort try/catch + 24h `expire` safety net + next cron |
| Helper throws and 500s cascade | Next.js 16 does not cache throws; route handler returns 500 with body |
| `'use cache'` build regression | already validated by broadcasts PoC build |
| Coarse mutation invalidation flushes more than necessary | acceptable — each cache key re-fills cheaply (one Supabase round-trip) |

## 13. Out of scope (follow-ups)

- Admin POST endpoint to invalidate `analytics:sales` (so `compute-summaries.ts` can call it after writing).
- Server-Component conversion of Discovery pages (would eliminate the extra fetch round-trip).
- Per-context mutation invalidation (requires resolving product → context cheaply).
- Cache for `/api/analytics/products/[code]` detail endpoint (per-product key — explosion risk).
- Cache for live-commerce / md-strategy session endpoints.
- Cache for admin dashboards.
