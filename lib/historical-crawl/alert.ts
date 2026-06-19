/**
 * Proactive ops alerting for the daily OA broadcast crawl.
 *
 * The crawl already records every run (status / per-channel rowCount / error)
 * to `historical_crawl_runs`, and `/admin/historical-crawl` surfaces it — but
 * that is PULL only (someone has to open the dashboard). This module turns it
 * into PUSH: a single webhook ping when a run fails outright, a channel errors,
 * or a channel's row count falls below 50% of its 7-day median (the same red
 * threshold the dashboard flags). When everything is healthy it stays silent.
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
	kind: "run_failed" | "channel_error" | "channel_undercapture";
	channel?: string;
	detail: string;
}

/**
 * Alert thresholds. `UNDERCAPTURE_RATIO` mirrors the dashboard's red flag
 * (<50% of 7-day median). `MIN_MEDIAN_SAMPLES` / `MIN_MEDIAN` suppress noise
 * from channels with too little history, or naturally tiny/variable counts
 * (japanet ~1/day; dateless asahi catalogs like rakuraku can be 0/day) where a
 * 50% drop carries no signal.
 */
export const UNDERCAPTURE_RATIO = 0.5;
export const MIN_MEDIAN_SAMPLES = 3;
export const MIN_MEDIAN = 5;

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
): CrawlAlert[] {
	// A fully-failed run persisted no channel data — one alert, nothing to scan.
	if (status === "failed") {
		return [{ kind: "run_failed", detail: "crawl run failed — no channels persisted" }];
	}

	const ratio = opts.undercaptureRatio ?? UNDERCAPTURE_RATIO;
	const minSamples = opts.minMedianSamples ?? MIN_MEDIAN_SAMPLES;
	const minMedian = opts.minMedian ?? MIN_MEDIAN;
	const baseByChannel = new Map(baselines.map((b) => [b.channel, b]));
	const alerts: CrawlAlert[] = [];

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
}

export interface MaybeSendCrawlAlertDeps {
	loadBaseline?: (lookbackDays?: number) => Promise<ChannelBaseline[]>;
	postWebhook?: (url: string, body: object) => Promise<{ ok: boolean; error?: string }>;
	webhookUrl?: string;
	selectOpts?: SelectCrawlAlertsOpts;
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
	const alerts = selectCrawlAlerts(input.status, input.channels, baselines, deps.selectOpts);
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
