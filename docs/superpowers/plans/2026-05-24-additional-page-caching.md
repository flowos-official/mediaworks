# Additional Page Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `/broadcasts` `'use cache'` pattern (PR #78) to Discovery (`/today`, `/insights`, `/history`, `/selections`) and Sales analytics (`/overview`, `/trends`, `/products`) API routes. Reduce Supabase reads on repeat page loads to zero, invalidate explicitly from crons and user mutations.

**Architecture:** Extract data fetches from 7 API routes into `'use cache'` helpers in `lib/discovery/cached.ts` and `lib/analytics/cached.ts`. Route handlers do `requireUser` → call cached helper → apply in-memory filters + role-mask → respond. Discovery: 4 cron + 3 mutation routes call `revalidateTag(tag, "max")`. Sales: no cron source — `cacheLife({ 24h, 7d })` is the only freshness mechanism.

**Tech Stack:** Next.js 16.1.6 Cache Components (`'use cache'`, `unstable_cacheLife`, `unstable_cacheTag`, `revalidateTag`), Supabase service-role client (`getServiceClient`).

**Spec:** `docs/superpowers/specs/2026-05-24-additional-page-caching-design.md`

**Note on tests:** Per spec, **no automated tests added** (project has no test framework). `'use cache'` correctness verified via `npx tsc --noEmit` + `npm run build` (static analysis) + post-deploy manual verification listed in the spec §11.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `lib/discovery/cached.ts` | Create | 5 `'use cache'` helpers (today, insights, history, selections, category-distribution) |
| `lib/analytics/cached.ts` | Create | 3 `'use cache'` helpers (sales overview, trends, products) — unmasked |
| `app/api/discovery/today/route.ts` | Modify | Call `getCachedDiscoveryToday`; apply status/track filter in memory |
| `app/api/discovery/insights/route.ts` | Modify | Call `getCachedDiscoveryInsights`; return as-is |
| `app/api/discovery/history/route.ts` | Modify | Call `getCachedDiscoveryHistory`; return as-is |
| `app/api/discovery/selections/route.ts` | Modify | Call `getCachedDiscoverySelections`; return as-is |
| `app/api/analytics/overview/route.ts` | Modify | Call `getCachedSalesOverview`; drop `auth.sb` |
| `app/api/analytics/trends/route.ts` | Modify | Call `getCachedSalesTrends`; drop `auth.sb` |
| `app/api/analytics/products/route.ts` | Modify | Call `getCachedSalesProducts`; role-mask viewer; drop `auth.sb` |
| `app/api/cron/daily-discovery-home/route.ts` | Modify | Add `revalidateTag` for `discovery:home_shopping`, `discovery:history` |
| `app/api/cron/daily-discovery-live/route.ts` | Modify | Add `revalidateTag` for `discovery:live_commerce`, `discovery:history` |
| `app/api/cron/daily-learning/route.ts` | Modify | Add `revalidateTag` for `discovery:insights` |
| `app/api/cron/weekly-insights/route.ts` | Modify | Add `revalidateTag` for `discovery:insights` |
| `app/api/cron/daily-broadcasts/route.ts` | Modify | Extend existing block: add `discovery:category-distribution` |
| `app/api/cron/daily-historical-broadcasts/route.ts` | Modify | Extend existing block: add `discovery:category-distribution` |
| `app/api/discovery/feedback/route.ts` | Modify | Add `revalidateTag` × 5 after successful mutation |
| `app/api/discovery/[productId]/promote-to-research/route.ts` | Modify | Same 5 tags after successful promotion |
| `app/api/discovery/enrich/[productId]/worker/route.ts` | Modify | Same 5 tags after successful c_package write (worker, not dispatch) |

---

## Task 1: Discovery cached helpers

**Files:**
- Create: `lib/discovery/cached.ts`

- [ ] **Step 1: Create the helper module**

Path: `lib/discovery/cached.ts`

```ts
import "server-only";
import {
	unstable_cacheLife as cacheLife,
	unstable_cacheTag as cacheTag,
} from "next/cache";
import { getServiceClient } from "@/lib/supabase";
import {
	loadCategoryDistribution,
	type CategoryDistribution,
} from "@/lib/discovery/category-distribution";

type Context = "home_shopping" | "live_commerce";

const SIX_HOURS = 60 * 60 * 6;
const ONE_DAY = 60 * 60 * 24;

const DISCOVERY_LIFE = { revalidate: SIX_HOURS, expire: ONE_DAY };

export interface CachedDiscoveryToday {
	session: Record<string, unknown> | null;
	products: Array<Record<string, unknown>>;
	categoryStats: CategoryDistribution | null;
}

/**
 * Latest completed or partial session for the given context, plus all of its
 * products and the category-distribution stats. Mirrors what
 * /api/discovery/today returns before per-request filters (status, track) are
 * applied — those happen at the route handler.
 */
export async function getCachedDiscoveryToday(
	context: Context,
): Promise<CachedDiscoveryToday> {
	"use cache";
	cacheTag(`discovery:${context}`);
	cacheLife(DISCOVERY_LIFE);

	const sb = getServiceClient();
	const { data: session } = await sb
		.from("discovery_runs")
		.select("*")
		.in("status", ["completed", "partial"])
		.eq("context", context)
		.order("run_at", { ascending: false })
		.limit(1)
		.maybeSingle();

	if (!session) return { session: null, products: [], categoryStats: null };

	const [productsResult, categoryStats] = await Promise.all([
		sb
			.from("discovered_products")
			.select("*")
			.eq("session_id", session.id)
			.order("tv_tier", { ascending: true })
			.order("tv_fit_score", { ascending: false }),
		getCachedCategoryDistribution(),
	]);

	return {
		session,
		products: productsResult.data ?? [],
		categoryStats,
	};
}

/** Wraps loadCategoryDistribution() in its own cache layer so other helpers can share it. */
export async function getCachedCategoryDistribution(): Promise<CategoryDistribution> {
	"use cache";
	cacheTag("discovery:category-distribution");
	cacheLife(DISCOVERY_LIFE);
	return loadCategoryDistribution();
}

export interface CachedDiscoveryInsights {
	kpi: {
		thisWeekSourced: number;
		thisWeekRejected: number;
		explorationRatio: number;
		totalSamples: number;
	};
	weeklyInsights: Array<Record<string, unknown>>;
	categoryWeights: Record<string, number>;
	explorationTrend: Array<{ week: string; home: number; live: number }>;
	rejectionReasons: Array<{ reason: string; count: number }>;
	dailyFeedback: Array<{
		date: string;
		sourced: number;
		interested: number;
		rejected: number;
		duplicate: number;
	}>;
}

/**
 * Aggregated insights for the given context (or all contexts if null), looking
 * back `weeks` weeks. Mirrors /api/discovery/insights exactly.
 */
export async function getCachedDiscoveryInsights(
	context: Context | null,
	weeks: number,
	mondayIso: string,
): Promise<CachedDiscoveryInsights> {
	"use cache";
	cacheTag("discovery:insights");
	cacheLife(DISCOVERY_LIFE);

	const sb = getServiceClient();

	const weeksAgo = new Date();
	weeksAgo.setUTCDate(weeksAgo.getUTCDate() - weeks * 7);

	let kpiQuery = sb
		.from("discovered_products")
		.select("user_action")
		.gte("created_at", mondayIso);
	if (context) kpiQuery = kpiQuery.eq("context", context);
	const { data: thisWeek } = await kpiQuery;
	const thisWeekRows = (thisWeek ?? []) as Array<{ user_action: string | null }>;
	const thisWeekSourced = thisWeekRows.filter((r) => r.user_action === "sourced").length;
	const thisWeekRejected = thisWeekRows.filter((r) => r.user_action === "rejected").length;

	let stateQuery = sb.from("learning_state").select("*");
	if (context) stateQuery = stateQuery.eq("context", context);
	const { data: states } = await stateQuery;
	const stateRows = (states ?? []) as Array<{
		exploration_ratio: number;
		feedback_sample_size: number;
		category_weights: Record<string, number> | null;
	}>;
	const explorationRatio =
		stateRows.reduce((sum, s) => sum + Number(s.exploration_ratio ?? 0), 0) /
		(stateRows.length || 1);
	const totalSamples = stateRows.reduce(
		(sum, s) => sum + Number(s.feedback_sample_size ?? 0),
		0,
	);

	let insightsQuery = sb
		.from("learning_insights")
		.select("*")
		.gte("week_start", weeksAgo.toISOString().slice(0, 10))
		.order("week_start", { ascending: false });
	if (context) insightsQuery = insightsQuery.eq("context", context);
	const { data: weeklyInsights } = await insightsQuery;

	const thirtyDaysAgo = new Date();
	thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
	let dailyQuery = sb
		.from("discovered_products")
		.select("action_at, user_action, action_reason, context")
		.not("user_action", "is", null)
		.gte("action_at", thirtyDaysAgo.toISOString());
	if (context) dailyQuery = dailyQuery.eq("context", context);
	const { data: dailyRows } = await dailyQuery;
	const dailyItems = (dailyRows ?? []) as Array<{
		action_at: string;
		user_action: string | null;
		action_reason: string | null;
	}>;

	const dailyMap = new Map<
		string,
		{ sourced: number; interested: number; rejected: number; duplicate: number }
	>();
	for (const r of dailyItems) {
		if (!r.action_at) continue;
		const date = r.action_at.slice(0, 10);
		const entry =
			dailyMap.get(date) ?? { sourced: 0, interested: 0, rejected: 0, duplicate: 0 };
		if (r.user_action === "sourced") entry.sourced += 1;
		else if (r.user_action === "interested") entry.interested += 1;
		else if (r.user_action === "rejected") entry.rejected += 1;
		else if (r.user_action === "duplicate") entry.duplicate += 1;
		dailyMap.set(date, entry);
	}
	const dailyFeedback = [...dailyMap.entries()]
		.map(([date, counts]) => ({ date, ...counts }))
		.sort((a, b) => a.date.localeCompare(b.date));

	const reasonMap = new Map<string, number>();
	for (const r of dailyItems) {
		if (r.user_action === "rejected") {
			const reason = r.action_reason ?? "不明";
			reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
		}
	}

	const categoryWeights: Record<string, number> = {};
	for (const s of stateRows) {
		const weights = s.category_weights ?? null;
		if (weights) {
			for (const [cat, weight] of Object.entries(weights)) {
				categoryWeights[cat] = Math.max(categoryWeights[cat] ?? 0, weight);
			}
		}
	}

	let trendRunsQuery = sb
		.from("discovery_runs")
		.select("run_at, context, exploration_ratio")
		.gte("run_at", weeksAgo.toISOString())
		.not("exploration_ratio", "is", null);
	if (context) trendRunsQuery = trendRunsQuery.eq("context", context);
	const { data: trendRuns } = await trendRunsQuery;
	const trendRunRows = (trendRuns ?? []) as Array<{
		run_at: string;
		context: "home_shopping" | "live_commerce";
		exploration_ratio: number | string | null;
	}>;
	const trendAggMap = new Map<
		string,
		{ homeSum: number; homeN: number; liveSum: number; liveN: number }
	>();
	for (const r of trendRunRows) {
		if (r.exploration_ratio == null) continue;
		const ratio = Number(r.exploration_ratio);
		if (!Number.isFinite(ratio)) continue;
		const d = new Date(r.run_at);
		const dow = d.getUTCDay();
		const daysFromMondayLocal = dow === 0 ? 6 : dow - 1;
		const weekDate = new Date(d);
		weekDate.setUTCDate(d.getUTCDate() - daysFromMondayLocal);
		weekDate.setUTCHours(0, 0, 0, 0);
		const weekKey = weekDate.toISOString().slice(0, 10);
		const entry =
			trendAggMap.get(weekKey) ?? { homeSum: 0, homeN: 0, liveSum: 0, liveN: 0 };
		if (r.context === "home_shopping") {
			entry.homeSum += ratio;
			entry.homeN += 1;
		} else if (r.context === "live_commerce") {
			entry.liveSum += ratio;
			entry.liveN += 1;
		}
		trendAggMap.set(weekKey, entry);
	}
	const explorationTrend = [...trendAggMap.entries()]
		.map(([week, v]) => ({
			week,
			home: v.homeN > 0 ? v.homeSum / v.homeN : 0,
			live: v.liveN > 0 ? v.liveSum / v.liveN : 0,
		}))
		.sort((a, b) => a.week.localeCompare(b.week));

	return {
		kpi: {
			thisWeekSourced,
			thisWeekRejected,
			explorationRatio,
			totalSamples,
		},
		weeklyInsights: (weeklyInsights ?? []) as Array<Record<string, unknown>>,
		categoryWeights,
		explorationTrend,
		rejectionReasons: [...reasonMap.entries()].map(([reason, count]) => ({ reason, count })),
		dailyFeedback,
	};
}

export interface CachedDiscoveryHistory {
	sessions: Array<{
		id: string;
		run_at: string;
		completed_at: string | null;
		status: string;
		target_count: number;
		produced_count: number;
		iterations: number;
		context: string;
		feedback_total: number;
		feedback_count: number;
	}>;
	range: { from: string; to: string };
}

export async function getCachedDiscoveryHistory(
	context: Context | null,
	fromIso: string,
	toIso: string,
): Promise<CachedDiscoveryHistory> {
	"use cache";
	cacheTag("discovery:history");
	cacheLife(DISCOVERY_LIFE);

	const sb = getServiceClient();

	let q = sb
		.from("discovery_run_feedback_stats")
		.select(
			"id, run_at, completed_at, status, target_count, produced_count, iterations, context, product_count, feedback_count",
		)
		.gte("run_at", fromIso)
		.lte("run_at", toIso)
		.order("run_at", { ascending: false });

	if (context) q = q.eq("context", context);

	const { data } = await q;

	const sessions = (data ?? []).map((row) => ({
		id: row.id,
		run_at: row.run_at,
		completed_at: row.completed_at,
		status: row.status,
		target_count: row.target_count,
		produced_count: row.produced_count,
		iterations: row.iterations,
		context: row.context,
		feedback_total: row.product_count ?? 0,
		feedback_count: row.feedback_count ?? 0,
	}));

	return { sessions, range: { from: fromIso, to: toIso } };
}

export interface CachedDiscoverySelections {
	products: Array<Record<string, unknown>>;
	total: number;
	page: number;
	limit: number;
}

export async function getCachedDiscoverySelections(
	context: Context | null,
	status: string | null,
	days: number,
	page: number,
	limit: number,
): Promise<CachedDiscoverySelections> {
	"use cache";
	cacheTag("discovery:selections");
	cacheLife(DISCOVERY_LIFE);

	const sb = getServiceClient();

	const fromDate = new Date();
	fromDate.setUTCDate(fromDate.getUTCDate() - days);

	let query = sb
		.from("discovered_products")
		.select("*", { count: "exact" })
		.gte("action_at", fromDate.toISOString())
		.order("action_at", { ascending: false });

	if (status && ["sourced", "interested", "rejected", "duplicate"].includes(status)) {
		query = query.eq("user_action", status);
	} else {
		query = query.not("user_action", "is", null);
	}

	if (context) query = query.eq("context", context);

	const { data, count } = await query.range(page * limit, page * limit + limit - 1);

	return {
		products: (data ?? []) as Array<Record<string, unknown>>,
		total: count ?? 0,
		page,
		limit,
	};
}
```

- [ ] **Step 2: Verify type-check**

Run: `npx tsc --noEmit`
Expected: no errors. If any, fix before committing.

- [ ] **Step 3: Verify lint**

Run: `npm run lint`
Expected: no new warnings or errors from this file.

**Implementation notes (T1):** `mondayIso` is passed from the route handler instead of being computed inside the `'use cache'` body. A `new Date()` call inside `'use cache'` would bake the original timestamp into the cached entry — on Mondays between JST 00:00 and the daily-learning cron at JST 07:45, the cached "this week" KPI would return last week's numbers. `thirtyDaysAgo` drift inside the cached body is acceptable (sub-1% of a 30-day window) and is left unchanged. `getCachedDiscoverySelections` `days`/`now` drift is similarly small and unchanged.

- [ ] **Step 4: Commit**

```bash
git add lib/discovery/cached.ts
git commit -m "$(cat <<'EOF'
feat(discovery): add cached helpers for today/insights/history/selections

Five 'use cache' helpers in lib/discovery/cached.ts, all using service
client + 6h/24h cacheLife. Cache tags follow the design:
- discovery:home_shopping / discovery:live_commerce (today)
- discovery:insights, discovery:history, discovery:selections
- discovery:category-distribution (shared by today)

Spec: docs/superpowers/specs/2026-05-24-additional-page-caching-design.md
EOF
)"
```

---

## Task 2: Sales analytics cached helpers

**Files:**
- Create: `lib/analytics/cached.ts`

- [ ] **Step 1: Create the helper module**

Path: `lib/analytics/cached.ts`

```ts
import "server-only";
import {
	unstable_cacheLife as cacheLife,
	unstable_cacheTag as cacheTag,
} from "next/cache";
import { getServiceClient } from "@/lib/supabase";

const ONE_DAY = 60 * 60 * 24;
const SEVEN_DAYS = ONE_DAY * 7;

const SALES_LIFE = { revalidate: ONE_DAY, expire: SEVEN_DAYS };

export interface CachedSalesOverview {
	totalRevenue: number;
	totalCost: number;
	totalProfit: number;
	totalQuantity: number;
	marginRate: number;
	uniqueProducts: number;
	weekCount: number;
	categoryBreakdown: Array<{
		category: string;
		revenue: number;
		quantity: number;
		profit: number;
	}>;
	yearlyKpis: Record<number, { revenue: number; profit: number; quantity: number }>;
	years: number[];
}

export async function getCachedSalesOverview(
	years: number[],
): Promise<CachedSalesOverview> {
	"use cache";
	cacheTag("analytics:sales");
	cacheLife(SALES_LIFE);

	const supabase = getServiceClient();

	const [annualResult, categoryResult] = await Promise.all([
		supabase.from("annual_summaries").select("*").in("year", years),
		supabase.from("category_summaries").select("*").in("year", years),
	]);

	const annuals = annualResult.data ?? [];
	const categories = categoryResult.data ?? [];

	const totalRevenue = annuals.reduce((s, a) => s + (a.total_revenue ?? 0), 0);
	const totalCost = annuals.reduce((s, a) => s + (a.total_cost ?? 0), 0);
	const totalProfit = annuals.reduce((s, a) => s + (a.total_profit ?? 0), 0);
	const totalQuantity = annuals.reduce((s, a) => s + (a.total_quantity ?? 0), 0);
	const weekCount = annuals.reduce((s, a) => s + (a.week_count ?? 0), 0);
	const marginRate = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

	const uniqueProducts =
		new Set(annuals.map((a) => a.product_count)).size > 0
			? Math.max(...annuals.map((a) => a.product_count ?? 0))
			: 0;

	const catMap: Record<string, { revenue: number; quantity: number; profit: number }> = {};
	for (const c of categories) {
		const cat = c.category;
		if (!catMap[cat]) catMap[cat] = { revenue: 0, quantity: 0, profit: 0 };
		catMap[cat].revenue += c.total_revenue ?? 0;
		catMap[cat].quantity += c.total_quantity ?? 0;
		catMap[cat].profit += c.total_profit ?? 0;
	}
	const categoryBreakdown = Object.entries(catMap)
		.map(([category, data]) => ({ category, ...data }))
		.sort((a, b) => b.revenue - a.revenue);

	const yearlyKpis: Record<number, { revenue: number; profit: number; quantity: number }> = {};
	for (const a of annuals) {
		yearlyKpis[a.year] = {
			revenue: a.total_revenue ?? 0,
			profit: a.total_profit ?? 0,
			quantity: a.total_quantity ?? 0,
		};
	}

	return {
		totalRevenue,
		totalCost,
		totalProfit,
		totalQuantity,
		marginRate: Math.round(marginRate * 100) / 100,
		uniqueProducts,
		weekCount,
		categoryBreakdown,
		yearlyKpis,
		years,
	};
}

export interface CachedSalesTrends {
	period: "weekly" | "monthly";
	trends: Array<Record<string, unknown>>;
}

export async function getCachedSalesTrends(
	years: number[],
	period: "weekly" | "monthly",
): Promise<CachedSalesTrends> {
	"use cache";
	cacheTag("analytics:sales");
	cacheLife(SALES_LIFE);

	const supabase = getServiceClient();

	const dateFilters = years.map((y) => ({
		start: `${y}-01-01`,
		end: `${y}-12-31`,
	}));

	const { data } = await supabase
		.from("sales_weekly_totals")
		.select("*")
		.or(dateFilters.map((d) => `and(week_start.gte.${d.start},week_start.lte.${d.end})`).join(","))
		.order("week_start", { ascending: true });

	const rows = data ?? [];

	if (period === "monthly") {
		const monthMap: Record<
			string,
			{ revenue: number; profit: number; quantity: number; cost: number; weeks: number }
		> = {};
		for (const row of rows) {
			const month = row.week_start.slice(0, 7);
			if (!monthMap[month])
				monthMap[month] = { revenue: 0, profit: 0, quantity: 0, cost: 0, weeks: 0 };
			monthMap[month].revenue += row.total_revenue ?? 0;
			monthMap[month].profit += row.total_gross_profit ?? 0;
			monthMap[month].quantity += row.total_quantity ?? 0;
			monthMap[month].cost += row.total_cost ?? 0;
			monthMap[month].weeks += 1;
		}
		const trends = Object.entries(monthMap)
			.map(([month, d]) => ({
				date: month,
				revenue: d.revenue,
				profit: d.profit,
				quantity: d.quantity,
				cost: d.cost,
				marginRate:
					d.revenue > 0 ? Math.round((d.profit / d.revenue) * 10000) / 100 : 0,
			}))
			.sort((a, b) => (a.date as string).localeCompare(b.date as string));
		return { period: "monthly", trends };
	}

	const trends = rows.map((row) => ({
		date: row.week_start,
		dateEnd: row.week_end,
		revenue: row.total_revenue,
		profit: row.total_gross_profit,
		quantity: row.total_quantity,
		cost: row.total_cost,
		marginRate:
			row.total_revenue > 0
				? Math.round((row.total_gross_profit / row.total_revenue) * 10000) / 100
				: 0,
	}));

	return { period: "weekly", trends };
}

export interface CachedSalesProduct {
	code: string;
	name: string;
	category: string | null;
	totalRevenue: number;
	totalCost: number;
	totalProfit: number;
	totalQuantity: number;
	weekCount: number;
	marginRate: number;
	avgWeeklyQuantity: number;
	avgWeeklyRevenue: number;
	firstDate: string | null;
	lastDate: string | null;
}

export interface CachedSalesProducts {
	products: CachedSalesProduct[];
	total: number;
}

/**
 * Returns the UNMASKED product list. The caller (route handler) is responsible
 * for masking cost/profit/marginRate to null when auth.role === 'viewer'.
 */
export async function getCachedSalesProducts(
	years: number[],
	sort: string,
	limit: number,
	category: string | null,
): Promise<CachedSalesProducts> {
	"use cache";
	cacheTag("analytics:sales");
	cacheLife(SALES_LIFE);

	const supabase = getServiceClient();

	let query = supabase.from("product_summaries").select("*").in("year", years);
	if (category) query = query.eq("category", category);

	const dateFilters = years.map((y) => ({
		start: `${y}-01-01`,
		end: `${y}-12-31`,
	}));

	const [summaryResult, dateResult] = await Promise.all([
		query,
		supabase
			.from("sales_weekly")
			.select("product_code, week_start")
			.or(dateFilters.map((d) => `and(week_start.gte.${d.start},week_start.lte.${d.end})`).join(","))
			.order("week_start", { ascending: true }),
	]);

	const dateMap: Record<string, { firstDate: string; lastDate: string }> = {};
	for (const row of dateResult.data ?? []) {
		const code = row.product_code;
		const d = row.week_start;
		if (!dateMap[code]) {
			dateMap[code] = { firstDate: d, lastDate: d };
		} else {
			if (d < dateMap[code].firstDate) dateMap[code].firstDate = d;
			if (d > dateMap[code].lastDate) dateMap[code].lastDate = d;
		}
	}

	const productMap: Record<
		string,
		{
			code: string;
			name: string;
			category: string | null;
			totalRevenue: number;
			totalCost: number;
			totalProfit: number;
			totalQuantity: number;
			weekCount: number;
		}
	> = {};

	for (const row of summaryResult.data ?? []) {
		const key = row.product_code;
		if (!productMap[key]) {
			productMap[key] = {
				code: row.product_code,
				name: row.product_name,
				category: row.category,
				totalRevenue: 0,
				totalCost: 0,
				totalProfit: 0,
				totalQuantity: 0,
				weekCount: 0,
			};
		}
		productMap[key].totalRevenue += row.total_revenue ?? 0;
		productMap[key].totalCost += row.total_cost ?? 0;
		productMap[key].totalProfit += row.total_profit ?? 0;
		productMap[key].totalQuantity += row.total_quantity ?? 0;
		productMap[key].weekCount += row.week_count ?? 0;
	}

	let products: CachedSalesProduct[] = Object.values(productMap).map((p) => ({
		...p,
		marginRate:
			p.totalRevenue > 0 ? Math.round((p.totalProfit / p.totalRevenue) * 10000) / 100 : 0,
		avgWeeklyQuantity: p.weekCount > 0 ? Math.round(p.totalQuantity / p.weekCount) : 0,
		avgWeeklyRevenue: p.weekCount > 0 ? Math.round(p.totalRevenue / p.weekCount) : 0,
		firstDate: dateMap[p.code]?.firstDate ?? null,
		lastDate: dateMap[p.code]?.lastDate ?? null,
	}));

	switch (sort) {
		case "quantity":
			products.sort((a, b) => b.totalQuantity - a.totalQuantity);
			break;
		case "margin":
			products.sort((a, b) => b.marginRate - a.marginRate);
			break;
		default:
			products.sort((a, b) => b.totalRevenue - a.totalRevenue);
	}

	products = products.slice(0, limit);

	return { products, total: Object.keys(productMap).length };
}
```

- [ ] **Step 2: Verify type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify lint**

Run: `npm run lint`
Expected: no new warnings or errors.

- [ ] **Step 4: Commit**

```bash
git add lib/analytics/cached.ts
git commit -m "$(cat <<'EOF'
feat(analytics): add cached helpers for sales overview/trends/products

Three 'use cache' helpers in lib/analytics/cached.ts, all under the
single analytics:sales tag. Uses 24h/7d cacheLife since the source data
(sales summary tables) has no cron — manual scripts/compute-summaries.ts
is the only writer.

getCachedSalesProducts returns UNMASKED data; viewer-role masking is the
route handler's responsibility.

Spec: docs/superpowers/specs/2026-05-24-additional-page-caching-design.md
EOF
)"
```

---

## Task 3: Switch Discovery route handlers to cached helpers

**Files:**
- Modify: `app/api/discovery/today/route.ts`
- Modify: `app/api/discovery/insights/route.ts`
- Modify: `app/api/discovery/history/route.ts`
- Modify: `app/api/discovery/selections/route.ts`

- [ ] **Step 1: Rewrite `app/api/discovery/today/route.ts`**

Full replacement contents:

```ts
import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { loadCategoryDistribution } from "@/lib/discovery/category-distribution";
import { getCachedDiscoveryToday } from "@/lib/discovery/cached";

export const dynamic = "force-dynamic";

/**
 * Return the most recent completed or partial session + its products.
 * Query params:
 *   - context: home_shopping | live_commerce (cached path); other/missing → uncached fallback
 *   - status: filter discovered_products.user_action (sourced|interested|rejected|duplicate)
 *   - track: filter by tv_proven|exploration
 */
export async function GET(req: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { searchParams } = new URL(req.url);
	const contextFilter = searchParams.get("context");
	const statusFilter = searchParams.get("status");
	const trackFilter = searchParams.get("track");

	if (contextFilter === "home_shopping" || contextFilter === "live_commerce") {
		try {
			const cached = await getCachedDiscoveryToday(contextFilter);
			if (!cached.session) {
				return NextResponse.json({ session: null, products: [] });
			}
			let products = cached.products;
			if (statusFilter === "uncategorized") {
				products = products.filter((p) => !(p as { user_action?: string }).user_action);
			} else if (statusFilter) {
				products = products.filter(
					(p) => (p as { user_action?: string }).user_action === statusFilter,
				);
			}
			if (trackFilter) {
				products = products.filter((p) => (p as { track?: string }).track === trackFilter);
			}
			return NextResponse.json({
				session: cached.session,
				products,
				categoryStats: cached.categoryStats,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return NextResponse.json({ error: message }, { status: 500 });
		}
	}

	// Uncached fallback: caller did not specify a known context. Preserves the
	// pre-caching behaviour for any callers that omit `context`.
	const sb = getServiceClient();
	const { data: session, error: sessErr } = await sb
		.from("discovery_runs")
		.select("*")
		.in("status", ["completed", "partial"])
		.order("run_at", { ascending: false })
		.limit(1)
		.maybeSingle();

	if (sessErr) return NextResponse.json({ error: sessErr.message }, { status: 500 });
	if (!session) return NextResponse.json({ session: null, products: [] });

	let q = sb
		.from("discovered_products")
		.select("*")
		.eq("session_id", session.id)
		.order("tv_tier", { ascending: true })
		.order("tv_fit_score", { ascending: false });

	if (statusFilter === "uncategorized") q = q.is("user_action", null);
	else if (statusFilter) q = q.eq("user_action", statusFilter);
	if (trackFilter) q = q.eq("track", trackFilter);

	const [prodResult, categoryStats] = await Promise.all([q, loadCategoryDistribution()]);
	if (prodResult.error)
		return NextResponse.json({ error: prodResult.error.message }, { status: 500 });

	return NextResponse.json({
		session,
		products: prodResult.data ?? [],
		categoryStats,
	});
}
```

- [ ] **Step 2: Rewrite `app/api/discovery/insights/route.ts`**

Full replacement contents:

```ts
import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from "next/server";
import { getCachedDiscoveryInsights } from "@/lib/discovery/cached";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { searchParams } = new URL(req.url);
	const contextFilter = searchParams.get("context");
	const context =
		contextFilter === "home_shopping" || contextFilter === "live_commerce"
			? contextFilter
			: null;
	const weeks = Math.min(Number(searchParams.get("weeks") ?? 12), 52);

	const now = new Date();
	const day = now.getUTCDay();
	const daysFromMonday = day === 0 ? 6 : day - 1;
	const monday = new Date(now);
	monday.setUTCDate(now.getUTCDate() - daysFromMonday);
	monday.setUTCHours(0, 0, 0, 0);
	const mondayIso = monday.toISOString();

	try {
		const data = await getCachedDiscoveryInsights(context, weeks, mondayIso);
		return NextResponse.json(data);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
```

- [ ] **Step 3: Rewrite `app/api/discovery/history/route.ts`**

Full replacement contents:

```ts
import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from "next/server";
import { getCachedDiscoveryHistory } from "@/lib/discovery/cached";

export const dynamic = "force-dynamic";

/**
 * History API — returns sessions grouped by date for calendar rendering,
 * with optional context filter and date range.
 *
 * Query params:
 *   - context: home_shopping | live_commerce (optional)
 *   - from: ISO date (default: now - 60 days)
 *   - to: ISO date (default: now)
 */
export async function GET(req: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { searchParams } = new URL(req.url);
	const contextFilter = searchParams.get("context");
	const context =
		contextFilter === "home_shopping" || contextFilter === "live_commerce"
			? contextFilter
			: null;

	const toDate = (searchParams.get("to") ?? new Date().toISOString()).slice(0, 10);
	const fromDate = (
		searchParams.get("from") ??
		new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString()
	).slice(0, 10);

	try {
		const data = await getCachedDiscoveryHistory(context, fromDate, toDate);
		return NextResponse.json(data);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
```

- [ ] **Step 4: Rewrite `app/api/discovery/selections/route.ts`**

Full replacement contents:

```ts
import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from "next/server";
import { getCachedDiscoverySelections } from "@/lib/discovery/cached";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { searchParams } = new URL(req.url);
	const status = searchParams.get("status");
	const contextFilter = searchParams.get("context");
	const context =
		contextFilter === "home_shopping" || contextFilter === "live_commerce"
			? contextFilter
			: null;
	const days = Math.min(Number(searchParams.get("days") ?? 30), 365);
	const page = Math.max(Number(searchParams.get("page") ?? 0), 0);
	const limit = Math.min(Number(searchParams.get("limit") ?? 20), 100);

	try {
		const data = await getCachedDiscoverySelections(context, status, days, page, limit);
		return NextResponse.json(data);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
```

- [ ] **Step 5: Verify type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Verify lint**

Run: `npm run lint`
Expected: no new warnings or errors.

- [ ] **Step 7: Commit**

```bash
git add app/api/discovery/today/route.ts app/api/discovery/insights/route.ts app/api/discovery/history/route.ts app/api/discovery/selections/route.ts
git commit -m "$(cat <<'EOF'
perf(discovery): route handlers call cached helpers

today/insights/history/selections now defer DB work to lib/discovery/cached.ts
helpers. Per-request filters (status, track) are applied in-memory on the
cached result. today/route.ts keeps an uncached fallback for callers that
omit the `context` query param (existing API compatibility).
EOF
)"
```

---

## Task 4: Switch Sales route handlers to cached helpers (role-mask in route)

**Files:**
- Modify: `app/api/analytics/overview/route.ts`
- Modify: `app/api/analytics/trends/route.ts`
- Modify: `app/api/analytics/products/route.ts`

- [ ] **Step 1: Rewrite `app/api/analytics/overview/route.ts`**

Full replacement contents:

```ts
import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from "next/server";
import { getCachedSalesOverview } from "@/lib/analytics/cached";

export async function GET(request: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { searchParams } = new URL(request.url);
	const yearParam = searchParams.get("year") || "2025,2026";
	const years = yearParam.split(",").map(Number);

	if (years.length === 0 || years.some((y) => isNaN(y) || y < 2000 || y > 2100)) {
		return NextResponse.json({ error: "Invalid year parameter" }, { status: 400 });
	}

	try {
		const data = await getCachedSalesOverview(years);
		return NextResponse.json(data);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
```

- [ ] **Step 2: Rewrite `app/api/analytics/trends/route.ts`**

Full replacement contents:

```ts
import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from "next/server";
import { getCachedSalesTrends } from "@/lib/analytics/cached";

export async function GET(request: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { searchParams } = new URL(request.url);
	const yearParam = searchParams.get("year") || "2025,2026";
	const periodParam = searchParams.get("period") === "monthly" ? "monthly" : "weekly";
	const years = yearParam.split(",").map(Number);

	if (years.length === 0 || years.some((y) => isNaN(y) || y < 2000 || y > 2100)) {
		return NextResponse.json({ error: "Invalid year parameter" }, { status: 400 });
	}

	try {
		const data = await getCachedSalesTrends(years, periodParam);
		return NextResponse.json(data);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
```

- [ ] **Step 3: Rewrite `app/api/analytics/products/route.ts`**

Full replacement contents:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getCachedSalesProducts } from "@/lib/analytics/cached";

export async function GET(request: NextRequest) {
	const auth = await requireUser(["admin", "member", "viewer"]);
	if ("error" in auth) return auth.error;

	const { searchParams } = new URL(request.url);
	const yearParam = searchParams.get("year") || "2025,2026";
	const sortBy = searchParams.get("sort") || "revenue";
	const limitParam = parseInt(searchParams.get("limit") || "20");
	const categoryFilter = searchParams.get("category");
	const years = yearParam.split(",").map(Number);

	if (years.length === 0 || years.some((y) => isNaN(y) || y < 2000 || y > 2100)) {
		return NextResponse.json({ error: "Invalid year parameter" }, { status: 400 });
	}

	if (isNaN(limitParam) || limitParam < 1 || limitParam > 500) {
		return NextResponse.json({ error: "Invalid limit parameter" }, { status: 400 });
	}

	const isViewer = auth.role === "viewer";
	// For viewer, "margin" sort would be incoherent (they can't see margin).
	// Fall back to "revenue" before hitting the cache so we share its entry.
	const effectiveSort = isViewer && sortBy === "margin" ? "revenue" : sortBy;

	try {
		const { products: rawProducts, total } = await getCachedSalesProducts(
			years,
			effectiveSort,
			limitParam,
			categoryFilter,
		);

		const products = isViewer
			? rawProducts.map((p) => ({
					...p,
					totalCost: null as unknown as number,
					totalProfit: null as unknown as number,
					marginRate: null as unknown as number,
				}))
			: rawProducts;

		return NextResponse.json({ products, total, viewer: isViewer });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
```

- [ ] **Step 4: Verify type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Verify lint**

Run: `npm run lint`
Expected: no new warnings or errors.

- [ ] **Step 6: Commit**

```bash
git add app/api/analytics/overview/route.ts app/api/analytics/trends/route.ts app/api/analytics/products/route.ts
git commit -m "$(cat <<'EOF'
perf(analytics): sales route handlers call cached helpers

overview/trends/products now defer DB work to lib/analytics/cached.ts
helpers. Drops auth.sb (RLS client) in favor of the helper's service
client — auth still gated via requireUser.

products route masks totalCost/totalProfit/marginRate to null for
viewer role at response time so the cache entry stays shared across
all roles.
EOF
)"
```

---

## Task 5: Add cron invalidation for Discovery + Insights

**Files:**
- Modify: `app/api/cron/daily-discovery-home/route.ts`
- Modify: `app/api/cron/daily-discovery-live/route.ts`
- Modify: `app/api/cron/daily-learning/route.ts`
- Modify: `app/api/cron/weekly-insights/route.ts`

- [ ] **Step 1: Add invalidation to `daily-discovery-home/route.ts`**

Modify the file at the success-path return. Add `revalidateTag` import at top, then a try/catch block right before `return NextResponse.json({ ok: true, ... })` near the end of `GET()`:

```ts
import { revalidateTag } from "next/cache";
```

Inside the try-block that handles the successful path, immediately before the final `return NextResponse.json({ ok: true, context: CONTEXT, ... })`, add:

```ts
		try {
			revalidateTag("discovery:home_shopping", "max");
			revalidateTag("discovery:history", "max");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn("[cache] revalidateTag failed", {
				route: "daily-discovery-home",
				error: msg,
			});
		}
```

- [ ] **Step 2: Add invalidation to `daily-discovery-live/route.ts`**

Same pattern. After importing `revalidateTag` from `next/cache`, add this block at the end of the success path:

```ts
		try {
			revalidateTag("discovery:live_commerce", "max");
			revalidateTag("discovery:history", "max");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn("[cache] revalidateTag failed", {
				route: "daily-discovery-live",
				error: msg,
			});
		}
```

- [ ] **Step 3: Add invalidation to `daily-learning/route.ts`**

Import `revalidateTag` from `next/cache`. After the `for (const context of CONTEXTS)` loop, before the final `return NextResponse.json({ results, seasonal_categories: ... })`, add:

```ts
	if (results.some((r) => r.ok)) {
		try {
			revalidateTag("discovery:insights", "max");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn("[cache] revalidateTag failed", {
				route: "daily-learning",
				error: msg,
			});
		}
	}
```

- [ ] **Step 4: Add invalidation to `weekly-insights/route.ts`**

Import `revalidateTag` from `next/cache`. After the `for (const context of CONTEXTS)` loop, before the final `return NextResponse.json({ results })`, add:

```ts
	if (results.some((r) => r.ok)) {
		try {
			revalidateTag("discovery:insights", "max");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn("[cache] revalidateTag failed", {
				route: "weekly-insights",
				error: msg,
			});
		}
	}
```

- [ ] **Step 5: Verify type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Verify lint**

Run: `npm run lint`
Expected: no new warnings or errors.

- [ ] **Step 7: Commit**

```bash
git add app/api/cron/daily-discovery-home/route.ts app/api/cron/daily-discovery-live/route.ts app/api/cron/daily-learning/route.ts app/api/cron/weekly-insights/route.ts
git commit -m "$(cat <<'EOF'
feat(cron/discovery): invalidate discovery page caches after each run

daily-discovery-home → discovery:home_shopping + discovery:history
daily-discovery-live → discovery:live_commerce + discovery:history
daily-learning       → discovery:insights
weekly-insights      → discovery:insights

All wrapped in best-effort try/catch — revalidation failure does not
turn a successful cron run into an error.
EOF
)"
```

---

## Task 6: Extend broadcasts crons to invalidate category-distribution

**Files:**
- Modify: `app/api/cron/daily-broadcasts/route.ts`
- Modify: `app/api/cron/daily-historical-broadcasts/route.ts`

Both files already have a `try { revalidateTag(...broadcasts...) } catch { ... }` block from PR #78. We append one extra call inside the same try.

- [ ] **Step 1: Extend `daily-broadcasts/route.ts`**

Find this existing block (near the end of `GET()`):

```ts
	try {
		const ym = getJSTYearMonth(target);
		revalidateTag(`broadcasts:calendar:${ym}`, "max");
		revalidateTag("broadcasts:totals", "max");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn("[cache] revalidateTag failed", { route: "daily-broadcasts", error: msg });
	}
```

Add one line so the inner contents become:

```ts
		const ym = getJSTYearMonth(target);
		revalidateTag(`broadcasts:calendar:${ym}`, "max");
		revalidateTag("broadcasts:totals", "max");
		revalidateTag("discovery:category-distribution", "max");
```

- [ ] **Step 2: Extend `daily-historical-broadcasts/route.ts`**

Find the existing block:

```ts
			try {
				const ym = date.slice(0, 7); // date is "YYYY-MM-DD" from jstToday()
				revalidateTag(`broadcasts:calendar:${ym}`, "max");
				revalidateTag("broadcasts:totals", "max");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn("[cache] revalidateTag failed", { route: "daily-historical-broadcasts", error: msg });
			}
```

Add one line so the inner contents become:

```ts
				const ym = date.slice(0, 7); // date is "YYYY-MM-DD" from jstToday()
				revalidateTag(`broadcasts:calendar:${ym}`, "max");
				revalidateTag("broadcasts:totals", "max");
				revalidateTag("discovery:category-distribution", "max");
```

- [ ] **Step 3: Verify type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Verify lint**

Run: `npm run lint`
Expected: no new warnings or errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/daily-broadcasts/route.ts app/api/cron/daily-historical-broadcasts/route.ts
git commit -m "$(cat <<'EOF'
feat(cron/broadcasts): invalidate discovery:category-distribution after crawl

The discovery /today endpoint surfaces a per-category competitor-frequency
strip computed from broadcasts.category + historical_broadcasts.category.
Both scrape crons now invalidate the shared discovery:category-distribution
tag in the same best-effort block already used for the calendar tags.
EOF
)"
```

---

## Task 7: Add mutation invalidation

**Files:**
- Modify: `app/api/discovery/feedback/route.ts`
- Modify: `app/api/discovery/[productId]/promote-to-research/route.ts`
- Modify: `app/api/discovery/enrich/[productId]/worker/route.ts`

Each handler invalidates the same 5 discovery tags on a successful write. The invalidation is intentionally coarse: the mutation endpoints do not cheaply know the product's context, so both `home_shopping` and `live_commerce` are flushed.

Define a single helper so each route stays a one-liner. Add it to the existing `lib/discovery/cached.ts`.

- [ ] **Step 1: Add `invalidateDiscoveryAfterMutation` to `lib/discovery/cached.ts`**

Two edits to `lib/discovery/cached.ts`:

First, add `revalidateTag` to the existing top-level imports from `next/cache`. The current import line is:

```ts
import {
	unstable_cacheLife as cacheLife,
	unstable_cacheTag as cacheTag,
} from "next/cache";
```

Replace it with:

```ts
import {
	revalidateTag,
	unstable_cacheLife as cacheLife,
	unstable_cacheTag as cacheTag,
} from "next/cache";
```

Then append to the bottom of the file:

```ts
const MUTATION_TAGS = [
	"discovery:home_shopping",
	"discovery:live_commerce",
	"discovery:insights",
	"discovery:history",
	"discovery:selections",
] as const;

/**
 * Coarse invalidation called from discovery mutation endpoints. Best-effort:
 * failures are logged but do not propagate. The 24h expire cacheLife is the
 * safety net.
 */
export function invalidateDiscoveryAfterMutation(source: string): void {
	try {
		for (const tag of MUTATION_TAGS) {
			revalidateTag(tag, "max");
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn("[cache] revalidateTag failed", { source, error: msg });
	}
}
```

- [ ] **Step 2: Call invalidator from `app/api/discovery/feedback/route.ts`**

At the top, add the import:

```ts
import { invalidateDiscoveryAfterMutation } from "@/lib/discovery/cached";
```

Then call it immediately before each successful `return NextResponse.json(...)` (there are two: one in the toggle-off branch, one in the set branch). The two return sites are:

1. The `return NextResponse.json({ ok: true, action: "toggled_off", ... })` at the end of the `if (isOwnToggleOff)` branch.
2. The final `return NextResponse.json({ ok: true, action: "set", user_action: body.action })`.

Insert this line immediately before each:

```ts
	invalidateDiscoveryAfterMutation("feedback");
```

- [ ] **Step 3: Call invalidator from `app/api/discovery/[productId]/promote-to-research/route.ts`**

Add the import:

```ts
import { invalidateDiscoveryAfterMutation } from "@/lib/discovery/cached";
```

Inside the `try` block, immediately before `return NextResponse.json(result);`, insert:

```ts
		invalidateDiscoveryAfterMutation("promote-to-research");
```

- [ ] **Step 4: Call invalidator from `app/api/discovery/enrich/[productId]/worker/route.ts`**

The dispatch route at `app/api/discovery/enrich/[productId]/route.ts` only sets `enrichment_status='queued'` and returns 202. The actual c_package write happens in the internal `worker` route invoked via `after()`. Invalidate there.

Add the import to the worker file:

```ts
import { invalidateDiscoveryAfterMutation } from "@/lib/discovery/cached";
```

The worker has one success return after writing `enrichment_status: "completed"` and the `c_package`. Immediately before `return NextResponse.json({ ok: true, productId, partial: pkg.partial });`, insert:

```ts
		invalidateDiscoveryAfterMutation("enrich-worker");
```

Do NOT add invalidation to the failure path — failure does not change displayed product data beyond an error flag, which is per-product detail (not visible on the cached discovery/today list).

Do NOT add invalidation to the dispatch route — it does not write data that affects the cached `discovery/today` payload meaningfully.

- [ ] **Step 5: Verify type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Verify lint**

Run: `npm run lint`
Expected: no new warnings or errors.

- [ ] **Step 7: Commit**

```bash
git add lib/discovery/cached.ts app/api/discovery/feedback/route.ts app/api/discovery/[productId]/promote-to-research/route.ts app/api/discovery/enrich/[productId]/worker/route.ts
git commit -m "$(cat <<'EOF'
feat(discovery/mutations): invalidate page caches after writes

feedback, promote-to-research, and enrich POSTs invalidate all five
discovery cache tags via the new invalidateDiscoveryAfterMutation
helper. Coarse-grained: mutation endpoints don't cheaply know the
affected product's context, so both home_shopping and live_commerce
are flushed.

Best-effort: invalidation failure is logged, not propagated. The cron
re-invalidation and 24h expire are the safety nets.
EOF
)"
```

---

## Task 8: Build verification + push + PR

**Files:** none modified.

- [ ] **Step 1: Full type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no new warnings or errors.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build completes successfully. The `'use cache'` directive in the two new helper files is statically validated here — any misuse (e.g. closure over a non-serialisable value) will fail.

If the build complains about `experimental.useCache`, confirm the flag is already set in `next.config.ts` (added by PR #78). Do NOT re-add it.

- [ ] **Step 4: Push branch**

```bash
git push -u origin worktree-additional-page-caching
```

- [ ] **Step 5: Open PR**

```bash
gh pr create --title "perf: cache Discovery + Sales analytics page data fetches" --body "$(cat <<'EOF'
## Summary

- Extends the broadcasts `/broadcasts` caching pattern (PR #78) to:
  - Discovery: `/api/discovery/today`, `/insights`, `/history`, `/selections`
  - Sales analytics: `/api/analytics/overview`, `/trends`, `/products`
- Adds `lib/discovery/cached.ts` (5 helpers + mutation invalidator) and `lib/analytics/cached.ts` (3 helpers).
- Discovery: `cacheLife({ revalidate: 6h, expire: 24h })`, invalidated by 4 cron routes (`daily-discovery-home`, `daily-discovery-live`, `daily-learning`, `weekly-insights`) + 3 mutation routes (feedback, promote-to-research, enrich) + the two broadcasts crons (for the shared `discovery:category-distribution` tag).
- Sales: `cacheLife({ revalidate: 24h, expire: 7d })`. No source cron — manual `scripts/compute-summaries.ts` is the only writer. An admin-triggered manual-invalidation endpoint is left as follow-up.
- `getCachedSalesProducts` returns unmasked data; viewer-role masking moved to the route handler so the cache entry stays shared across roles.

## Post-deploy verification

Per spec §11:

- [ ] **A. Discovery home** — visit `/ja/analytics/discovery/home` logged in, refresh → 0 DB reads (cache hit). Click "sourced" → refresh → DB reads occur; refresh again → 0.
- [ ] **B. Discovery insights** — visit `/ja/analytics/discovery/insights` Stats tab → refresh → 0. Feedback elsewhere → refresh insights → DB reads occur.
- [ ] **C. Discovery history** — visit `/ja/analytics/discovery/history` → refresh → 0. Feedback elsewhere → refresh → DB reads occur.
- [ ] **D. Sales overview** — visit `/ja/analytics/overview` → refresh → all 3 APIs return 0 DB reads. With a viewer account, call `/api/analytics/products?year=2026&limit=5` → confirm `totalCost`/`totalProfit`/`marginRate` are `null`.
- [ ] **E. Cron invalidation** — inspect Vercel cron logs for daily-discovery-home/live, daily-learning, weekly-insights, daily-broadcasts, daily-historical-broadcasts — confirm no errors from the new `revalidateTag` blocks.

## Test plan

- [x] `npx tsc --noEmit` passes
- [x] `npm run lint` passes
- [x] `npm run build` passes
- [ ] Post-deploy checklist above

Spec: `docs/superpowers/specs/2026-05-24-additional-page-caching-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Implementation notes

- All `'use cache'` helpers use `getServiceClient()`. The route handler is the only place auth is enforced.
- All `revalidateTag` calls use the two-arg form `revalidateTag(tag, "max")` per Next.js 16.1.6.
- The single `invalidateDiscoveryAfterMutation` helper centralizes the coarse 5-tag invalidation so each mutation endpoint adds exactly one call.
- Sales `marginRate` for viewer is set to `null`. The downstream `/analytics/overview` UI already handles missing margin via existing viewer code paths in the route handler logic preserved in Task 4.
- No changes to client components, no changes to `next.config.ts` (already has `useCache: true` from PR #78).
