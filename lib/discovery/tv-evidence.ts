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
 * Tokens that mean "this came from channel X's store" rather than identifying
 * a product. Stripped before tokenization so a name like "リスタートアイ |
 * ＴＢＳショッピング" doesn't generate a "TBSショッピング" token that matches
 * every TBS broadcast title.
 */
const TOKENIZE_NOISE_TOKENS = [
	"TBSショッピング",
	"ＴＢＳショッピング",
	"日テレポシュレ",
	"日本テレビの通販ショッピングサイト",
	"カンテレSHOPPING",
	"テレビ通販サイトのカンテレSHOPPING",
	"ジャパネット公式",
	"ジャパネット",
	"japanet",
	"テレ朝じゅん散歩",
	"テレ東マート",
	"ロッピング",
	"フジDinos",
	"ABCせのぶら本舗",
	"ABCウラのウラまで",
	"らくらく茂",
	"いちばん本舗",
	"カチモ",
	"kachimo",
	"買いドキ",
	"通販【ジャパネット公式】",
	"通販",
	"公式",
	"オンラインストア",
	"特典付き",
	"送料無料",
	"特別価格",
];

/**
 * Tokenize a product name into substrings suitable for ILIKE matching:
 * - Strip channel-store noise phrases first (TBSショッピング, 日テレポシュレ etc.)
 *   so they don't generate "branding-only" tokens that match every row from
 *   the same channel.
 * - Split on whitespace and a small set of punctuation
 * - Drop tokens shorter than 3 characters (catches noise like "x", "ml")
 *   — Japanese tokens of length 2 are kept as a special case via the
 *   length-3 filter only when string is ASCII; full-width chars count
 *   as 1 codepoint each, so 3-char Japanese tokens still survive.
 *   For simplicity, all tokens use the same ≥3 codepoint rule.
 * - Keep at most 3 tokens to bound query cost.
 */
export function tokenizeName(name: string): string[] {
	if (!name) return [];
	let cleaned = name.normalize("NFKC");
	for (const noise of TOKENIZE_NOISE_TOKENS) {
		cleaned = cleaned.replace(new RegExp(noise, "gi"), " ");
	}
	return cleaned
		.split(/[\s・\/／,、|\-【】\[\]＜＞]+/)
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
import { normalizeCategory } from "./category-normalize";
import { getRuntimeMarketCountry } from "@/lib/market/runtime-market";

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

import type { Candidate } from "./types";

const EVIDENCE_BONUS_MAX = 15;

export function applyEvidenceBonus(
	candidates: Candidate[],
	evidenceByUrl: Map<string, TvEvidence | null>,
): number {
	let count = 0;
	for (const c of candidates) {
		const ev = evidenceByUrl.get(c.productUrl);
		if (!ev) continue;
		const bonus = Math.round(ev.evidence_strength * EVIDENCE_BONUS_MAX);
		if (bonus === 0) continue;
		const next = Math.min(100, c.tvFitScore + bonus);
		if (next === c.tvFitScore) continue;
		c.tvFitScore = next;
		c.tvFitReason = `${c.tvFitReason} [実測放送${ev.airing_count}回]`.slice(0, 200);
		count += 1;
	}
	candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);
	return count;
}

import type { SupabaseClient } from "@supabase/supabase-js";

export interface CandidateInput {
	name: string;
	category: string | null;
	price_jpy: number | null;
	/**
	 * Optional channel slugs (from tvChannel / tvChannelMatches). When
	 * provided we can look up the candidate's broadcast history in
	 * historical_broadcasts even WITHOUT a category — channel + product-name
	 * tokens are sufficient corroboration. This is the path that lets TV-
	 * channel candidates from Brave site:search (no category attached) gain
	 * a real popularity signal from the calendar cron's historical_broadcasts
	 * table (which already ingests ntv, tbs, dinos, japanet, senobura,
	 * junsanpo, uranoura, txd daily — 8 of the 14 non-broadcast channels).
	 */
	tv_channels?: string[];
}

const PRICE_BAND_RATIO = 0.25;
const HISTORICAL_LOOKBACK_DAYS = 365 * 2; // 2 years; older rows rarely useful

function priceBandFor(price: number | null): [number, number] | null {
	if (price === null || price <= 0) return null;
	return [
		Math.round(price * (1 - PRICE_BAND_RATIO)),
		Math.round(price * (1 + PRICE_BAND_RATIO)),
	];
}

function cutoffIso(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export async function fetchMatchingBroadcastRows(
	sb: SupabaseClient,
	candidate: CandidateInput,
	whitelistCategories?: string[],
): Promise<BroadcastRow[]> {
	const resolved = whitelistCategories ?? (await normalizeCategory(sb, candidate.category));
	const priceBand = priceBandFor(candidate.price_jpy);
	const nameTokens = tokenizeName(candidate.name);
	const cutoff = cutoffIso(HISTORICAL_LOOKBACK_DAYS);

	// Two paths to find evidence:
	//  (a) Category-keyed (original): whitelistCategories.length > 0
	//      Used when the candidate has a resolved category (e.g. enriched
	//      Rakuten items, items from discovered_products with a tagged
	//      category).
	//  (b) Channel-keyed (new): tv_channels.length > 0 AND name tokens ≥ 1
	//      Used when category is absent but we know the source channel
	//      (Brave site:search TV-channel candidates). The channel + name
	//      tokens give us safe corroboration: "this product name appears in
	//      that specific channel's broadcast history within lookback".
	const useCategoryPath = resolved.length > 0;
	const useChannelPath =
		!useCategoryPath &&
		(candidate.tv_channels?.length ?? 0) > 0 &&
		nameTokens.length > 0;
	if (!useCategoryPath && !useChannelPath) return [];

	// 1. broadcasts (shopch + qvc).
	let bRes: { data: unknown[] | null; error: { message: string } | null } = {
		data: [],
		error: null,
	};
	// Skip the broadcasts query entirely on the channel-keyed path if no
	// shopch/qvc channels are involved. The `broadcasts.channel` column is
	// a Postgres ENUM that rejects sentinel values like "__none__".
	const broadcastChannelsToQuery = useCategoryPath
		? null // use category filter, query all channels
		: (candidate.tv_channels ?? []).filter(
			(c) => c === "shopch" || c === "qvc",
		);
	if (useCategoryPath || (broadcastChannelsToQuery && broadcastChannelsToQuery.length > 0)) {
		let bQuery = sb
			.from("broadcasts")
			.select("channel, air_date, start_time, program_title, category, product_ids")
			.eq("country", getRuntimeMarketCountry())
			.gte("air_date", cutoff);
		if (useCategoryPath) {
			bQuery = bQuery.in("category", resolved);
		} else if (broadcastChannelsToQuery) {
			bQuery = bQuery.in("channel", broadcastChannelsToQuery);
		}
		bRes = await bQuery;
		if (bRes.error) {
			console.warn(`[tv-evidence] broadcasts query failed: ${bRes.error.message}`);
			return [];
		}
	}

	// 2. historical_broadcasts (8 OA channels — japanet/ntv/tbs/dinos/
	//    senobura/junsanpo/uranoura/txd).
	let hRes: { data: unknown[] | null; error: { message: string } | null } = {
		data: [],
		error: null,
	};
	const historicalChannelsToQuery = useCategoryPath
		? null
		: (candidate.tv_channels ?? []).filter(
			(c) => c !== "shopch" && c !== "qvc",
		);
	if (useCategoryPath || (historicalChannelsToQuery && historicalChannelsToQuery.length > 0)) {
		let hQuery = sb
			.from("historical_broadcasts")
			.select("channel, air_date, product_name, price_jpy, category")
			.eq("country", getRuntimeMarketCountry())
			.gte("air_date", cutoff);
		if (useCategoryPath) {
			hQuery = hQuery.in("category", resolved);
		} else if (historicalChannelsToQuery) {
			hQuery = hQuery.in("channel", historicalChannelsToQuery);
			// Push name-token match to the DB. 2 years × a channel can be
			// 10k+ rows — without this filter the implicit ~1000 row limit
			// drops valid matches before JS-side corroboration ever runs.
			// Escape PostgREST special chars in tokens (commas, parens).
			const safeTokens = nameTokens
				.map((t) => t.replace(/[,()]/g, " ").trim())
				.filter((t) => t.length >= 3);
			if (safeTokens.length > 0) {
				const orClause = safeTokens
					.map((t) => `product_name.ilike.%${t}%`)
					.join(",");
				hQuery = hQuery.or(orClause);
			}
		}
		hRes = await hQuery;
	}

	if (hRes.error) {
		console.warn(`[tv-evidence] historical query failed: ${hRes.error.message}`);
	}

	// 3. qvc_products price lookup keyed by product id for broadcasts join.
	//    Only fetch if we actually have qvc broadcasts that need price.
	const qvcProductIds = new Set<string>();
	for (const row of (bRes.data ?? []) as Array<{ channel: string; product_ids: string[] | null }>) {
		if (row.channel !== "qvc" || !row.product_ids) continue;
		for (const id of row.product_ids) qvcProductIds.add(id);
	}
	const qPriceMap = new Map<string, number>();
	if (qvcProductIds.size > 0) {
		const qRes = await sb
			.from("qvc_products")
			.select("product_id, price_text")
			.in("product_id", [...qvcProductIds]);
		if (!qRes.error && qRes.data) {
			for (const q of qRes.data as Array<{ product_id: string; price_text: string | null }>) {
				if (!q.price_text) continue;
				const m = q.price_text.match(/([0-9][0-9,]{2,})\s*円/);
				if (!m) continue;
				const n = parseInt(m[1].replace(/,/g, ""), 10);
				if (Number.isFinite(n) && n > 0) qPriceMap.set(q.product_id, n);
			}
		}
	}

	function nameMatches(title: string): boolean {
		if (nameTokens.length === 0) return false;
		const hay = title.normalize("NFKC").toLowerCase();
		return nameTokens.some((t) => hay.includes(t.toLowerCase()));
	}

	/**
	 * Stricter variant for the channel-keyed path. Without a category narrow,
	 * we need distinctive token overlap to avoid surfacing brand-only or
	 * generic-noun matches.
	 *
	 * Rules:
	 *   - When the candidate has ≥2 strong tokens (≥4 chars OR contains
	 *     Latin/digit), require ≥2 of them to be present in the title.
	 *     This means "nishikawa AiR3D ピロー" matches "nishikawa [AiR3D]ピロー／枕"
	 *     (both "nishikawa" and "AiR3D" land) but NOT "nishikawa ごろ寝マット"
	 *     (only "nishikawa" lands — brand alone is not enough).
	 *   - When the candidate has exactly 1 strong token, require that one.
	 *   - When there are no strong tokens at all, fall back to any-token
	 *     match (best we can do).
	 */
	function nameMatchesStrict(title: string): boolean {
		if (nameTokens.length === 0) return false;
		const hay = title.normalize("NFKC").toLowerCase();
		const strongTokens = nameTokens.filter(
			(t) => t.length >= 4 || /[a-z0-9]/i.test(t),
		);
		if (strongTokens.length === 0) {
			return nameTokens.some((t) => hay.includes(t.toLowerCase()));
		}
		const hits = strongTokens.filter((t) => hay.includes(t.toLowerCase())).length;
		const required = strongTokens.length >= 2 ? 2 : 1;
		return hits >= required;
	}

	function priceMatches(p: number | null): boolean {
		if (priceBand === null) return false;
		if (p === null) return false;
		return p >= priceBand[0] && p <= priceBand[1];
	}

	const out: BroadcastRow[] = [];

	for (const row of (bRes.data ?? []) as Array<{
		channel: string;
		air_date: string;
		start_time: string;
		program_title: string;
		category: string | null;
		product_ids: string[] | null;
	}>) {
		// Category-keyed path requires row.category (IN was applied);
		// channel-keyed path doesn't require it.
		if (useCategoryPath && !row.category) continue;
		const inferredPrice =
			row.channel === "qvc" && row.product_ids?.[0]
				? qPriceMap.get(row.product_ids[0]) ?? null
				: null;
		const corroborated = useChannelPath
			? // Channel-keyed: strict name match required (channel + strong-token = safe)
				nameMatchesStrict(row.program_title)
			: // Category-keyed: original logic
				(priceBand === null && nameTokens.length === 0) ||
					priceMatches(inferredPrice) ||
					nameMatches(row.program_title);
		if (!corroborated) continue;
		out.push({
			source: "broadcasts",
			channel: row.channel,
			air_date: row.air_date,
			start_time: row.start_time,
			title: row.program_title,
			price_jpy: inferredPrice,
		});
	}

	for (const row of (hRes.data ?? []) as Array<{
		channel: string;
		air_date: string;
		product_name: string;
		price_jpy: number | null;
		category: string | null;
	}>) {
		if (useCategoryPath && !row.category) continue;
		const corroborated = useChannelPath
			? nameMatchesStrict(row.product_name)
			: (priceBand === null && nameTokens.length === 0) ||
				priceMatches(row.price_jpy) ||
				nameMatches(row.product_name);
		if (!corroborated) continue;
		out.push({
			source: "historical",
			channel: row.channel,
			air_date: row.air_date,
			start_time: null,
			title: row.product_name,
			price_jpy: row.price_jpy,
		});
	}

	return out;
}

export async function computeTvEvidence(
	sb: SupabaseClient,
	candidate: CandidateInput,
): Promise<TvEvidence | null> {
	const whitelistCategories = await normalizeCategory(sb, candidate.category);
	const hasChannelPath =
		whitelistCategories.length === 0 &&
		(candidate.tv_channels?.length ?? 0) > 0 &&
		tokenizeName(candidate.name).length > 0;

	// Bail when neither path is open.
	if (whitelistCategories.length === 0 && !hasChannelPath) return null;

	const rows = await fetchMatchingBroadcastRows(sb, candidate, whitelistCategories);
	if (rows.length === 0) return null;

	return aggregateBroadcastRows(rows, {
		category_keywords: whitelistCategories, // empty[] on the channel-keyed path
		price_band: priceBandFor(candidate.price_jpy),
		name_tokens: tokenizeName(candidate.name),
	});
}
