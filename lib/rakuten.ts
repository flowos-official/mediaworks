/**
 * Rakuten Ichiba API client
 * Docs: https://webservice.rakuten.co.jp/documentation/ichiba-item-search
 *       https://webservice.rakuten.co.jp/documentation/ichiba-item-ranking
 *
 * Auth: applicationId + accessKey (both required since 2026-04 API update)
 * Rate limit: 1 request per second per applicationId
 */

const RAKUTEN_RANKING_API = "https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601";
const RAKUTEN_SEARCH_API = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401";

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

// Registered application URL — used as Referer/Origin for API authentication
const RAKUTEN_APP_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://mediaworks-six.vercel.app";

function getRakutenCredentials(): { applicationId: string; accessKey: string } | null {
	const applicationId = process.env.RAKUTEN_APPLICATION_ID;
	const accessKey = process.env.RAKUTEN_ACCESS_KEY;
	if (!applicationId || !accessKey) {
		return null;
	}
	return { applicationId, accessKey };
}

function rakutenFetchHeaders(): HeadersInit {
	return {
		Origin: RAKUTEN_APP_URL,
		Referer: `${RAKUTEN_APP_URL}/`,
	};
}

function parseItems(data: Record<string, unknown>): RakutenItem[] {
	return (data.Items as unknown[] ?? []).map(
		(entry: unknown, idx: number) => {
			const e = entry as Record<string, unknown>;
			const item = (e.Item ?? e.item ?? e) as Record<string, unknown>;
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
}

/**
 * Fetch Rakuten Ichiba ranking for a given genre/category.
 */
export async function rakutenRankingSearch(
	keyword?: string,
	genreId?: string,
	limit = 10,
): Promise<RakutenRankingResult> {
	const creds = getRakutenCredentials();
	if (!creds) {
		console.log("[rakuten] RAKUTEN_APPLICATION_ID or RAKUTEN_ACCESS_KEY not set — skipping");
		return { items: [] };
	}

	try {
		const params = new URLSearchParams({
			applicationId: creds.applicationId,
			accessKey: creds.accessKey,
			format: "json",
			hits: String(Math.min(limit, 30)),
		});

		if (genreId) params.set("genreId", genreId);
		if (keyword) params.set("keyword", keyword);

		const res = await fetch(`${RAKUTEN_RANKING_API}?${params}`, {
			signal: AbortSignal.timeout(8000),
			headers: rakutenFetchHeaders(),
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			console.warn(`[rakuten ranking] API returned ${res.status}: ${body.slice(0, 200)}`);
			return { items: [] };
		}

		const data = await res.json() as Record<string, unknown>;
		return {
			items: parseItems(data),
			genreName: String(data.GenreName ?? ""),
			period: String(data.period ?? ""),
		};
	} catch (err) {
		console.warn("[rakuten ranking] fetch failed:", err instanceof Error ? err.message : String(err));
		return { items: [] };
	}
}

/**
 * Search Rakuten Ichiba items by keyword with social-proof sorting.
 */
export async function rakutenItemSearch(
	keyword: string,
	sort: "-reviewCount" | "-reviewAverage" | "-updateTimestamp" = "-reviewCount",
	limit = 10,
): Promise<RakutenRankingResult> {
	const creds = getRakutenCredentials();
	if (!creds || !keyword.trim()) {
		return { items: [] };
	}

	try {
		const params = new URLSearchParams({
			applicationId: creds.applicationId,
			accessKey: creds.accessKey,
			format: "json",
			keyword: keyword.trim(),
			sort,
			hits: String(Math.min(limit, 30)),
			hasReviewFlag: "1",
		});

		const res = await fetch(`${RAKUTEN_SEARCH_API}?${params}`, {
			signal: AbortSignal.timeout(8000),
			headers: rakutenFetchHeaders(),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			console.warn(`[rakuten search] API returned ${res.status}: ${body.slice(0, 200)}`);
			return { items: [] };
		}

		const data = await res.json() as Record<string, unknown>;
		const items = parseItems(data).filter((it) => it.itemName);
		console.log(`[rakuten search] keyword="${keyword}" sort=${sort} → ${items.length} items`);
		return { items };
	} catch (err) {
		console.warn("[rakuten search] fetch failed:", err instanceof Error ? err.message : String(err));
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
