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

	const hot = await loadHotCompetitorCategories();
	if (hot.length === 0) return 0;

	// Pre-compute keyword sets per hot category for the substring scan.
	const keywordsByCat = new Map<string, string[]>();
	for (const { category } of hot) {
		const kws = splitCategoryToKeywords(category);
		if (kws.length > 0) keywordsByCat.set(category, kws);
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
		const next = Math.min(100, c.tvFitScore + HISTORICAL_CATEGORY_BOOST);
		if (next === c.tvFitScore) continue;
		c.tvFitScore = next;
		c.tvFitReason = `${c.tvFitReason} [他局トレンド: ${matchedCategory}]`.slice(
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
	HISTORICAL_CATEGORY_BOOST,
	HISTORICAL_LOOKBACK_DAYS,
	HOT_CATEGORY_TOP_N,
};
