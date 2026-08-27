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
import type { AnalysisErrorCode } from "./error-codes";

export interface SeedOptions {
	limit: number;
	/** Restrict to one broadcast category. Omit only when you intend to seed
	 *  every whitelist category on both channels. */
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

export async function seedAnalysisQueue({ limit, category, channel: only }: SeedOptions): Promise<number> {
	const sb = getServiceClient();
	let promoted = 0;

	for (const channel of ["qvc", "shopch"] as const) {
		if (only && channel !== only) continue;
		const remaining = limit - promoted;
		if (remaining <= 0) break;

		const whitelist = [...CATEGORIES_BY_CHANNEL[channel]] as string[];
		// A null category cannot be attributed to an aggregate, so those rows
		// stay 'pending' and become eligible once enrichment fills one in.
		const categories = category ? whitelist.filter((c) => c === category) : whitelist;
		if (categories.length === 0) continue;

		const { data: ids, error: selErr } = await sb
			.from("broadcasts")
			.select("id")
			.eq("analysis_status", "pending")
			.eq("channel", channel)
			.not("archived_video_s3", "is", null)
			.in("category", categories)
			.order("air_date", { ascending: false })
			.limit(remaining);
		if (selErr) throw new Error(`seed select failed for ${channel}: ${selErr.message}`);
		if (!ids || ids.length === 0) continue;

		const { data, error: updErr } = await sb
			.from("broadcasts")
			.update({ analysis_status: "queued" })
			.in("id", ids.map((r) => r.id))
			.eq("analysis_status", "pending")
			.select("id");
		if (updErr) throw new Error(`seed update failed for ${channel}: ${updErr.message}`);
		promoted += data?.length ?? 0;
	}
	return promoted;
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
