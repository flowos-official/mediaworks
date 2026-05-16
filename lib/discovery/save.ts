/**
 * Persistence for discovery pipeline — writes to discovery_runs and
 * discovered_products. All DB writes gated through service role client.
 * Ref: spec §4.2 단계 1, 단계 8.
 */

import { getServiceClient } from "@/lib/supabase";
import { normalizeName } from "./exclusion";
import { fetchRakutenPage } from "./tools/rakuten-page";
import type {
	BroadcastTag,
	Candidate,
	CategoryPlan,
	Context,
	CurationScore,
	SessionStatus,
} from "./types";

const CATEGORY_ENRICH_CONCURRENCY = Math.max(
	1,
	Number(process.env.DISCOVERY_CATEGORY_ENRICH_CONCURRENCY ?? 5),
);

/**
 * Create a new discovery_runs row with status='running'.
 * Returns the inserted row id.
 */
export async function createSession(input: {
	targetCount: number;
	explorationRatio: number;
	context: Context;
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
			context: input.context,
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

export interface DiscoveredProductRow {
	session_id: string;
	name: string;
	name_normalized: string;
	thumbnail_url: string | null;
	product_url: string;
	price_jpy: number | null;
	category: string | null;
	seed_keyword: string;
	source: Candidate["source"];
	rakuten_item_code: string | null;
	review_count: number | null;
	review_avg: number | null;
	seller_name: string | null;
	stock_status: string | null;
	tv_fit_score: number;
	tv_fit_reason: string;
	score_breakdown: CurationScore;
	broadcast_tag: BroadcastTag;
	broadcast_sources: Array<{ title: string; url: string }>;
	track: Candidate["track"];
	is_tv_applicable: boolean;
	is_live_applicable: boolean;
	tv_channel_source: string | null;
	context: Candidate["context"];
}

export function buildDiscoveredProductRows(
	sessionId: string,
	batch: SaveBatch[],
): DiscoveredProductRow[] {
	return batch.map(({ candidate, broadcastTag, broadcastSources }) => ({
		session_id: sessionId,
		name: candidate.name,
		name_normalized: normalizeName(candidate.name),
		thumbnail_url: candidate.thumbnailUrl ?? null,
		product_url: candidate.productUrl,
		price_jpy: candidate.priceJpy ?? null,
		category: candidate.category ?? null,
		seed_keyword: candidate.seedKeyword,
		source: candidate.source,
		rakuten_item_code: candidate.rakutenItemCode ?? null,
		review_count: candidate.reviewCount ?? null,
		review_avg: candidate.reviewAvg ?? null,
		seller_name: candidate.sellerName ?? null,
		stock_status: candidate.stockStatus ?? null,
		tv_fit_score: candidate.tvFitScore,
		tv_fit_reason: candidate.tvFitReason,
		score_breakdown: candidate.scoreBreakdown,
		broadcast_tag: broadcastTag,
		broadcast_sources: broadcastSources,
		track: candidate.track,
		tv_channel_source: candidate.tvChannelSource ?? null,
		is_tv_applicable: candidate.isTvApplicable,
		is_live_applicable: candidate.isLiveApplicable,
		context: candidate.context,
	}));
}

async function enrichMissingCategories(batch: SaveBatch[]): Promise<SaveBatch[]> {
	const next = batch.map((entry) => ({
		...entry,
		candidate: { ...entry.candidate },
	}));
	const targetIndexes = next
		.map((entry, index) =>
			!entry.candidate.category &&
			entry.candidate.source === "rakuten" &&
			entry.candidate.productUrl.includes("rakuten.co.jp")
				? index
				: -1,
		)
		.filter((index) => index >= 0);

	if (targetIndexes.length === 0) {
		return next;
	}

	let cursor = 0;
	const worker = async () => {
		while (cursor < targetIndexes.length) {
			const target = targetIndexes[cursor];
			cursor += 1;
			const entry = next[target];
			const info = await fetchRakutenPage(entry.candidate.productUrl);
			const category =
				info.categoryPath.length > 0 ? info.categoryPath.join(" > ") : null;
			if (category) {
				entry.candidate.category = category;
			}
		}
	};

	await Promise.all(
		Array.from(
			{ length: Math.min(CATEGORY_ENRICH_CONCURRENCY, targetIndexes.length) },
			() => worker(),
		),
	);

	return next;
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
	const enrichedBatch = await enrichMissingCategories(batch);
	const rows = buildDiscoveredProductRows(sessionId, enrichedBatch);

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

export const __test = {
	buildDiscoveredProductRows,
};

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
