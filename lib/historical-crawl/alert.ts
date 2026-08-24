/**
 * Proactive ops alerting for the daily OA broadcast crawl.
 *
 * The crawl already records every run (status / per-channel rowCount / error)
 * to `historical_crawl_runs`, and `/admin/historical-crawl` surfaces it — but
 * that is PULL only (someone has to open the dashboard). This module turns it
 * into PUSH: a single webhook ping when a run fails outright, a channel errors,
 * a channel's row count falls below 50% of its 7-day median (the same red
 * threshold the dashboard flags), or a channel has returned 0 rows for N
 * consecutive runs (a silently-empty source, or a new parser that never
 * captured anything — the blind spot the median check can't see). When
 * everything is healthy it stays silent.
 *
 * Mirrors the archive-reconciliation alert design: small pure functions
 * (`selectCrawlAlerts`, `buildCrawlAlertPayload`) plus a thin dependency-injected
 * sender (`maybeSendCrawlAlert`), so the decision logic is unit-testable without
 * a DB or network. `loadBaseline` is pulled in via dynamic import so importing
 * the pure functions from a tsx smoke test never drags in the Supabase client.
 *
 * NO `import "server-only"` — imported by a tsx unit test.
 */
import type { ChannelBaseline, PerChannelRunEntry, RunStatus } from "./runs";
import { postWebhook } from "../alerts/webhook";

export interface CrawlAlert {
	kind:
		| "run_failed"
		| "channel_error"
		| "channel_undercapture"
		| "channel_silent"
		| "persist_failed";
	channel?: string;
	detail: string;
}

/** What `persistRows` actually managed to store for a run. */
export interface PersistSummary {
	totalRows: number;
	upserted: number;
	errors: number;
	firstError?: string;
}

/**
 * Every channel check above judges PARSING. None of them can see the save path,
 * and between 2026-07-28 and 2026-08-19 that blind spot swallowed 22 days of OA
 * data: the Korean deployment renamed `price_jpy` on the shared table, every
 * upsert came back PGRST204, and the run still recorded `completed` with
 * upserted=0 because the persist error count was never stored.
 *
 * Rows parsed but not stored is the signal, whether the write failed loudly
 * (an error) or silently (a BEFORE INSERT trigger returning NULL yields zero
 * affected rows and no error at all). Pure.
 */
export function selectPersistAlert(persist: PersistSummary): CrawlAlert | null {
	if (persist.totalRows === 0) return null; // nothing to save; channel checks own this
	if (persist.errors > 0) {
		return {
			kind: "persist_failed",
			detail:
				`${persist.errors} of ${persist.totalRows} rows failed to upsert ` +
				`(stored ${persist.upserted})` +
				(persist.firstError ? `: ${persist.firstError.slice(0, 160)}` : ""),
		};
	}
	if (persist.upserted === 0) {
		return {
			kind: "persist_failed",
			detail:
				`parsed ${persist.totalRows} rows but stored 0 with no error — ` +
				"the write is being rejected or skipped silently",
		};
	}
	return null;
}

/**
 * A run whose channels all parsed is not "completed" if its rows never landed.
 * Only ever downgrades: a parse-level `partial`/`failed` stays as it is.
 */
export function statusWithPersist(status: RunStatus, persist: PersistSummary): RunStatus {
	if (status !== "completed") return status;
	if (selectPersistAlert(persist) === null) return "completed";
	return persist.upserted > 0 ? "partial" : "failed";
}

/**
 * Alert thresholds. `UNDERCAPTURE_RATIO` mirrors the dashboard's red flag
 * (<50% of 7-day median). `MIN_MEDIAN_SAMPLES` / `MIN_MEDIAN` suppress noise
 * from channels with too little history, or naturally tiny/variable counts
 * (japanet ~1/day) where a single-run 50% drop carries no signal. A channel
 * that is PERSISTENTLY 0 is caught separately by `selectSilentChannels` below.
 */
export const UNDERCAPTURE_RATIO = 0.5;
export const MIN_MEDIAN_SAMPLES = 3;
export const MIN_MEDIAN = 5;
/** A registered channel that returns 0 rows for this many consecutive runs is
 * flagged as silently broken — catches a new parser that never captured
 * anything (no median to undercut) and a source that quietly went empty. */
export const ZERO_STREAK_RUNS = 3;

export interface SelectCrawlAlertsOpts {
	undercaptureRatio?: number;
	minMedianSamples?: number;
	minMedian?: number;
}

/**
 * Decide which conditions in a finished crawl run are worth paging about.
 * Pure — no DB, no env, no network.
 */
export function selectCrawlAlerts(
	status: RunStatus,
	channels: PerChannelRunEntry[],
	baselines: ChannelBaseline[],
	opts: SelectCrawlAlertsOpts = {},
	persist?: PersistSummary,
): CrawlAlert[] {
	// A fully-failed run persisted no channel data — one alert, nothing to scan.
	if (status === "failed") {
		return [{ kind: "run_failed", detail: "crawl run failed — no channels persisted" }];
	}

	const persistAlert = persist ? selectPersistAlert(persist) : null;

	const ratio = opts.undercaptureRatio ?? UNDERCAPTURE_RATIO;
	const minSamples = opts.minMedianSamples ?? MIN_MEDIAN_SAMPLES;
	const minMedian = opts.minMedian ?? MIN_MEDIAN;
	const baseByChannel = new Map(baselines.map((b) => [b.channel, b]));
	const alerts: CrawlAlert[] = persistAlert ? [persistAlert] : [];

	for (const c of channels) {
		if (!c.ok || c.error) {
			alerts.push({
				kind: "channel_error",
				channel: c.channel,
				detail: c.error ? `error: ${c.error.slice(0, 160)}` : "channel returned not-ok",
			});
			continue; // an errored channel has no meaningful rowCount to judge
		}
		const base = baseByChannel.get(c.channel);
		if (!base || base.samples < minSamples || base.median7d < minMedian) continue;
		const floor = Math.round(base.median7d * ratio);
		if (c.rowCount < floor) {
			alerts.push({
				kind: "channel_undercapture",
				channel: c.channel,
				detail: `${c.rowCount} rows < ${floor} (${Math.round(ratio * 100)}% of 7d median ${base.median7d}, n=${base.samples})`,
			});
		}
	}
	return alerts;
}

/** A run's per-channel `channels` snapshot (subset of PerChannelRunEntry that
 * `selectSilentChannels` needs). */
export interface RunChannelsSnapshot {
	channels: Array<{ channel: string; rowCount: number; error?: string }>;
}

/**
 * Flag channels that have returned 0 rows for `threshold` consecutive runs
 * (the most recent `threshold` runs, current included). This is the safety net
 * for the median check's blind spot: a newly-added parser that never captured
 * anything (no 7-day median to undercut), or a source that quietly went empty
 * without throwing. Errored entries are skipped (channel_error covers those),
 * and a channel absent from any run in the window breaks its streak. Pure.
 */
export function selectSilentChannels(
	recentRuns: RunChannelsSnapshot[],
	threshold: number = ZERO_STREAK_RUNS,
): CrawlAlert[] {
	if (recentRuns.length < threshold) return []; // not enough history to judge
	const window = recentRuns.slice(0, threshold);
	const latest = window[0]?.channels ?? [];
	const alerts: CrawlAlert[] = [];
	for (const c of latest) {
		if (c.error || c.rowCount !== 0) continue;
		const allZero = window.every((run) => {
			const e = (run.channels ?? []).find((x) => x.channel === c.channel);
			return e != null && !e.error && e.rowCount === 0;
		});
		if (allZero) {
			alerts.push({
				kind: "channel_silent",
				channel: c.channel,
				detail: `0 rows for ${threshold} consecutive runs — source or parser likely broken`,
			});
		}
	}
	return alerts;
}

/** Build a Slack/Discord-compatible payload. Pure. */
export function buildCrawlAlertPayload(
	jstDate: string,
	status: RunStatus,
	alerts: CrawlAlert[],
): { text: string } {
	const lines = alerts.map(
		(a) => `• ${a.channel ? `[${a.channel}] ` : ""}${a.detail}`,
	);
	return {
		text: `⚠️ OA broadcast crawl alert — ${jstDate} (status: ${status})\n${lines.join("\n")}`,
	};
}

export interface MaybeSendCrawlAlertInput {
	jstDate: string;
	status: RunStatus;
	channels: PerChannelRunEntry[];
	/** Omit only when there was no save step to judge (a total crawl failure). */
	persist?: PersistSummary;
}

export interface MaybeSendCrawlAlertDeps {
	loadBaseline?: (lookbackDays?: number) => Promise<ChannelBaseline[]>;
	loadRecentRuns?: (limit: number) => Promise<RunChannelsSnapshot[]>;
	postWebhook?: (url: string, body: object) => Promise<{ ok: boolean; error?: string }>;
	webhookUrl?: string;
	selectOpts?: SelectCrawlAlertsOpts;
	zeroStreakRuns?: number;
}

export interface MaybeSendCrawlAlertResult {
	alerts: CrawlAlert[];
	sent: boolean;
	skippedReason?: "no_alerts" | "no_webhook_url";
	error?: string;
}

/**
 * Glue: load the 7-day baseline, decide alerts, and POST to ALERT_WEBHOOK_URL
 * when there are any. Dependencies are injectable for tests. Best-effort by
 * contract — the cron caller must still wrap this so a thrown error or a
 * webhook failure never breaks the crawl itself.
 */
export async function maybeSendCrawlAlert(
	input: MaybeSendCrawlAlertInput,
	deps: MaybeSendCrawlAlertDeps = {},
): Promise<MaybeSendCrawlAlertResult> {
	const send = deps.postWebhook ?? postWebhook;
	const url = deps.webhookUrl ?? process.env.ALERT_WEBHOOK_URL ?? "";

	// Only the non-failed path needs the baseline; a total failure becomes a
	// single run_failed alert and shouldn't query the DB (which may be the very
	// thing that's down at that moment).
	let baselines: ChannelBaseline[] = [];
	if (input.status !== "failed") {
		const load =
			deps.loadBaseline ??
			(async (d?: number) => (await import("./runs")).loadBaseline(d));
		baselines = await load(7);
	}
	const alerts = selectCrawlAlerts(input.status, input.channels, baselines, deps.selectOpts, input.persist);

	// Silent-zero safety net: ping when a channel has been 0 for N consecutive
	// runs (needs run history, so it's here rather than in the pure selector).
	// Skipped on a total failure (no per-channel data). Deduped against channels
	// already flagged above so we never double-alert the same channel.
	if (input.status !== "failed") {
		const streak = deps.zeroStreakRuns ?? ZERO_STREAK_RUNS;
		const loadRuns =
			deps.loadRecentRuns ??
			(async (n: number) => (await import("./runs")).loadRecentRunChannels(n));
		const recentRuns = await loadRuns(streak);
		const flagged = new Set(alerts.map((a) => a.channel).filter(Boolean));
		for (const s of selectSilentChannels(recentRuns, streak)) {
			if (!flagged.has(s.channel)) alerts.push(s);
		}
	}

	if (alerts.length === 0) return { alerts, sent: false, skippedReason: "no_alerts" };
	if (!url) return { alerts, sent: false, skippedReason: "no_webhook_url" };

	const payload = buildCrawlAlertPayload(input.jstDate, input.status, alerts);
	const r = await send(url, payload);
	return {
		alerts,
		sent: r.ok,
		error: r.ok ? undefined : r.error ?? "unknown webhook error",
	};
}
