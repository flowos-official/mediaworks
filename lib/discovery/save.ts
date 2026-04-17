/**
 * Persistence for discovery pipeline — writes to discovery_runs and
 * discovered_products. All DB writes gated through service role client.
 * Ref: spec §4.2 단계 1, 단계 8.
 */

import { getServiceClient } from "@/lib/supabase";
import { normalizeName } from "./exclusion";
import type {
	BroadcastTag,
	Candidate,
	CategoryPlan,
	SessionStatus,
} from "./types";

/**
 * Create a new discovery_runs row with status='running'.
 * Returns the inserted row id.
 */
export async function createSession(input: {
	targetCount: number;
	explorationRatio: number;
}): Promise<string> {
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("discovery_runs")
		.insert({
			status: "running" as SessionStatus,
			target_count: input.targetCount,
			produced_count: 0,
			exploration_ratio: input.explorationRatio,
			iterations: 0,
		})
		.select("id")
		.single();
	if (error || !data) {
		throw new Error(
			`[save] createSession failed: ${error?.message ?? "unknown"}`,
		);
	}
	return data.id as string;
}

/**
 * Update session with plan after planning step.
 */
export async function attachPlanToSession(
	sessionId: string,
	plan: CategoryPlan,
): Promise<void> {
	const sb = getServiceClient();
	const { error } = await sb
		.from("discovery_runs")
		.update({ category_plan: plan })
		.eq("id", sessionId);
	if (error) {
		console.warn(`[save] attachPlanToSession failed: ${error.message}`);
	}
}

export interface SaveBatch {
	candidate: Candidate;
	broadcastTag: BroadcastTag;
	broadcastSources: Array<{ title: string; url: string }>;
}

/**
 * Bulk insert discovered_products for a session.
 * Skips rows that violate unique (session_id, product_url) — idempotent on retry.
 */
export async function saveDiscoveredProducts(
	sessionId: string,
	batch: SaveBatch[],
): Promise<number> {
	if (batch.length === 0) return 0;
	const sb = getServiceClient();

	const rows = batch.map(({ candidate, broadcastTag, broadcastSources }) => ({
		session_id: sessionId,
		name: candidate.name,
		name_normalized: normalizeName(candidate.name),
		thumbnail_url: candidate.thumbnailUrl ?? null,
		product_url: candidate.productUrl,
		price_jpy: candidate.priceJpy ?? null,
		category: candidate.seedKeyword,
		source: candidate.source,
		rakuten_item_code: candidate.rakutenItemCode ?? null,
		review_count: candidate.reviewCount ?? null,
		review_avg: candidate.reviewAvg ?? null,
		seller_name: candidate.sellerName ?? null,
		stock_status: candidate.stockStatus ?? null,
		tv_fit_score: candidate.tvFitScore,
		tv_fit_reason: candidate.tvFitReason,
		broadcast_tag: broadcastTag,
		broadcast_sources: broadcastSources,
		track: candidate.track,
		is_tv_applicable: candidate.isTvApplicable,
		is_live_applicable: candidate.isLiveApplicable,
	}));

	const { data, error } = await sb
		.from("discovered_products")
		.upsert(rows, { onConflict: "session_id,product_url", ignoreDuplicates: true })
		.select("id");

	if (error) {
		throw new Error(
			`[save] saveDiscoveredProducts failed: ${error.message}`,
		);
	}
	return data?.length ?? 0;
}

/**
 * Finalize session with status, produced_count, iteration count.
 */
export async function finalizeSession(input: {
	sessionId: string;
	status: SessionStatus;
	producedCount: number;
	iterations: number;
	error?: string;
}): Promise<void> {
	const sb = getServiceClient();
	const { error } = await sb
		.from("discovery_runs")
		.update({
			status: input.status,
			produced_count: input.producedCount,
			iterations: input.iterations,
			completed_at: new Date().toISOString(),
			error: input.error ?? null,
		})
		.eq("id", input.sessionId);
	if (error) {
		console.error(
			`[save] finalizeSession failed (${input.sessionId}): ${error.message}`,
		);
	}
}
