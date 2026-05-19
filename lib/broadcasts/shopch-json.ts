/**
 * ShopCh slot metadata fetcher — reads `/json/programprodlist2/{programId}.json`
 * which the site already exposes for its own UI. Returns the slot's curated
 * category (`pgmcategory`) and the array of lead-product IDs (`prodList1`).
 *
 * Replaces the previous Gemini batch classifier (`shopch-category.ts`):
 *   - 100% category fill rate on 200 responses (vs ~67% Gemini whitelist hit)
 *   - 76% Gemini precision vs site ground truth (i.e., ~25% rewrites needed)
 *   - Bonus: populates `product_ids` (avg 6 IDs/slot) — previously NULL
 *
 * Soft failure: when the JSON endpoint returns non-200 (transient ~15% in
 * one observed run, dropping after retry), the slot's category stays null
 * and the daily cron retries on the next monthly refresh cycle. Never
 * raises — falls back to the empty result.
 *
 * Pure parser (`parseShopChSlotJSON`) is fixture-testable; the fetch wrapper
 * is the impure boundary.
 */
import { politeFetch } from "./fetch";

export interface ShopChSlotMetadata {
	/** Display name of the program category (e.g. "コスメ"). NULL when the
	 * JSON 200s but `pgmcategory` is missing/empty — which we have never
	 * observed in production but type for safety. */
	category: string | null;
	/** Site's internal sub-category code (e.g. "41"). Two distinct codes may
	 * share the same display name (e.g. ホーム・インテリア 22 + 23). Stored
	 * so future analytics can lean on the finer granularity. */
	categoryCode: string | null;
	/** Lead product IDs (reqPrNo) parsed from `prodList1`. Empty when the
	 * slot has no products attached (e.g. "ミックス" variety shows). */
	productIds: string[];
	/** Brand display name (e.g. "美人工房"). Useful for analytics. */
	brandName: string | null;
	/** Brand code matching the site's `brandcode`. */
	brandCode: string | null;
}

interface RawSlotJSON {
	pgmcategory?: unknown;
	pgmcategorycode?: unknown;
	prodList1?: unknown;
	brandname?: unknown;
	brandcode?: unknown;
}

const EMPTY: ShopChSlotMetadata = {
	category: null,
	categoryCode: null,
	productIds: [],
	brandName: null,
	brandCode: null,
};

function trimOrNull(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const trimmed = v.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** Pure parser — takes the raw JSON body of /json/programprodlist2/{id}.json
 * and extracts the fields we care about. Tolerates missing keys, extra keys,
 * and unexpected types. Returns the EMPTY sentinel on parse failure rather
 * than throwing, so callers don't need a try/catch. */
export function parseShopChSlotJSON(body: string): ShopChSlotMetadata {
	let parsed: RawSlotJSON;
	try {
		parsed = JSON.parse(body) as RawSlotJSON;
	} catch {
		return EMPTY;
	}
	if (typeof parsed !== "object" || parsed === null) return EMPTY;

	const productIds: string[] = [];
	const prodList = parsed.prodList1;
	if (Array.isArray(prodList)) {
		for (const item of prodList) {
			if (typeof item !== "object" || item === null) continue;
			const reqPrNo = (item as { reqPrNo?: unknown }).reqPrNo;
			if (typeof reqPrNo === "string" && /^\d+$/.test(reqPrNo)) {
				productIds.push(reqPrNo);
			}
		}
	}

	return {
		category: trimOrNull(parsed.pgmcategory),
		categoryCode: trimOrNull(parsed.pgmcategorycode),
		productIds,
		brandName: trimOrNull(parsed.brandname),
		brandCode: trimOrNull(parsed.brandcode),
	};
}

/** Convert a (air_date, start_time) pair to the 14-digit programId
 * the JSON endpoint expects (YYYYMMDDHHMMSS). */
export function buildProgramId(airDate: string, startTime: string): string {
	return airDate.replace(/-/g, "") + startTime.replace(/:/g, "");
}

/** Fetch and parse one slot's metadata. On any failure (network, 5xx, 4xx,
 * malformed JSON) returns EMPTY — never throws. The daily cron retries on
 * subsequent runs, so a transient miss simply leaves the slot's category
 * null until the next monthly refresh. */
export async function fetchShopChSlotMetadata(
	programId: string,
): Promise<ShopChSlotMetadata> {
	const url = `https://www.shopch.jp/json/programprodlist2/${programId}.json`;
	const res = await politeFetch(url, { timeoutMs: 10_000 });
	if (!res.ok || !res.body) return EMPTY;
	return parseShopChSlotJSON(res.body);
}

/** Batch enrich an array of slot identifiers with concurrency control.
 * Returns a map keyed by programId. Slots that fail enrichment map to
 * EMPTY; callers should treat them as "category unknown" and not assume
 * NULL means "out of whitelist". */
export async function fetchShopChSlotMetadataBatch(
	programIds: readonly string[],
	opts: { concurrency?: number; pauseMs?: number } = {},
): Promise<Map<string, ShopChSlotMetadata>> {
	const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 8));
	const pauseMs = opts.pauseMs ?? 250;
	const out = new Map<string, ShopChSlotMetadata>();
	for (let i = 0; i < programIds.length; i += concurrency) {
		const chunk = programIds.slice(i, i + concurrency);
		const results = await Promise.all(
			chunk.map(async (pid) => [pid, await fetchShopChSlotMetadata(pid)] as const),
		);
		for (const [pid, meta] of results) out.set(pid, meta);
		if (i + concurrency < programIds.length) {
			await new Promise((r) => setTimeout(r, pauseMs));
		}
	}
	return out;
}
