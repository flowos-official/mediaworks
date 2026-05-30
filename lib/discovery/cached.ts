import "server-only";
import {
	revalidateTag,
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
	// Since the selection-outcome loop, learning_state.category_weights is a graded
	// outcome weight in [0, cap] (cap=3 default), not the old [0,1] success-rate.
	// This insights value feeds the dashboard chart (a [0,1] %-axis) only — the
	// keyword-planning prompt reads the raw [0,cap] value via loadLearningState —
	// so normalize to fraction-of-cap here to keep the chart bounded.
	const WEIGHT_CAP = Number(process.env.LEARNING_CATEGORY_WEIGHT_CAP ?? 3) || 3;
	for (const cat of Object.keys(categoryWeights)) {
		categoryWeights[cat] = Math.min(1, categoryWeights[cat] / WEIGHT_CAP);
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

const MUTATION_TAGS = [
	"discovery:home_shopping",
	"discovery:live_commerce",
	"discovery:insights",
	"discovery:history",
	"discovery:selections",
	"selections:board",
	"selections:counts",
] as const;

/**
 * Coarse invalidation called from discovery mutation endpoints. Best-effort:
 * failures are logged but do not propagate. The 24h expire cacheLife is the
 * safety net.
 */
export function invalidateDiscoveryAfterMutation(source: string): void {
	for (const tag of MUTATION_TAGS) {
		try {
			revalidateTag(tag, "max");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn("[cache] revalidateTag failed", { source, tag, error: msg });
		}
	}
}
