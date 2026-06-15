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
 * One PostgREST `.or()` clause per affected channel — the De Morgan negation of
 * that channel's hide predicate. Apply each clause to a `historical_broadcasts`
 * query (chained `.or()` calls AND-combine, so every channel's pollution is
 * excluded); each clause is a no-op for rows of other channels (channel.neq.X
 * holds) and for that channel's rows after its cutoff (air_date.gt holds).
 * Apply ONLY to `historical_broadcasts` — the `broadcasts` table (qvc/shopch)
 * has no `source_sheet` column.
 */
export const MISDATED_OA_OR_CLAUSES: readonly string[] = Object.entries(MISDATED_OA_CUTOFFS).map(
	([ch, cutoff]) => `channel.neq.${ch},source_sheet.neq.live-crawl:${ch},air_date.gt.${cutoff}`,
);
