/**
 * Parser for ShopCh's per-slot JSON API:
 *   GET /json/programprodlist2/{YYYYMMDDHHMMSS}.json
 *   (requires Referer: https://www.shopch.jp/...)
 *
 * Used to capture product snapshots at airtime for competitive archival.
 */
import { politeFetch } from "./fetch";

export interface ShopChProductSnapshot {
	productId: string;
	name: string | null;
	imageUrl: string | null;
	priceJpy: number | null;
	originalPriceJpy: number | null;
	discountRate: number | null;
	saleLabel: string | null;
	taxIncl: boolean | null;
	inStockAtCapture: boolean;
}

export interface ShopChSlotMetadata {
	category: string | null;
	categoryCode: string | null;
	productIds: string[];
	products: ShopChProductSnapshot[];
	brandName: string | null;
	brandCode: string | null;
	/** Site's m3u8 stem path (e.g. "m3u8/prog/20260518000000/20260518000000").
	 *  Stored for future ShopCh video archival; null when absent. */
	videoPath: string | null;
	/** Program title (pgmname). Sourced from JSON so it survives the programlist
	 *  page's client-side rendering, which leaves past-day article markup empty. */
	programTitle: string | null;
	/** Lead thumbnail (pgmImg) as an absolute URL; null for placeholders. */
	thumbnailUrl: string | null;
	/** First cast/guest name (navigator/presenter). */
	presenter: string | null;
}

interface RawSlotJSON {
	pgmname?: unknown;
	pgmImg?: unknown;
	pgmcategory?: unknown;
	pgmcategorycode?: unknown;
	prodList1?: unknown;
	brandname?: unknown;
	brandcode?: unknown;
	pgmMovie?: unknown;
	castList?: unknown;
	guestList?: unknown;
}

const EMPTY: ShopChSlotMetadata = {
	category: null,
	categoryCode: null,
	productIds: [],
	products: [],
	brandName: null,
	brandCode: null,
	videoPath: null,
	programTitle: null,
	thumbnailUrl: null,
	presenter: null,
};

function trimOrNull(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const t = v.trim();
	return t.length > 0 ? t : null;
}

/** ShopCh image paths are site-relative (e.g. "/img/prod/836/313/83631301L.jpg").
 *  Returns an absolute URL, or null for empty / placeholder paths. */
function shopChImageUrl(path: string | null): string | null {
	if (!path) return null;
	if (path.includes("/navigator/")) return null;
	return path.startsWith("http")
		? path
		: `https://www.shopch.jp/${path.replace(/^\/+/, "")}`;
}

/** First non-empty castName from a cast/guest list array. */
function firstCastName(v: unknown): string | null {
	if (!Array.isArray(v)) return null;
	for (const c of v) {
		if (c && typeof c === "object") {
			const name = (c as Record<string, unknown>).castName;
			const t = trimOrNull(name);
			if (t) return t;
		}
	}
	return null;
}

/**
 * Parse the raw JSON body returned by /json/programprodlist2/{id}.json
 * into a structured ShopChSlotMetadata object.
 */
export function parseShopChSlotJSON(body: string): ShopChSlotMetadata {
	let parsed: RawSlotJSON;
	try {
		parsed = JSON.parse(body) as RawSlotJSON;
	} catch {
		return { ...EMPTY };
	}

	if (typeof parsed !== "object" || parsed === null) {
		return { ...EMPTY };
	}

	// Extract productIds from prodList1
	const prodList = parsed.prodList1;
	const productIds: string[] = [];
	if (Array.isArray(prodList)) {
		for (const item of prodList) {
			if (typeof item !== "object" || item === null) continue;
			const pid = (item as Record<string, unknown>).reqPrNo;
			if (typeof pid === "string" && /^\d+$/.test(pid)) {
				productIds.push(pid);
			}
		}
	}

	// Map prodList1 items into ShopChProductSnapshot[]
	const products: ShopChProductSnapshot[] = [];
	if (Array.isArray(prodList)) {
		for (const raw of prodList) {
			if (typeof raw !== "object" || raw === null) continue;
			const item = raw as Record<string, unknown>;
			const pid = item.reqPrNo;
			if (typeof pid !== "string" || !/^\d+$/.test(pid)) continue;

			const parseYen = (v: unknown): number | null => {
				if (typeof v !== "string") return null;
				const digits = v.replace(/[^\d]/g, "");
				return digits.length > 0 ? parseInt(digits, 10) : null;
			};
			const parseRate = (v: unknown): number | null => {
				if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
				const n = parseInt(v, 10);
				return n >= 0 && n <= 100 ? n : null;
			};
			const imageUrl = shopChImageUrl(trimOrNull(item.prodImg));
			const nostock = trimOrNull(item.nostockName);
			const taxStr = trimOrNull(item.texStr);

			products.push({
				productId: pid,
				name: trimOrNull(item.prodName),
				imageUrl,
				priceJpy: parseYen(item.genzaiPrice),
				originalPriceJpy: parseYen(item.comperPrice),
				discountRate: parseRate(item.offRate),
				saleLabel:
					trimOrNull(item.limitedPriceLabel) ?? trimOrNull(item.saleStr),
				taxIncl: taxStr === null ? null : taxStr === "(税込)",
				inStockAtCapture: nostock === null,
			});
		}
	}

	const videoPath = trimOrNull(parsed.pgmMovie);

	return {
		category: trimOrNull(parsed.pgmcategory),
		categoryCode: trimOrNull(parsed.pgmcategorycode),
		productIds,
		products,
		brandName: trimOrNull(parsed.brandname),
		brandCode: trimOrNull(parsed.brandcode),
		videoPath,
		programTitle: trimOrNull(parsed.pgmname),
		thumbnailUrl: shopChImageUrl(trimOrNull(parsed.pgmImg)),
		presenter: firstCastName(parsed.castList) ?? firstCastName(parsed.guestList),
	};
}

/**
 * Build the 14-char programId key (YYYYMMDDHHMMSS) from an air_date + start_time.
 * e.g. ("2026-05-18", "14:30:00") → "20260518143000"
 */
export function buildProgramId(airDate: string, startTime: string): string {
	const datePart = airDate.replace(/-/g, ""); // "20260518"
	const timePart = startTime.replace(/:/g, ""); // "143000"
	return `${datePart}${timePart}`;
}

const SHOPCH_JSON_BASE = "https://www.shopch.jp/json/programprodlist2";

/**
 * Fetch ShopCh slot JSON for a batch of program IDs.
 * Returns a Map keyed by programId (YYYYMMDDHHMMSS) → ShopChSlotMetadata.
 * Missing / failed fetches are silently omitted from the map.
 */
export async function fetchShopChSlotMetadataBatch(
	programIds: string[],
	concurrency = 3,
): Promise<Map<string, ShopChSlotMetadata>> {
	const result = new Map<string, ShopChSlotMetadata>();
	if (programIds.length === 0) return result;

	// Process in batches of `concurrency` to avoid hammering the host.
	for (let i = 0; i < programIds.length; i += concurrency) {
		const batch = programIds.slice(i, i + concurrency);
		await Promise.all(
			batch.map(async (pid) => {
				const url = `${SHOPCH_JSON_BASE}/${pid}.json`;
				const fetched = await politeFetch(url, {
					timeoutMs: 10_000,
					retry: false,
				});
				if (!fetched.ok || !fetched.body) return;
				const meta = parseShopChSlotJSON(fetched.body);
				result.set(pid, meta);
			}),
		);
	}

	return result;
}
