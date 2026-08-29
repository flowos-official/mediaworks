/**
 * Queue seeding and stale-slot recovery.
 *
 * Seeding is deliberately two-step: PostgREST IGNORES `.limit()` on an UPDATE
 * (measured — a limit(2) update touched 13 rows), so a one-step
 * `.update().limit(n)` would flip the entire archive to 'queued' on the first
 * call and blow past the slice this cycle is scoped to.
 *
 * NO `import "server-only"` — imported by the drain script under tsx.
 */
import { getServiceClient } from "@/lib/supabase";
import { CATEGORIES_BY_CHANNEL } from "@/lib/broadcasts/whitelist-gate";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisErrorCode } from "./error-codes";
import {
	chooseBalancedAnalysisSlots,
	normalizeAnalysisCategory,
	type AnalysisCandidate,
} from "./priority";

/** The queue never reads an unbounded archive into memory to fill one batch. */
export const BALANCED_ANALYSIS_CANDIDATE_POOL_LIMIT = 200;
export const ANALYZED_CATEGORY_PAGE_SIZE = 1_000;
export const CURRENT_CATEGORY_ID_CHUNK_SIZE = 200;

export interface EligibleAnalysisScope {
	channel: "qvc" | "shopch";
	categories: string[];
}

type CategoriesByChannel = Record<"qvc" | "shopch", readonly string[]>;

/**
 * Resolve only known, per-channel categories before the candidate query is
 * capped. A malformed/unavailable whitelist is a configuration error; an
 * explicit category absent from the whitelist simply has no eligible scope.
 */
export function buildEligibleAnalysisScopes(
	category: string | undefined,
	only: "qvc" | "shopch" | undefined,
	whitelist: CategoriesByChannel | null | undefined = CATEGORIES_BY_CHANNEL,
): EligibleAnalysisScope[] {
	if (!whitelist || !Array.isArray(whitelist.qvc) || !Array.isArray(whitelist.shopch)) {
		throw new Error("analysis category whitelist unavailable");
	}
	const explicitCategory = category?.trim();
	if (category !== undefined && !explicitCategory) return [];

	const scopes: EligibleAnalysisScope[] = [];
	for (const channel of ["qvc", "shopch"] as const) {
		if (only && channel !== only) continue;
		const categories = whitelist[channel];
		if (categories.length === 0) throw new Error(`analysis category whitelist unavailable for ${channel}`);
		if (explicitCategory === undefined) scopes.push({ channel, categories: [...categories] });
		else if (categories.includes(explicitCategory)) scopes.push({ channel, categories: [explicitCategory] });
	}
	return scopes;
}

export interface SeedOptions {
	limit: number;
	/** Restrict to one broadcast category. Omit for category-balanced seeding. */
	category?: string;
	/** Restrict to one channel. The two channels archive different MEDIA, not
	 *  merely different lengths: QVC stores ~2-minute per-product digest clips
	 *  (median 59 MB, no offer segment at all — measured `firstPriceSec: null`,
	 *  `ctaSecs: []`), while ShopCh stores ~1-hour full programmes (median
	 *  1216 MB, price at 118s and four CTAs through to the close). Aggregating
	 *  them together would average a highlight reel against a sales programme,
	 *  so a corpus should be built one channel at a time. */
	channel?: "qvc" | "shopch";
}

export interface PendingAnalysisCandidate {
	id: string;
	channel: "qvc" | "shopch";
	category: string | null;
	airDate: string;
	productIds: string[] | null;
	programTitle: string | null;
}

export interface CurrentBroadcastCategoryRow {
	id: string;
	category: string | null;
}

export interface AnalysisQueueRepository {
	findPendingCandidates(input: { limit: number; scopes: readonly EligibleAnalysisScope[] }): Promise<PendingAnalysisCandidate[]>;
	findCompletedAnalysisIds(input: { offset: number; limit: number }): Promise<string[]>;
	findCurrentBroadcastCategories(input: { ids: string[] }): Promise<CurrentBroadcastCategoryRow[]>;
	promotePending(ids: string[]): Promise<string[]>;
}

type BroadcastQueueRow = {
	id: string;
	channel: "qvc" | "shopch";
	category: string | null;
	air_date: string;
	product_ids: string[] | null;
	program_title: string | null;
};

function postgrestInValue(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function scopeFilter(scope: EligibleAnalysisScope): string {
	return `and(channel.eq.${scope.channel},category.in.(${scope.categories.map(postgrestInValue).join(",")}))`;
}

export function createAnalysisQueueRepository(supabase: SupabaseClient): AnalysisQueueRepository {
	return {
		async findPendingCandidates(input) {
			if (input.scopes.length === 0) return [];
			let query = supabase
				.from("broadcasts")
				.select("id,channel,category,air_date,product_ids,program_title")
				.eq("analysis_status", "pending")
				.not("archived_video_s3", "is", null);
			if (input.scopes.length === 1) {
				const scope = input.scopes[0]!;
				query = query.eq("channel", scope.channel).in("category", scope.categories);
			} else {
				query = query.or(input.scopes.map(scopeFilter).join(","));
			}

			const { data, error } = await query
				.order("air_date", { ascending: false })
				.order("id", { ascending: true })
				.limit(input.limit);
			if (error) throw new Error(`seed select failed: ${error.message}`);
			return ((data ?? []) as BroadcastQueueRow[]).map((row) => ({
				id: row.id,
				channel: row.channel,
				category: row.category,
				airDate: row.air_date,
				productIds: row.product_ids,
				programTitle: row.program_title,
			}));
		},
		async findCompletedAnalysisIds(input) {
			const { data, error } = await supabase
				.from("broadcast_speech_analyses")
				.select("broadcast_id")
				.order("broadcast_id", { ascending: true })
				.range(input.offset, input.offset + input.limit - 1);
			if (error) throw new Error(`completed analysis select failed: ${error.message}`);
			return ((data ?? []) as Array<{ broadcast_id: string }>).map((row) => row.broadcast_id);
		},
		async findCurrentBroadcastCategories(input) {
			if (input.ids.length === 0) return [];
			const { data, error } = await supabase
				.from("broadcasts")
				.select("id,category")
				.in("id", input.ids);
			if (error) throw new Error(`current broadcast category select failed: ${error.message}`);
			return (data ?? []) as CurrentBroadcastCategoryRow[];
		},
		async promotePending(ids) {
			if (ids.length === 0) return [];
			const { data, error } = await supabase
				.from("broadcasts")
				.update({ analysis_status: "queued" })
				.in("id", ids)
				.eq("analysis_status", "pending")
				.select("id");
			if (error) throw new Error(`seed update failed: ${error.message}`);
			return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
		},
	};
}

/**
 * Count each completed analysis once, then resolve category from its current
 * broadcast row. Analysis rows retain the category observed at processing
 * time, so using that snapshot would keep priority stale after enrichment.
 */
export async function countDistinctAnalyzedCategories(
	repository: AnalysisQueueRepository,
): Promise<Map<string, number>> {
	const seen = new Set<string>();
	const completedIds: string[] = [];
	let offset = 0;
	while (true) {
		const page = await repository.findCompletedAnalysisIds({ offset, limit: ANALYZED_CATEGORY_PAGE_SIZE });
		for (const broadcastId of page) {
			if (seen.has(broadcastId)) continue;
			seen.add(broadcastId);
			completedIds.push(broadcastId);
		}
		if (page.length < ANALYZED_CATEGORY_PAGE_SIZE) break;
		offset += page.length;
	}

	const counts = new Map<string, number>();
	for (let offset = 0; offset < completedIds.length; offset += CURRENT_CATEGORY_ID_CHUNK_SIZE) {
		const ids = completedIds.slice(offset, offset + CURRENT_CATEGORY_ID_CHUNK_SIZE);
		const categories = new Map(
			(await repository.findCurrentBroadcastCategories({ ids })).map((row) => [row.id, row.category]),
		);
		for (const id of ids) {
			const category = normalizeAnalysisCategory(categories.get(id));
			counts.set(category, (counts.get(category) ?? 0) + 1);
		}
	}
	return counts;
}

/**
 * A stored repetition signal: first the channel plus the sorted unique
 * product_ids set, then the channel plus a whitespace-normalized program
 * title, and finally the broadcast ID when neither signal exists. Counts are
 * intentionally computed only from the already-bounded candidate pool.
 */
function repeatIdentity(row: PendingAnalysisCandidate): string {
	const productIds = [...new Set((row.productIds ?? [])
		.map((id) => id.trim())
		.filter(Boolean))].sort();
	if (productIds.length > 0) return JSON.stringify(["product_ids", row.channel, productIds]);

	const title = row.programTitle?.trim().replace(/\s+/g, " ");
	if (title) return JSON.stringify(["program_title", row.channel, title]);
	return JSON.stringify(["broadcast_id", row.id]);
}

function candidatesWithRepeatCounts(rows: readonly PendingAnalysisCandidate[]): AnalysisCandidate[] {
	const frequencies = new Map<string, number>();
	for (const row of rows) {
		const key = repeatIdentity(row);
		frequencies.set(key, (frequencies.get(key) ?? 0) + 1);
	}
	return rows.map((row) => ({
		id: row.id,
		category: row.category,
		airDate: row.airDate,
		repeatCount: frequencies.get(repeatIdentity(row)) ?? 1,
	}));
}

export async function seedAnalysisQueue(
	{ limit, category, channel }: SeedOptions,
	repository: AnalysisQueueRepository = createAnalysisQueueRepository(getServiceClient()),
): Promise<number> {
	if (!Number.isFinite(limit) || limit <= 0) return 0;
	const requested = Math.floor(limit);
	const candidateLimit = category === undefined
		? BALANCED_ANALYSIS_CANDIDATE_POOL_LIMIT
		: requested;
	const scopes = buildEligibleAnalysisScopes(category, channel);
	if (scopes.length === 0) return 0;
	const candidates = await repository.findPendingCandidates({
		limit: candidateLimit,
		scopes,
	});
	if (candidates.length === 0) return 0;

	const selected = category === undefined
		? chooseBalancedAnalysisSlots(
			candidatesWithRepeatCounts(candidates),
			await countDistinctAnalyzedCategories(repository),
			requested,
		)
		: candidates.slice(0, requested);
	const ids = [...new Set(selected.map((row) => row.id))];
	return (await repository.promotePending(ids)).length;
}

/**
 * Make previously-abandoned slots eligible again.
 *
 * `skipped` and `failed` are both terminal — the queue selects only 'queued'
 * and seeding promotes only 'pending', so nothing retries them on its own.
 * That is correct for a permanent verdict (`no_archived_video`), and wrong for
 * one that a later action invalidates:
 *
 *   cold_storage  → the operator restored the objects (see restore:archives)
 *   empty_object  → the slot was re-archived
 *   gemini_error  → a quota or key problem was fixed
 *
 * Scoped by error code so a reset can never sweep in slots abandoned for a
 * different, still-valid reason. Clears `analysis_attempts` too: the attempts
 * were spent on a precondition that no longer holds, and leaving them at the
 * cap would make the reset a no-op.
 */
export async function resetAnalysisError(
	code: AnalysisErrorCode,
	scope: { category?: string; channel?: "qvc" | "shopch" } = {},
): Promise<number> {
	const sb = getServiceClient();
	let q = sb
		.from("broadcasts")
		.select("id")
		.eq("analysis_error", code)
		.in("analysis_status", ["skipped", "failed"]);
	if (scope.category) q = q.eq("category", scope.category);
	if (scope.channel) q = q.eq("channel", scope.channel);
	const { data: ids, error: selErr } = await q;
	if (selErr) throw new Error(`reset select failed: ${selErr.message}`);
	if (!ids || ids.length === 0) return 0;

	// Two-step for the same reason seeding is: PostgREST ignores .limit() on
	// UPDATE, so the filter set must be pinned to explicit ids.
	const { data, error: updErr } = await sb
		.from("broadcasts")
		.update({ analysis_status: "pending", analysis_error: null, analysis_attempts: 0 })
		.in("id", ids.map((r) => r.id))
		.in("analysis_status", ["skipped", "failed"])
		.select("id");
	if (updErr) throw new Error(`reset update failed: ${updErr.message}`);
	return data?.length ?? 0;
}

/** Requeue slots orphaned in 'running' by a function timeout, deploy or Ctrl-C.
 *  Without this they never retry: the queue selects only 'queued', and every
 *  UPDATE in analyzeOne is guarded on status='running'.
 *  Mirrors lib/broadcasts/stale-downloading-recovery.ts. */
export async function recoverStaleAnalysis(staleMinutes = 30): Promise<number> {
	const sb = getServiceClient();
	const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();

	const { data: stale, error: selErr } = await sb
		.from("broadcasts")
		.select("id, analysis_attempts")
		.eq("analysis_status", "running")
		.lt("updated_at", cutoff)
		.limit(100);
	if (selErr) throw new Error(`stale select failed: ${selErr.message}`);
	if (!stale || stale.length === 0) return 0;

	let recovered = 0;
	for (const row of stale) {
		const attempts = (row.analysis_attempts ?? 0) + 1;
		const { data } = await sb
			.from("broadcasts")
			.update({
				analysis_status: attempts >= Number(process.env.BROADCAST_INTEL_MAX_ATTEMPTS ?? 3) ? "failed" : "queued",
				analysis_attempts: attempts,
				analysis_error: "stale_recovered" satisfies AnalysisErrorCode,
			})
			.eq("id", row.id)
			.eq("analysis_status", "running")
			.select("id");
		recovered += data?.length ?? 0;
	}
	return recovered;
}
