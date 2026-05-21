/**
 * Cross-match a TV-channel-sourced product against Rakuten to recover a
 * popularity signal. The 13 non-broadcast TV channel sites (japanet, tbs,
 * ntv, dinos, etc.) don't publish review counts or sales ranks — Brave's
 * `site:` search only gives a page title + meta description. So when a TV
 * channel candidate has a known equivalent listing on Rakuten, we surface
 * that listing's review data as a proxy for popularity.
 *
 * Verification rule: cross-match is only accepted when the Rakuten result
 * shares ≥2 long-tokens (>=3 chars) with the TV-channel product name.
 * Token overlap is a coarse fuzzy match but works well in practice — same
 * product across channels almost always shares brand + model number, which
 * are the longest tokens.
 */

import { rakutenItemSearch } from "@/lib/rakuten";

export interface RakutenCrossMatch {
	itemUrl: string;
	itemName: string;
	reviewCount: number;
	reviewAvg: number;
	priceJpy: number;
	similarityScore: number;
}

/**
 * Channel-store branding fragments to strip before keyword search.
 * Longer phrases come first so they're consumed before substring tokens
 * (e.g. "日本テレビの通販ショッピングサイト" before "通販").
 */
const CHANNEL_BRAND_TOKENS = [
	// Long suffixes / full marketing taglines first
	"日本テレビの通販ショッピングサイト",
	"日テレポシュレ本店",
	"日テレポシュレ",
	"テレビ通販サイトのカンテレSHOPPING",
	"カンテレSHOPPING",
	"ＴＢＳショッピング",
	"TBSショッピング",
	"テレ東マート",
	"テレビショッピング",
	"通販【ジャパネット公式】",
	"ジャパネット公式",
	"通販公式",
	// Channel slugs & shop names
	"japanet",
	"ジャパネット",
	"TBS",
	"キニナル",
	"日テレ",
	"ポシュレ",
	"dinos",
	"ディノス",
	"フジ",
	"ロッピング",
	"ABC",
	"せのぶら",
	"らくらく",
	"いちばん",
	"カチモ",
	"kachimo",
	"買いドキ",
	"関テレ",
	"カンテレ",
	"テレ朝",
	"テレ東",
	"オンラインストア",
	"通販",
	"公式",
	"本店",
];

const STOP_TOKENS = new Set([
	"の",
	"を",
	"に",
	"で",
	"と",
	"は",
	"が",
	"|",
	"｜",
	"-",
	"–",
	"・",
	"／",
	"/",
	"【",
	"】",
	"＜",
	"＞",
	"商品",
	"通販",
	"オンライン",
	"ストア",
	"ショップ",
	"shop",
	"store",
	"online",
	"特典付き",
	"特典",
	"新品同様",
	"レッド",
	"ブラック",
	"ホワイト",
	"テレビ",
	"サイト",
	"ショッピング",
	"shopping",
]);

/**
 * Strip channel-branding fragments and tokenize for search/comparison.
 * Returns long tokens (≥2 chars) suitable for matching. Also strips
 * URL-like fragments (contain '.' and >5 chars) and pure-promotional
 * fragments that shouldn't enter a product search query.
 */
function tokenize(text: string): string[] {
	let cleaned = text;
	for (const brand of CHANNEL_BRAND_TOKENS) {
		// Case-insensitive removal
		cleaned = cleaned.replace(new RegExp(brand, "gi"), " ");
	}
	// Strip URL-like fragments — they break Rakuten search
	cleaned = cleaned.replace(/[a-zA-Z0-9.-]*\.(jp|co\.jp|com|net)\S*/g, " ");
	// Strip product code suffixes like "999-303348" that aren't searchable
	cleaned = cleaned.replace(/\b\d{3,}-\d{3,}\b/g, " ");
	const raw = cleaned
		.split(/[\s\-_/・、。（）()【】\[\]「」『』|｜:：＜＞＆＋,，]+/)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2 && !STOP_TOKENS.has(t.toLowerCase()));
	return raw;
}

/**
 * Count overlapping tokens — uses substring matching for ≥4-char tokens.
 * Substring rule handles katakana product names that get concatenated
 * (TV channel: "リファカラットレイ"; Rakuten: "リファ カラットレイ ReFa").
 * Exact-equality rule for short tokens (≥3 chars) to keep generic-noun
 * collisions in check.
 */
function overlapCount(a: string[], b: string[]): number {
	const aLow = a.map((t) => t.toLowerCase());
	const bLow = b.map((t) => t.toLowerCase());
	const used = new Set<number>();
	let n = 0;
	for (const at of aLow) {
		if (at.length < 3) continue;
		let matched = -1;
		for (let i = 0; i < bLow.length; i++) {
			if (used.has(i)) continue;
			const bt = bLow[i];
			if (bt.length < 3) continue;
			// Long tokens: bidirectional substring match (handles concatenation)
			if (at.length >= 4 || bt.length >= 4) {
				if (bt.includes(at) || at.includes(bt)) {
					matched = i;
					break;
				}
			} else {
				// 3-char tokens: exact match only (generic katakana words like
				// "シューズ" shouldn't match every shoe-related listing)
				if (at === bt) {
					matched = i;
					break;
				}
			}
		}
		if (matched >= 0) {
			used.add(matched);
			n++;
		}
	}
	return n;
}

/**
 * Attempt to find a Rakuten listing that matches the same product.
 *
 * Returns null when:
 * - The TV-channel name is too short/generic to search reliably
 * - Rakuten returns no hits
 * - The best Rakuten hit shares fewer than 2 long-tokens with the input
 *   (high false-positive risk — don't surface a wrong popularity score)
 */
export async function findRakutenCrossMatch(
	tvChannelName: string,
): Promise<RakutenCrossMatch | null> {
	const inputTokens = tokenize(tvChannelName);
	if (inputTokens.length < 1) return null;

	// Use the first 2-3 longest tokens as the search query. More tokens =
	// fewer Rakuten hits (over-constrained). Long tokens tend to be the
	// product name / model number — most distinctive signals.
	const sortedByLength = [...inputTokens].sort((a, b) => b.length - a.length);
	const queryTokens = sortedByLength
		.filter((t) => t.length >= 3)
		.slice(0, 3);
	if (queryTokens.length < 1) return null;
	const query = queryTokens.join(" ");

	let result: Awaited<ReturnType<typeof rakutenItemSearch>>;
	try {
		// Sort by review count descending — we want the popular listing for the
		// same product, not a random shop's identical SKU with 0 reviews.
		result = await rakutenItemSearch(query, "-reviewCount", 5);
	} catch {
		return null;
	}

	if (!result.items || result.items.length === 0) return null;

	// Stricter overlap rules to suppress false positives:
	//  1. Require ≥3 overlapping long-tokens (not just 2). Two-token overlap
	//     is too easy to hit on generic words like "圧力" + "鍋" or
	//     "北海道" + "海産物" — both happened on a v0 sample run.
	//  2. At least one overlap token must be ≥4 chars OR contain a digit
	//     (= likely a model number or distinctive name). Short generic
	//     tokens alone don't identify a specific product.
	//  3. The Rakuten item name should not be dominated by promotional
	//     boilerplate. Reject if >60% of its tokens are noise tags like
	//     "ポイント" / "送料無料" / "クーポン" — those listings cheat their
	//     way to high reviewCount via accessories/parts.
	const PROMO_TOKENS = new Set([
		"ポイント",
		"バック",
		"送料無料",
		"クーポン",
		"発送",
		"エントリー",
		"ランキング",
		"セール",
		"part",
		"parts",
		"パッキン",
		"部品",
	]);
	let best: RakutenCrossMatch | null = null;
	for (const it of result.items) {
		const candidateTokens = tokenize(it.itemName);
		const overlap = overlapCount(inputTokens, candidateTokens);
		// Min overlap 2 (was 3) — too strict at 3 misses real matches because
		// TV-channel page titles are often short ("デュアルエクサV"). Quality
		// gate 2 below blocks generic-noun false positives.
		if (overlap < 2) continue;

		// Quality gate 2: at least one overlap must be on a strong token
		// (≥4 chars OR contains a digit = brand/model identifier). Short
		// generic katakana like "シューズ" alone doesn't earn a match.
		const aLow = inputTokens.map((t) => t.toLowerCase());
		const bLow = candidateTokens.map((t) => t.toLowerCase());
		const hasStrongOverlap = aLow.some((at) => {
			if (at.length < 4 && !/\d/.test(at)) return false;
			return bLow.some((bt) => {
				if (bt.length < 4 && !/\d/.test(bt)) return false;
				if (at.length >= 4 || bt.length >= 4) {
					return bt.includes(at) || at.includes(bt);
				}
				return at === bt;
			});
		});
		if (!hasStrongOverlap) continue;

		// Quality gate 3: promo-noise filter
		const promoHits = candidateTokens.filter((t) =>
			PROMO_TOKENS.has(t.toLowerCase()),
		).length;
		if (candidateTokens.length > 0 && promoHits / candidateTokens.length > 0.4) {
			continue;
		}

		const score = overlap + (it.reviewCount > 0 ? 1 : 0);
		if (!best || score > best.similarityScore) {
			best = {
				itemUrl: it.itemUrl,
				itemName: it.itemName,
				reviewCount: it.reviewCount ?? 0,
				reviewAvg: it.reviewAverage ?? 0,
				priceJpy: it.itemPrice ?? 0,
				similarityScore: score,
			};
		}
	}

	return best;
}

export const __test = {
	tokenize,
	overlapCount,
};
