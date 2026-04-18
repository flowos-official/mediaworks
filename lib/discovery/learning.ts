/**
 * Learning aggregation — computes context-specific learning_state values
 * from the last 30 days of product_feedback + discovered_products.
 * Ref: spec §5 Phase 4.
 *
 * Sources:
 *  - discovered_products.user_action: current toggle state (respects undo)
 *  - product_feedback (action='deep_dive'): implicit interest signal
 */

import { getServiceClient } from "@/lib/supabase";
import type { Context } from "./types";

const WINDOW_DAYS = 30;
const COLD_START_THRESHOLD = 10;
const EXPLORATION_ADJUST_STEP = 0.05;
const EXPLORATION_MIN = 0.2;
const EXPLORATION_MAX = 0.67;
const EXPLORATION_LOSS_MARGIN = 0.1;
const CATEGORY_MIN_SAMPLES = 5;
const REJECTION_TOP_N = 5;

export interface ContextLearningStats {
	exploration_ratio: number;
	category_weights: Record<string, number>;
	rejected_seeds: { urls: string[]; brands: string[]; terms: string[] };
	recent_rejection_reasons: Array<{ reason: string; count: number }>;
	feedback_sample_size: number;
	is_cold_start: boolean;
}

interface ExplicitRow {
	category: string | null;
	seller_name: string | null;
	product_url: string;
	track: "tv_proven" | "exploration";
	user_action: "sourced" | "interested" | "rejected" | "duplicate";
	action_reason: string | null;
}

interface ShownRow {
	category: string | null;
	track: "tv_proven" | "exploration";
}

interface DeepDiveRow {
	discovered_products: { category: string | null; track: "tv_proven" | "exploration" } | null;
}

function unique<T>(arr: T[]): T[] {
	return [...new Set(arr)];
}

export async function computeContextLearning(
	context: Context,
	currentExplorationRatio: number,
): Promise<ContextLearningStats> {
	const sb = getServiceClient();
	const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

	const { data: explicitData, error: exErr } = await sb
		.from("discovered_products")
		.select("category, seller_name, product_url, track, user_action, action_reason")
		.eq("context", context)
		.not("user_action", "is", null)
		.gte("action_at", since);

	if (exErr) {
		console.warn(`[learning] explicit query failed (${context}):`, exErr.message);
	}
	const explicit = (explicitData ?? []) as ExplicitRow[];

	const { data: shownData, error: shErr } = await sb
		.from("discovered_products")
		.select("category, track")
		.eq("context", context)
		.gte("created_at", since);

	if (shErr) {
		console.warn(`[learning] shown query failed (${context}):`, shErr.message);
	}
	const shown = (shownData ?? []) as ShownRow[];

	const { data: ddData, error: ddErr } = await sb
		.from("product_feedback")
		.select("discovered_products!inner(category, track, context)")
		.eq("action", "deep_dive")
		.eq("discovered_products.context", context)
		.gte("created_at", since);

	if (ddErr) {
		console.warn(`[learning] deep_dive query failed (${context}):`, ddErr.message);
	}
	const deepDives = (ddData ?? []) as unknown as DeepDiveRow[];

	const feedbackSampleSize = explicit.length + deepDives.length;
	const isColdStart = feedbackSampleSize < COLD_START_THRESHOLD;

	if (isColdStart) {
		return {
			exploration_ratio: currentExplorationRatio,
			category_weights: {},
			rejected_seeds: { urls: [], brands: [], terms: [] },
			recent_rejection_reasons: [],
			feedback_sample_size: feedbackSampleSize,
			is_cold_start: true,
		};
	}

	const categoryStats = new Map<string, { success: number; shown: number }>();
	for (const s of shown) {
		const cat = s.category;
		if (!cat) continue;
		const stat = categoryStats.get(cat) ?? { success: 0, shown: 0 };
		stat.shown += 1;
		categoryStats.set(cat, stat);
	}
	for (const e of explicit) {
		if (!e.category) continue;
		if (e.user_action === "sourced" || e.user_action === "interested") {
			const stat = categoryStats.get(e.category) ?? { success: 0, shown: 0 };
			stat.success += 1;
			categoryStats.set(e.category, stat);
		}
	}
	for (const d of deepDives) {
		const cat = d.discovered_products?.category;
		if (!cat) continue;
		const stat = categoryStats.get(cat) ?? { success: 0, shown: 0 };
		stat.success += 1;
		categoryStats.set(cat, stat);
	}

	const categoryWeights: Record<string, number> = {};
	for (const [cat, { success, shown: total }] of categoryStats) {
		if (total < CATEGORY_MIN_SAMPLES) {
			categoryWeights[cat] = 0.5;
		} else {
			categoryWeights[cat] = Number((success / total).toFixed(3));
		}
	}

	const rejected = explicit.filter((e) => e.user_action === "rejected");
	const rejectedUrls = unique(rejected.map((r) => r.product_url));
	const rejectedBrands = unique(
		rejected.map((r) => r.seller_name).filter((s): s is string => !!s),
	);

	const reasonCounts = new Map<string, number>();
	for (const r of rejected) {
		if (!r.action_reason) continue;
		reasonCounts.set(r.action_reason, (reasonCounts.get(r.action_reason) ?? 0) + 1);
	}
	const recentRejectionReasons = [...reasonCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, REJECTION_TOP_N)
		.map(([reason, count]) => ({ reason, count }));

	const trackStats = {
		tv_proven: { success: 0, shown: 0 },
		exploration: { success: 0, shown: 0 },
	};
	for (const s of shown) trackStats[s.track].shown += 1;
	for (const e of explicit) {
		if (e.user_action === "sourced" || e.user_action === "interested") {
			trackStats[e.track].success += 1;
		}
	}
	for (const d of deepDives) {
		const track = d.discovered_products?.track;
		if (track) trackStats[track].success += 1;
	}

	const tvRate =
		trackStats.tv_proven.shown > 0
			? trackStats.tv_proven.success / trackStats.tv_proven.shown
			: 0;
	const expRate =
		trackStats.exploration.shown > 0
			? trackStats.exploration.success / trackStats.exploration.shown
			: 0;

	let nextRatio = currentExplorationRatio;
	if (feedbackSampleSize >= 20) {
		if (expRate >= tvRate) {
			nextRatio = Math.min(EXPLORATION_MAX, currentExplorationRatio + EXPLORATION_ADJUST_STEP);
		} else if (expRate < tvRate - EXPLORATION_LOSS_MARGIN) {
			nextRatio = Math.max(EXPLORATION_MIN, currentExplorationRatio - EXPLORATION_ADJUST_STEP);
		}
	}

	return {
		exploration_ratio: Number(nextRatio.toFixed(2)),
		category_weights: categoryWeights,
		rejected_seeds: { urls: rejectedUrls, brands: rejectedBrands, terms: [] },
		recent_rejection_reasons: recentRejectionReasons,
		feedback_sample_size: feedbackSampleSize,
		is_cold_start: false,
	};
}
