/**
 * TV Evidence Mining — deterministic per-candidate broadcast history.
 * Spec: docs/superpowers/specs/2026-05-17-tv-evidence-mining-design.md
 */

/**
 * Split a Japanese composite category into atomic keywords (≥2 chars).
 * Mirrors the pattern in lib/discovery/competitor-trend-boost.ts so the
 * two modules behave identically on shared inputs.
 */
export function splitCategoryToKeywords(category: string): string[] {
	if (!category) return [];
	return category
		.split(/[・\/／,、]/)
		.map((s) => s.trim().normalize("NFKC"))
		.filter((s) => s.length >= 2);
}

/**
 * Tokenize a product name into substrings suitable for ILIKE matching:
 * - Split on whitespace and a small set of punctuation
 * - Drop tokens shorter than 3 characters (catches noise like "x", "ml")
 *   — Japanese tokens of length 2 are kept as a special case via the
 *   length-3 filter only when string is ASCII; full-width chars count
 *   as 1 codepoint each, so 3-char Japanese tokens still survive.
 *   For simplicity, all tokens use the same ≥3 codepoint rule. Short
 *   Japanese names like "セラム" (3 chars) qualify; "30ml" (4) qualifies;
 *   "a" or "b" (1 char) does not.
 * - Keep at most 3 tokens to bound query cost.
 */
export function tokenizeName(name: string): string[] {
	if (!name) return [];
	return name
		.normalize("NFKC")
		.split(/[\s・\/／,、|\-]+/)
		.map((s) => s.trim())
		.filter((s) => s.length >= 3)
		.slice(0, 3);
}

/**
 * Compute the q-th percentile of a numeric array using linear interpolation
 * between closest ranks. Returns 0 for empty input.
 *
 * Note: This is a simple definition; we don't need exact statistical
 * accuracy — the values feed a Gemini prompt where one yen of precision
 * is irrelevant.
 */
export function percentile(values: number[], q: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = (sorted.length - 1) * q;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

import type { TvEvidence, TvEvidenceMatchBasis, TvEvidenceTimeslot } from "./types";

const DOW: Array<TvEvidenceTimeslot["dow"]> = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface BroadcastRow {
	source: "broadcasts" | "historical" | "qvc_products";
	channel: string;
	air_date: string; // YYYY-MM-DD
	start_time: string | null; // HH:MM:SS, null for historical
	title: string;
	price_jpy: number | null;
}

function daysBetween(a: string, b: string): number {
	return Math.floor(
		(Date.parse(b) - Date.parse(a)) / 86_400_000,
	);
}

function bucketTimeslot(row: BroadcastRow): TvEvidenceTimeslot | null {
	if (!row.start_time) return null;
	if (row.channel !== "qvc" && row.channel !== "shopch") return null;
	const hour = parseInt(row.start_time.slice(0, 2), 10);
	if (!Number.isFinite(hour)) return null;
	const dow = DOW[new Date(row.air_date + "T00:00:00Z").getUTCDay()];
	return {
		channel: row.channel as "qvc" | "shopch",
		dow,
		hour_bucket: hour,
		count: 1,
	};
}

export function aggregateBroadcastRows(
	rows: BroadcastRow[],
	basis: TvEvidenceMatchBasis,
): TvEvidence {
	const now = new Date().toISOString().slice(0, 10);

	let recent30 = 0;
	let recent90 = 0;
	const channelCounts: Record<string, number> = {};
	const prices: number[] = [];
	const timeslotMap = new Map<string, TvEvidenceTimeslot>();

	for (const r of rows) {
		const age = daysBetween(r.air_date, now);
		if (age <= 30) recent30 += 1;
		if (age <= 90) recent90 += 1;
		channelCounts[r.channel] = (channelCounts[r.channel] ?? 0) + 1;
		if (r.price_jpy !== null && r.price_jpy > 0) prices.push(r.price_jpy);
		const slot = bucketTimeslot(r);
		if (slot) {
			const key = `${slot.channel}-${slot.dow}-${slot.hour_bucket}`;
			const prev = timeslotMap.get(key);
			if (prev) prev.count += 1;
			else timeslotMap.set(key, slot);
		}
	}

	const samples = [...rows]
		.sort((a, b) => (a.air_date < b.air_date ? 1 : -1))
		.slice(0, 5)
		.map((r) => ({
			channel: r.channel,
			air_date: r.air_date,
			title: r.title.slice(0, 200),
			price_jpy: r.price_jpy,
		}));

	const top_timeslots = [...timeslotMap.values()]
		.sort((a, b) => b.count - a.count)
		.slice(0, 5);

	const price_jpy = prices.length > 0
		? {
				median: Math.round(percentile(prices, 0.5)),
				p25: Math.round(percentile(prices, 0.25)),
				p75: Math.round(percentile(prices, 0.75)),
				count: prices.length,
			}
		: null;

	const distinct_channels = Object.keys(channelCounts).length;
	const price_completeness = basis.price_band === null ? 0.5 : 1.0;

	const base = Math.min(1, Math.log10(1 + rows.length) / 2.5);
	const recency = Math.min(1, recent30 / 10);
	const diversity = Math.min(1, distinct_channels / 4);
	const evidence_strength = Math.round(
		(0.5 * base + 0.3 * recency + 0.2 * diversity) * price_completeness * 100,
	) / 100;

	return {
		matched_at: new Date().toISOString(),
		match_basis: basis,
		airing_count: rows.length,
		recent_30d_count: recent30,
		recent_90d_count: recent90,
		channel_breakdown: channelCounts,
		price_jpy,
		top_timeslots,
		samples,
		evidence_strength,
	};
}

export const __test = {
	splitCategoryToKeywords,
	tokenizeName,
	percentile,
	aggregateBroadcastRows,
};
