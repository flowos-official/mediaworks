/**
 * Soft penalty for products that aired on QVC within the recent window.
 *
 * Rationale (2026-05-16 feedback): when MediaWorks has just aired a product
 * on QVC, the same product should not dominate a new discovery session.
 * This is a SOFT penalty applied post-curation — never a hard exclusion.
 *
 * Scope of v1 (intentionally simple):
 *   - Only QVC broadcasts are matched (broadcasts.product_ids is populated
 *     only for QVC — see CLAUDE.md Phase B PoC). Shop Channel + the other
 *     10 TV channels have no product_id linkage so they are silently
 *     unaffected.
 *   - Penalty applies if a candidate's QVC product id appears in any
 *     broadcasts row within BROADCAST_RECENT_LOOKBACK_DAYS (default 30).
 *   - No seasonal matching (same-month repeats still get penalized). The
 *     user opted to start simple; seasonal-aware logic is a future
 *     extension — see memory feedback-discovery-prior-sales-soft.
 */
import { getServiceClient } from "@/lib/supabase";
import type { Candidate } from "./types";

const BROADCAST_RECENT_PENALTY = Number(
	process.env.BROADCAST_RECENT_PENALTY ?? 10,
);
const BROADCAST_RECENT_LOOKBACK_DAYS = Number(
	process.env.BROADCAST_RECENT_LOOKBACK_DAYS ?? 30,
);

const QVC_PRODUCT_URL_RE = /qvc\.jp\/product\.([0-9]+)\.html/i;

/**
 * Extract the QVC numeric product id from a product url, or null when the
 * url is not a qvc.jp product page.
 */
export function extractQvcProductId(url: string | null | undefined): string | null {
	if (!url) return null;
	const m = url.match(QVC_PRODUCT_URL_RE);
	return m ? m[1] : null;
}

/**
 * Mutates `candidates` in place: subtracts BROADCAST_RECENT_PENALTY from
 * tvFitScore for any candidate whose QVC product id appears in QVC
 * broadcasts within the last BROADCAST_RECENT_LOOKBACK_DAYS days.
 *
 * Returns the number of candidates that were penalized. Fail-open: any DB
 * error is logged and treated as zero matches.
 */
export async function applyRecentBroadcastPenalty(
	candidates: Candidate[],
): Promise<number> {
	if (candidates.length === 0) return 0;

	// Cheap early-out: only QVC product urls can match. If none, skip the DB call.
	const qvcCandidates = candidates
		.map((c) => ({ candidate: c, qvcId: extractQvcProductId(c.productUrl) }))
		.filter((row): row is { candidate: Candidate; qvcId: string } => row.qvcId !== null);
	if (qvcCandidates.length === 0) return 0;

	const cutoffMs = Date.now() - BROADCAST_RECENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
	const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);

	const sb = getServiceClient();
	const { data, error } = await sb
		.from("broadcasts")
		.select("product_ids")
		.eq("channel", "qvc")
		.gte("air_date", cutoffDate)
		.not("product_ids", "is", null);

	if (error) {
		console.warn(
			"[recent-broadcast-penalty] query failed, skipping:",
			error.message,
		);
		return 0;
	}

	const recentIds = new Set<string>();
	for (const row of data ?? []) {
		for (const pid of (row as { product_ids: string[] | null }).product_ids ?? []) {
			recentIds.add(pid);
		}
	}
	if (recentIds.size === 0) return 0;

	let penalized = 0;
	for (const { candidate, qvcId } of qvcCandidates) {
		if (!recentIds.has(qvcId)) continue;
		const next = Math.max(0, candidate.tvFitScore - BROADCAST_RECENT_PENALTY);
		if (next === candidate.tvFitScore) continue;
		candidate.tvFitScore = next;
		candidate.tvFitReason =
			`${candidate.tvFitReason} [QVC直近${BROADCAST_RECENT_LOOKBACK_DAYS}日放送あり]`.slice(0, 200);
		penalized += 1;
	}

	candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);
	return penalized;
}

export const __test = {
	extractQvcProductId,
	BROADCAST_RECENT_PENALTY,
	BROADCAST_RECENT_LOOKBACK_DAYS,
};
