/**
 * Display-time suppression of mis-dated OA calendar rows.
 *
 * Several OA parsers historically blanket-stamped every product with the cron's
 * run date instead of the product's real broadcast date, so a single product
 * appeared on many consecutive days. The parsers are now date-aware (ntv via
 * PR #98; junsanpo/tbs via this PR) and each channel's recent window was rebuilt
 * from the live page. The older blanket pollution that predates each channel's
 * rebuilt window cannot be recovered — the source pages retain only a rolling
 * window and no Wayback / archive.today snapshots exist for it — so it is HIDDEN
 * from the calendar read paths rather than deleted. The DB rows stay for
 * tv-evidence / audit; reverse by dropping these clauses.
 *
 * Per channel, the rows hidden are:
 *   channel = X AND source_sheet = 'live-crawl:X' AND air_date <= cutoff[X]
 *
 * Each cutoff = (earliest date the channel's live page still covers) − 1 day,
 * i.e. the last day that could not be re-derived during the rebuild.
 */
export const MISDATED_OA_CUTOFFS: Record<string, string> = {
	ntv: "2026-06-10",
	junsanpo: "2026-05-16",
	tbs: "2026-06-02",
	// dinos: schedule page covers the current month only, so May blanket
	// pollution is unrecoverable. (kantv needed no cutoff — its date-filter
	// pages let the rebuild re-derive every polluted day.)
	dinos: "2026-05-31",
};

/**
 * Channels whose parser is STILL broken, so ALL their live-crawl rows are
 * mis-dated — not just an old window. A date cutoff can't help: the parser
 * keeps stamping the cron's run date onto future days, so each new day's rows
 * would slip past any past cutoff. These channels are hidden in full until the
 * parser can be fixed, then removed from this list.
 *
 * uranoura (ABCウラのウラまで, shop.asahi.co.jp/category/URANADJA): the shared
 * asahi parser dates by `.onair-time`, which this page does not expose, so it
 * falls back to the cron date — the DB shows the same 2 products stamped on
 * every cron day (maxSpan = #days-run). The page can't be reached from the dev
 * environment (shop.asahi.co.jp 400s every non-Vercel IP — local fetch,
 * browser headers, and WebFetch all blocked), so the real date markup is
 * unknown and a parser fix can't be written or verified yet. Hide until then.
 */
export const MISDATED_OA_FULL_HIDE: readonly string[] = ["uranoura"];

/**
 * One PostgREST `.or()` clause per affected channel — the De Morgan negation of
 * that channel's hide predicate. Apply each clause to a `historical_broadcasts`
 * query (chained `.or()` calls AND-combine, so every channel's pollution is
 * excluded); a cutoff clause is a no-op for other channels (channel.neq.X
 * holds) and for that channel's rows after its cutoff (air_date.gt holds), while
 * a full-hide clause drops every live-crawl row of its channel regardless of
 * date. Both keep rows of other channels and that channel's non-live-crawl rows
 * (e.g. xlsx import). Apply ONLY to `historical_broadcasts` — the `broadcasts`
 * table (qvc/shopch) has no `source_sheet` column.
 */
export const MISDATED_OA_OR_CLAUSES: readonly string[] = [
	...Object.entries(MISDATED_OA_CUTOFFS).map(
		([ch, cutoff]) => `channel.neq.${ch},source_sheet.neq.live-crawl:${ch},air_date.gt.${cutoff}`,
	),
	...MISDATED_OA_FULL_HIDE.map(
		(ch) => `channel.neq.${ch},source_sheet.neq.live-crawl:${ch}`,
	),
];
