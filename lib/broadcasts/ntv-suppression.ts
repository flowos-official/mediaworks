/**
 * Display-time suppression of mis-dated ntv (日テレポシュレ) calendar rows.
 *
 * From the first live crawl (2026-05-16) through 2026-06-10, the ntv parser
 * stamped every broadcast-day section on the source page with the cron's run
 * date instead of each section's own date, producing ~50 mis-dated rows/day
 * (a single product ends up on up to 17 consecutive days). PR #98 fixes the
 * parser going forward, and 2026-06-11+ was rebuilt from the live page. The
 * 2026-05-16..06-10 window is unrecoverable — the source page retains only
 * ~5 days and no Wayback / archive.today snapshots exist for it — so rather
 * than delete those rows (a CSV backup exists) we HIDE them from the calendar
 * read paths. The DB rows stay for tv-evidence / audit. Reverse by removing
 * the `.or(KEEP_NON_MISDATED_NTV_OR)` calls from the three call sites
 * (aggregate-counts, getCachedChannelTotals, /api/historical-broadcasts).
 *
 * Rows hidden: channel='ntv' AND source_sheet='live-crawl:ntv' AND air_date <= cutoff.
 */
export const NTV_MISDATED_CUTOFF = "2026-06-10";

/**
 * PostgREST `.or()` argument that KEEPS every row EXCEPT the mis-dated ntv set
 * — the De Morgan negation of the hide predicate. Apply ONLY to queries over
 * `historical_broadcasts`; the `broadcasts` table has no `source_sheet` column.
 */
export const KEEP_NON_MISDATED_NTV_OR =
	`channel.neq.ntv,source_sheet.neq.live-crawl:ntv,air_date.gt.${NTV_MISDATED_CUTOFF}`;
