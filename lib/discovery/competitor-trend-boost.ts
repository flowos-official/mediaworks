/**
 * Phase 3-C: competitive intelligence boost.
 *
 * "What are other home-shopping channels broadcasting recently?" → if our
 * candidate's name or category overlaps with the hot categories in
 * competitor broadcasts (QVC + ShopCh whitelist, last N days), bump
 * tvFitScore so the candidate surfaces higher in discovery.
 *
 * Soft signal, never an exclusion. Compatible with the existing
 * applyBroadcastBoost / applyRecentBroadcastPenalty pipeline — apply
 * after them.
 *
 * Source for v1: `broadcasts` table (QVC + ShopCh). These are the channels
 * with a curated, normalized category whitelist (Phase 1-C). The 8 OA
 * channels in `historical_broadcasts` will join once their own whitelist
 * is configured (today their category is NULL and the boost ignores them).
 *
 * Fit-weighting layer (2026-05-18): the baseline per-category boost is
 * reshaped by the user's accumulated `competitor_fit_analyses` for that
 * category. A category the user has consistently rated high-fit gets an
 * amplified boost (up to 2.5×); a category rated low-fit gets dampened
 * down to 0 (competitors keep airing it, but we already concluded we
 * shouldn't compete here). Categories with fewer than FIT_MIN_SAMPLES
 * analyses fall through to the unweighted baseline.
 */
import { getServiceClient } from "@/lib/supabase";
import type { Candidate } from "./types";

function envInt(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return defaultValue;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

const HISTORICAL_CATEGORY_BOOST = envInt("HISTORICAL_CATEGORY_BOOST", 5);
const HISTORICAL_LOOKBACK_DAYS = envInt("HISTORICAL_LOOKBACK_DAYS", 30);
const HOT_CATEGORY_TOP_N = envInt("HOT_CATEGORY_TOP_N", 5);
// Minimum competitor_fit_analyses rows in a category before we trust the
// avg fit_score enough to reshape its boost. Below this, the category
// falls through to the unweighted baseline boost.
const FIT_MIN_SAMPLES = envInt("FIT_MIN_SAMPLES", 3);

/**
 * Returns hot competitor categories from the broadcasts table, ranked
 * by row count in the lookback window. Fail-open: any DB error yields
 * an empty array.
 */
export async function loadHotCompetitorCategories(): Promise<
	Array<{ category: string; count: number }>
> {
	const sb = getServiceClient();
	const cutoff = new Date(
		Date.now() - HISTORICAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
	)
		.toISOString()
		.slice(0, 10);

	const { data, error } = await sb
		.from("broadcasts")
		.select("category")
		.gte("air_date", cutoff)
		.not("category", "is", null);

	if (error) {
		console.warn(
			"[competitor-trend-boost] broadcasts lookup failed:",
			error.message,
		);
		return [];
	}

	const freq = new Map<string, number>();
	for (const row of (data ?? []) as { category: string | null }[]) {
		if (!row.category) continue;
		freq.set(row.category, (freq.get(row.category) ?? 0) + 1);
	}
	return [...freq.entries()]
		.map(([category, count]) => ({ category, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, HOT_CATEGORY_TOP_N);
}

/**
 * Aggregates competitor_fit_analyses rows (last HISTORICAL_LOOKBACK_DAYS)
 * by category and returns avg fit_score + sample count for any category
 * with at least FIT_MIN_SAMPLES rows. The boost layer uses this to
 * reshape its per-category bump: high avg fit_score amplifies the boost,
 * low avg fit_score dampens it (down to 0), no analyses leaves it
 * unchanged. Fail-open.
 */
export async function loadCategoryFitWeights(): Promise<
	Map<string, { avg: number; n: number }>
> {
	const sb = getServiceClient();
	const cutoff = new Date(
		Date.now() - HISTORICAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
	).toISOString();

	const { data, error } = await sb
		.from("competitor_fit_analyses")
		.select("category, fit_score")
		.gte("created_at", cutoff)
		.not("category", "is", null);

	if (error) {
		console.warn(
			"[competitor-trend-boost] fit_analyses lookup failed:",
			error.message,
		);
		return new Map();
	}

	const acc = new Map<string, { sum: number; n: number }>();
	for (const row of (data ?? []) as { category: string | null; fit_score: number }[]) {
		if (!row.category || typeof row.fit_score !== "number") continue;
		const cur = acc.get(row.category) ?? { sum: 0, n: 0 };
		cur.sum += row.fit_score;
		cur.n += 1;
		acc.set(row.category, cur);
	}

	const out = new Map<string, { avg: number; n: number }>();
	for (const [cat, { sum, n }] of acc) {
		if (n < FIT_MIN_SAMPLES) continue;
		out.set(cat, { avg: sum / n, n });
	}
	return out;
}

/**
 * Maps avg fit_score (0..100) → boost multiplier in [0, 2.5].
 *   avg ≤ 25  → 0    (cancel the boost; we already judged this category low-fit)
 *   avg 50    → 1    (neutral; baseline boost unchanged)
 *   avg ≥ 87.5 → 2.5 (amplify; we want to surface these even more)
 */
function fitMultiplier(avg: number): number {
	const m = 1 + (avg - 50) / 25;
	if (m < 0) return 0;
	if (m > 2.5) return 2.5;
	return m;
}

/**
 * Split a Japanese composite category into atomic keywords for fuzzy
 * substring matching against free-form candidate text. Filters out
 * keywords shorter than 2 chars to limit false positives.
 *
 * Examples:
 *   "美容・ダイエット・フィットネス" → ["美容","ダイエット","フィットネス"]
 *   "ホーム" → ["ホーム"]
 */
function splitCategoryToKeywords(category: string): string[] {
	return category
		.split(/[・\/／]/)
		.map((s) => s.trim().normalize("NFKC"))
		.filter((s) => s.length >= 2);
}

/**
 * Mutates `candidates` in place: bumps tvFitScore by HISTORICAL_CATEGORY_BOOST
 * for each candidate whose name or category contains any keyword from a hot
 * competitor category. Annotates tvFitReason. Fail-open. Caller is
 * responsible for resorting if needed (this function does that too).
 *
 * Returns the number of candidates that were boosted.
 */
export async function applyCompetitorTrendBoost(
	candidates: Candidate[],
): Promise<number> {
	if (candidates.length === 0) return 0;

	const [hot, fitWeights] = await Promise.all([
		loadHotCompetitorCategories(),
		loadCategoryFitWeights(),
	]);
	if (hot.length === 0) return 0;

	// Pre-compute keyword sets per hot category for the substring scan.
	// Also resolve each hot category's effective boost: baseline scaled by
	// the user's avg fit_score for that category (if enough samples exist).
	const keywordsByCat = new Map<string, string[]>();
	const boostByCat = new Map<string, { amount: number; fit: { avg: number; n: number } | null }>();
	for (const { category } of hot) {
		const kws = splitCategoryToKeywords(category);
		if (kws.length === 0) continue;
		keywordsByCat.set(category, kws);
		const fit = fitWeights.get(category) ?? null;
		const amount = fit
			? Math.round(HISTORICAL_CATEGORY_BOOST * fitMultiplier(fit.avg))
			: HISTORICAL_CATEGORY_BOOST;
		boostByCat.set(category, { amount, fit });
	}
	if (keywordsByCat.size === 0) return 0;

	let boosted = 0;
	for (const c of candidates) {
		const haystack = `${c.name} ${c.category ?? ""}`.normalize("NFKC");
		let matchedCategory: string | null = null;
		for (const [cat, kws] of keywordsByCat) {
			if (kws.some((kw) => haystack.includes(kw))) {
				matchedCategory = cat;
				break;
			}
		}
		if (!matchedCategory) continue;
		const cfg = boostByCat.get(matchedCategory);
		if (!cfg || cfg.amount <= 0) continue;
		const next = Math.min(100, c.tvFitScore + cfg.amount);
		if (next === c.tvFitScore) continue;
		c.tvFitScore = next;
		const fitTag = cfg.fit
			? ` 適合度:${Math.round(cfg.fit.avg)}点(n=${cfg.fit.n})`
			: "";
		c.tvFitReason = `${c.tvFitReason} [他局トレンド: ${matchedCategory}${fitTag}]`.slice(
			0,
			200,
		);
		boosted += 1;
	}

	candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);
	return boosted;
}

export const __test = {
	splitCategoryToKeywords,
	envInt,
	fitMultiplier,
	HISTORICAL_CATEGORY_BOOST,
	HISTORICAL_LOOKBACK_DAYS,
	HOT_CATEGORY_TOP_N,
	FIT_MIN_SAMPLES,
};
