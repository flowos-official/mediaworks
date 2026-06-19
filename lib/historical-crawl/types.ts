export type OAChannelSlug =
	| "japanet"
	| "junsanpo"
	| "ntv"
	| "tbs"
	| "dinos"
	| "senobura"
	| "uranoura"
	| "txd"
	| "ropping"
	| "kantv"
	| "rakuraku"
	| "ichiban";

/**
 * Row to upsert into public.historical_broadcasts.
 * Matches the column set of the table; price_jpy is best-effort.
 */
export interface HistoricalRow {
	channel: OAChannelSlug;
	air_date: string; // YYYY-MM-DD JST
	day_of_week: string | null; // 月/火/水/木/金/土/日
	/**
	 * HH:MM:SS (JST) when the source page exposes it. Most OA channel
	 * schedule pages do not expose per-slot start times, so this is
	 * typically null. Future parsers / re-audits can fill it without a
	 * schema change. Phase 1-D.
	 */
	start_time: string | null;
	product_name: string;
	price_text: string | null;
	price_jpy: number | null;
	price_is_tax_incl: boolean | null;
	source_url: string | null;
	source_sheet: string; // for traceability — "live-crawl:<slug>" when scraped (not from xlsx)
	image_url: string | null;
}

export interface CrawlResult {
	channel: OAChannelSlug;
	ok: boolean;
	rows: HistoricalRow[];
	error?: string;
	durationMs: number;
}

export interface ChannelParser {
	slug: OAChannelSlug;
	name: string;
	fetchToday: (jstDate: string) => Promise<HistoricalRow[]>;
}

export const USER_AGENT =
	"MediaWorks-Historical-Crawl/1.0 (+contact@mediaw-b.com)";

/** Today in JST as YYYY-MM-DD. */
export function jstToday(): string {
	const now = new Date();
	const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
	return jst.toISOString().slice(0, 10);
}

/** Day-of-week JP single char for a YYYY-MM-DD date. */
export function dayOfWeekJp(iso: string): string {
	const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
	const dt = new Date(Date.UTC(y, m - 1, d));
	return ["日", "月", "火", "水", "木", "金", "土"][dt.getUTCDay()];
}
