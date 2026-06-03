/**
 * Persistence for discovery pipeline — writes to discovery_runs and
 * discovered_products. All DB writes gated through service role client.
 * Ref: spec §4.2 단계 1, 단계 8.
 */

import { getServiceClient } from "@/lib/supabase";
import { normalizeName } from "./exclusion";
import { hasExcludedChannel, EXCLUDED_DISCOVERY_SLUGS } from "./tv-channels";
import { fetchRakutenPage } from "./tools/rakuten-page";
import { fetchAndParseMetadata } from "./tv-channel-enrich";
import { classifyProductCategories } from "./tv-channel-category-classify";
import type {
	BroadcastTag,
	Candidate,
	CategoryPlan,
	Context,
	CurationScore,
	PoolItem,
	SessionStatus,
} from "./types";

const CATEGORY_ENRICH_CONCURRENCY = Math.max(
	1,
	Number(process.env.DISCOVERY_CATEGORY_ENRICH_CONCURRENCY ?? 5),
);
const CATEGORY_ENRICH_MIN_BUDGET_MS = Math.max(
	1_000,
	Number(process.env.DISCOVERY_CATEGORY_ENRICH_MIN_BUDGET_MS ?? 10_000),
);
const STALE_RUNNING_SESSION_MS = Math.max(
	60_000,
	Number(process.env.DISCOVERY_STALE_RUNNING_SESSION_MS ?? 10 * 60 * 1000),
);

export interface CategoryEnrichmentBudget {
	nowMs?: number;
	deadlineMs?: number;
	minBudgetMs?: number;
}

export interface SaveDiscoveredProductsOptions {
	/**
	 * Optional wall-clock deadline for best-effort category enrichment. When the
	 * deadline is near, enrichment is skipped so core rows can be saved and the
	 * session can be finalized before the hosting function times out.
	 */
	categoryEnrichmentDeadlineMs?: number;
	minCategoryEnrichmentBudgetMs?: number;
}

export interface ReconcileStaleDiscoveryRunsInput {
	context?: Context;
	staleAfterMs?: number;
	now?: Date;
}

export interface ReconcileStaleDiscoveryRunsResult {
	checked: number;
	reconciled: number;
	completed: number;
	partial: number;
	failed: number;
}

function hasCategoryEnrichmentBudget(input: CategoryEnrichmentBudget): boolean {
	if (!input.deadlineMs) return true;
	const nowMs = input.nowMs ?? Date.now();
	const minBudgetMs = input.minBudgetMs ?? CATEGORY_ENRICH_MIN_BUDGET_MS;
	return nowMs + minBudgetMs <= input.deadlineMs;
}

function reconciledStatusForProductCount(
	productCount: number,
	targetCount: number,
): Exclude<SessionStatus, "running"> {
	if (productCount <= 0) return "failed";
	return productCount < targetCount ? "partial" : "completed";
}

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
	tvEvidence: import("./types").TvEvidence | null;
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
	tv_evidence: import("./types").TvEvidence | null;
	tv_evidence_at: string | null;
	rakuten_cross_match: PoolItem["rakutenCrossMatch"] | null;
}

export function buildDiscoveredProductRows(
	sessionId: string,
	batch: SaveBatch[],
): DiscoveredProductRow[] {
	const kept = batch.filter(
		({ candidate }) => !hasExcludedChannel(candidate.tvChannelSource ?? null),
	);
	const dropped = batch.length - kept.length;
	if (dropped > 0) {
		console.log(
			`[save] dropped ${dropped} excluded-channel candidate(s) (${[...EXCLUDED_DISCOVERY_SLUGS].join(",")})`,
		);
	}
	return kept.map(({ candidate, broadcastTag, broadcastSources, tvEvidence }) => ({
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
		tv_evidence: tvEvidence,
		tv_evidence_at: tvEvidence ? new Date().toISOString() : null,
		rakuten_cross_match: candidate.rakutenCrossMatch ?? null,
	}));
}

async function enrichMissingCategories(
	batch: SaveBatch[],
	options: SaveDiscoveredProductsOptions = {},
): Promise<SaveBatch[]> {
	const next = batch.map((entry) => ({
		...entry,
		candidate: { ...entry.candidate },
	}));
	// Rakuten rows missing a category → fetchRakutenPage (existing behavior).
	const rakutenTargets = next
		.map((entry, index) =>
			!entry.candidate.category &&
			entry.candidate.source === "rakuten" &&
			entry.candidate.productUrl.includes("rakuten.co.jp")
				? index
				: -1,
		)
		.filter((index) => index >= 0);
	// tv_channel (Brave-sourced) rows are created from a search-result title only —
	// no price/category/thumbnail. Fetch the product page to recover them AND
	// validate product-page-ness so listing/landing pages get dropped at ingest.
	const tvTargets = next
		.map((entry, index) =>
			entry.candidate.source === "tv_channel" &&
			!entry.candidate.productUrl.includes("rakuten.co.jp") &&
			(!entry.candidate.category || entry.candidate.priceJpy == null)
				? index
				: -1,
		)
		.filter((index) => index >= 0);

	if (rakutenTargets.length === 0 && tvTargets.length === 0) {
		return next;
	}

	// Rakuten first (cheap, category-only) so a tight budget preserves existing
	// behavior before spending it on the heavier tv_channel page fetches.
	const targets: Array<{ index: number; kind: "rakuten" | "tv_channel" }> = [
		...rakutenTargets.map((index) => ({ index, kind: "rakuten" as const })),
		...tvTargets.map((index) => ({ index, kind: "tv_channel" as const })),
	];

	let cursor = 0;
	const worker = async () => {
		while (cursor < targets.length) {
			if (
				!hasCategoryEnrichmentBudget({
					deadlineMs: options.categoryEnrichmentDeadlineMs,
					minBudgetMs:
						options.minCategoryEnrichmentBudgetMs ??
						CATEGORY_ENRICH_MIN_BUDGET_MS,
				})
			) {
				break;
			}
			const { index, kind } = targets[cursor];
			cursor += 1;
			const entry = next[index];
			if (kind === "rakuten") {
				const info = await fetchRakutenPage(entry.candidate.productUrl);
				const category =
					info.categoryPath.length > 0 ? info.categoryPath.join(" > ") : null;
				if (category) {
					entry.candidate.category = category;
				}
			} else {
				const meta = await fetchAndParseMetadata(entry.candidate.productUrl);
				// Enrich ONLY when the page validates as a product (JSON-LD Product /
				// og:type=product / a real price extracted). Non-product or unscrapeable
				// pages (SPA/JS-rendered channels, listing/landing) are LEFT as-is (null),
				// NOT dropped: a static fetch cannot distinguish a SPA product page from a
				// listing page, so dropping would false-remove real products. The
				// conservative isNonProductPage prefilter at pool.ts ingest handles the
				// clear listing pages. Raw scraped category (channel vocabulary) is a
				// display/price win now; normalizing it into the sales taxonomy the pool
				// filter matches is a follow-up slice (see 2026-05-30 enrichment spec).
				if (meta && meta.is_product_page) {
					if (entry.candidate.priceJpy == null && meta.price_jpy != null) {
						entry.candidate.priceJpy = meta.price_jpy;
					}
					if (!entry.candidate.thumbnailUrl && meta.thumbnail_url) {
						entry.candidate.thumbnailUrl = meta.thumbnail_url;
					}
					// Category is intentionally NOT taken from JSON-LD: channels emit
					// channel-vocabulary values (e.g. "アイメイク") that the pool filter's
					// UI-label vocabulary cannot substring-match. The classifier below
					// assigns a filter-matchable UI label uniformly instead.
				}
			}
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(CATEGORY_ENRICH_CONCURRENCY, targets.length) }, () =>
			worker(),
		),
	);

	// Category classifier fallback: tv_channel rows still without a category after
	// the page fetch (most channels expose no JSON-LD Product.category). One
	// batched Gemini call → operator UI category labels, which the pool filter's
	// buildCategoryMatchTerms matches directly (no channel-whitelist bridge needed).
	const classifyTargets = next
		.map((entry, index) =>
			entry.candidate.source === "tv_channel" &&
			!entry.candidate.category &&
			!!entry.candidate.name
				? index
				: -1,
		)
		.filter((index) => index >= 0);
	if (
		classifyTargets.length > 0 &&
		hasCategoryEnrichmentBudget({
			deadlineMs: options.categoryEnrichmentDeadlineMs,
			minBudgetMs:
				options.minCategoryEnrichmentBudgetMs ?? CATEGORY_ENRICH_MIN_BUDGET_MS,
		})
	) {
		const labels = await classifyProductCategories(
			classifyTargets.map((index) => ({ name: next[index].candidate.name })),
		);
		classifyTargets.forEach((index, k) => {
			const label = labels[k];
			if (label) next[index].candidate.category = label;
		});
	}

	return next;
}

/**
 * Bulk insert discovered_products for a session.
 * Skips rows that violate unique (session_id, product_url) — idempotent on retry.
 */
export async function saveDiscoveredProducts(
	sessionId: string,
	batch: SaveBatch[],
	options: SaveDiscoveredProductsOptions = {},
): Promise<number> {
	if (batch.length === 0) return 0;
	const sb = getServiceClient();
	const enrichedBatch = await enrichMissingCategories(batch, options);
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
	hasCategoryEnrichmentBudget,
	reconciledStatusForProductCount,
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

/**
 * Recover sessions that were left as running after the hosting function timed
 * out. Product rows are the source of truth: if rows exist, the session can be
 * safely surfaced as completed/partial; otherwise it is marked failed so the UI
 * does not wait on a run that can no longer finish.
 */
export async function reconcileStaleDiscoveryRuns(
	input: ReconcileStaleDiscoveryRunsInput = {},
): Promise<ReconcileStaleDiscoveryRunsResult> {
	const sb = getServiceClient();
	const now = input.now ?? new Date();
	const staleAfterMs = input.staleAfterMs ?? STALE_RUNNING_SESSION_MS;
	const cutoff = new Date(now.getTime() - staleAfterMs).toISOString();

	let query = sb
		.from("discovery_runs")
		.select("id, target_count, context")
		.eq("status", "running")
		.lt("run_at", cutoff);

	if (input.context) {
		query = query.eq("context", input.context);
	}

	const { data: sessions, error } = await query;
	if (error) {
		throw new Error(
			`[save] reconcileStaleDiscoveryRuns query failed: ${error.message}`,
		);
	}

	const result: ReconcileStaleDiscoveryRunsResult = {
		checked: sessions?.length ?? 0,
		reconciled: 0,
		completed: 0,
		partial: 0,
		failed: 0,
	};

	for (const session of sessions ?? []) {
		const { count, error: countErr } = await sb
			.from("discovered_products")
			.select("id", { count: "exact", head: true })
			.eq("session_id", session.id);
		if (countErr) {
			throw new Error(
				`[save] reconcileStaleDiscoveryRuns count failed (${session.id}): ${countErr.message}`,
			);
		}

		const productCount = count ?? 0;
		const status = reconciledStatusForProductCount(
			productCount,
			session.target_count,
		);
		const { error: updateErr } = await sb
			.from("discovery_runs")
			.update({
				status,
				produced_count: productCount,
				completed_at: now.toISOString(),
				error:
					status === "failed"
						? "Reconciled stale running session: function stopped before saving products."
						: null,
			})
			.eq("id", session.id)
			.eq("status", "running");
		if (updateErr) {
			throw new Error(
				`[save] reconcileStaleDiscoveryRuns update failed (${session.id}): ${updateErr.message}`,
			);
		}

		result.reconciled += 1;
		result[status] += 1;
	}

	return result;
}
