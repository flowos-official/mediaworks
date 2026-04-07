/**
 * Rakuten Ichiba Item Ranking API
 * Docs: https://webservice.rakuten.co.jp/documentation/ichiba-item-ranking
 */

const RAKUTEN_API_BASE = "https://app.rakuten.co.jp/services/api/IchibaItem/Ranking/20220601";

export type RakutenItem = {
	rank: number;
	itemName: string;
	itemPrice: number;
	itemCaption: string;
	itemUrl: string;
	shopName: string;
	reviewCount: number;
	reviewAverage: number;
	genreId?: string;
};

export type RakutenRankingResult = {
	items: RakutenItem[];
	genreName?: string;
	period?: string;
};

/**
 * Fetch Rakuten Ichiba ranking for a given genre/category.
 * Returns empty result (graceful fallback) when API key is not configured.
 */
export async function rakutenRankingSearch(
	keyword?: string,
	genreId?: string,
	limit = 10,
): Promise<RakutenRankingResult> {
	const applicationId = process.env.RAKUTEN_APPLICATION_ID;

	// Graceful fallback when not configured
	if (!applicationId) {
		console.log("[rakuten] RAKUTEN_APPLICATION_ID not set — skipping ranking search");
		return { items: [] };
	}

	try {
		const params = new URLSearchParams({
			applicationId,
			format: "json",
			hits: String(Math.min(limit, 30)),
		});

		if (genreId) params.set("genreId", genreId);
		if (keyword) params.set("keyword", keyword);

		const res = await fetch(`${RAKUTEN_API_BASE}?${params}`, {
			signal: AbortSignal.timeout(5000),
		});

		if (!res.ok) {
			console.warn(`[rakuten] API returned ${res.status}`);
			return { items: [] };
		}

		const data = await res.json();

		const items: RakutenItem[] = (data.Items ?? []).map(
			(entry: Record<string, unknown>, idx: number) => {
				const item = (entry.Item ?? entry) as Record<string, unknown>;
				return {
					rank: idx + 1,
					itemName: String(item.itemName ?? ""),
					itemPrice: Number(item.itemPrice ?? 0),
					itemCaption: String(item.itemCaption ?? "").slice(0, 200),
					itemUrl: String(item.itemUrl ?? ""),
					shopName: String(item.shopName ?? ""),
					reviewCount: Number(item.reviewCount ?? 0),
					reviewAverage: Number(item.reviewAverage ?? 0),
					genreId: String(item.genreId ?? ""),
				};
			},
		);

		return {
			items,
			genreName: String(data.GenreName ?? ""),
			period: String(data.period ?? ""),
		};
	} catch (err) {
		console.warn("[rakuten] Ranking fetch failed (non-fatal):", err instanceof Error ? err.message : String(err));
		return { items: [] };
	}
}

/**
 * Search Rakuten Ichiba items by keyword with social-proof sorting.
 * Uses IchibaItem/Search API (different from Ranking) which supports:
 * - keyword filter
 * - sort options: -reviewCount (most reviewed), -reviewAverage (highest rated),
 *   -updateTimestamp (newest), -itemPrice / +itemPrice
 *
 * Returns items that are actually popular (high review count) — better proxy
 * for "Japan consumer interest" than the cumulative sales Ranking API.
 */
const RAKUTEN_SEARCH_API = "https://app.rakuten.co.jp/services/api/IchibaItem/Search/20170706";

export async function rakutenItemSearch(
	keyword: string,
	sort: "-reviewCount" | "-reviewAverage" | "-updateTimestamp" = "-reviewCount",
	limit = 10,
): Promise<RakutenRankingResult> {
	const applicationId = process.env.RAKUTEN_APPLICATION_ID;
	if (!applicationId || !keyword.trim()) {
		return { items: [] };
	}

	try {
		const params = new URLSearchParams({
			applicationId,
			format: "json",
			keyword: keyword.trim(),
			sort,
			hits: String(Math.min(limit, 30)),
			hasReviewFlag: "1", // require items that have at least one review
		});

		const res = await fetch(`${RAKUTEN_SEARCH_API}?${params}`, {
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) {
			console.warn(`[rakuten search] API returned ${res.status}`);
			return { items: [] };
		}

		const data = await res.json();
		const rawItems: RakutenItem[] = (data.Items ?? []).map(
			(entry: Record<string, unknown>, idx: number) => {
				// Defensive: support both v1 (Item / item wrapping) and v2 (flat) responses
				const item = (entry.Item ?? entry.item ?? entry) as Record<string, unknown>;
				return {
					rank: idx + 1,
					itemName: String(item.itemName ?? ""),
					itemPrice: Number(item.itemPrice ?? 0),
					itemCaption: String(item.itemCaption ?? "").slice(0, 200),
					itemUrl: String(item.itemUrl ?? ""),
					shopName: String(item.shopName ?? ""),
					reviewCount: Number(item.reviewCount ?? 0),
					reviewAverage: Number(item.reviewAverage ?? 0),
					genreId: String(item.genreId ?? ""),
				};
			},
		);

		// Client-side enforce minimum social proof (≥5 reviews)
		const items = rawItems.filter((it) => it.itemName && it.reviewCount >= 5);
		return { items };
	} catch (err) {
		console.warn("[rakuten search] fetch failed (non-fatal):", err instanceof Error ? err.message : String(err));
		return { items: [] };
	}
}

/**
 * Format Rakuten ranking data as a readable string for Gemini prompts.
 */
export function formatRakutenRanking(result: RakutenRankingResult): string {
	if (!result.items.length) return "";

	const lines = [
		`楽天市場 ランキング${result.genreName ? ` (${result.genreName})` : ""}:`,
		...result.items.slice(0, 5).map(
			(item) =>
				`  ${item.rank}位: ${item.itemName} — ¥${item.itemPrice.toLocaleString()} (レビュー: ${item.reviewAverage}点/${item.reviewCount}件)`,
		),
	];
	return lines.join("\n");
}
