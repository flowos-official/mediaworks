/** DB-free unit tests for historical-crawl alert pure functions + DI'd sender.
 *   npx tsx scripts/test-historical-crawl-alert.ts
 * No --env-file: nothing here touches Supabase. loadBaseline/postWebhook are
 * injected, so the dynamic ./runs import (and its @/lib/supabase) never loads.
 */
import {
	selectCrawlAlerts,
	buildCrawlAlertPayload,
	maybeSendCrawlAlert,
	type CrawlAlert,
} from "../lib/historical-crawl/alert";
import type { ChannelBaseline, PerChannelRunEntry } from "../lib/historical-crawl/runs";

let failures = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
	if (JSON.stringify(actual) === JSON.stringify(expected)) console.log(`  ok: ${msg}`);
	else { console.error(`  FAIL: ${msg}\n    expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`); failures++; }
}
function ok(cond: boolean, msg: string) {
	if (cond) console.log(`  ok: ${msg}`);
	else { console.error(`  FAIL: ${msg}`); failures++; }
}

const ch = (channel: string, rowCount: number, extra: Partial<PerChannelRunEntry> = {}): PerChannelRunEntry => ({
	channel, ok: true, rowCount, durationMs: 100, ...extra,
});
const base = (channel: string, median7d: number, samples = 7): ChannelBaseline => ({ channel, median7d, samples });

function kinds(alerts: CrawlAlert[]): string[] {
	return alerts.map((a) => `${a.kind}${a.channel ? `:${a.channel}` : ""}`);
}

async function main() {
	console.log("selectCrawlAlerts:");
	// failed run → single run_failed, ignores channels/baselines
	eq(kinds(selectCrawlAlerts("failed", [ch("ntv", 0)], [base("ntv", 80)])), ["run_failed"], "failed run → one run_failed alert");

	// healthy completed run → no alerts
	eq(selectCrawlAlerts("completed", [ch("junsanpo", 139), ch("ntv", 80)], [base("junsanpo", 138), base("ntv", 85)]), [], "healthy run → no alerts");

	// channel with an error string → channel_error
	eq(kinds(selectCrawlAlerts("partial", [ch("junsanpo", 138), ch("senobura", 0, { ok: false, error: "HTTP 400" })], [base("junsanpo", 138)])),
		["channel_error:senobura"], "errored channel → channel_error; healthy peer silent");

	// channel not-ok without an error string → channel_error (generic detail)
	eq(selectCrawlAlerts("partial", [ch("ntv", 0, { ok: false })], [base("ntv", 80)])[0]?.detail,
		"channel returned not-ok", "not-ok without error → generic detail");

	// undercapture: 0 rows vs median 139 → channel_undercapture
	eq(kinds(selectCrawlAlerts("completed", [ch("junsanpo", 0)], [base("junsanpo", 139)])), ["channel_undercapture:junsanpo"], "0 vs median 139 → undercapture");

	// undercapture suppressed by tiny median (japanet ~1/day)
	eq(selectCrawlAlerts("completed", [ch("japanet", 0)], [base("japanet", 1)]), [], "tiny-median channel → no undercapture noise");

	// undercapture suppressed by too-few samples
	eq(selectCrawlAlerts("completed", [ch("kantv", 0)], [base("kantv", 100, 2)]), [], "insufficient baseline samples → no undercapture");

	// undercapture suppressed when no baseline exists for the channel
	eq(selectCrawlAlerts("completed", [ch("newchan", 0)], []), [], "no baseline → no undercapture");

	// boundary: rowCount exactly at the 50% floor → no alert; one below → alert
	eq(selectCrawlAlerts("completed", [ch("txd", 10)], [base("txd", 20)]), [], "rowCount == 50% floor → no alert");
	eq(kinds(selectCrawlAlerts("completed", [ch("txd", 9)], [base("txd", 20)])), ["channel_undercapture:txd"], "rowCount just below floor → alert");

	console.log("\nbuildCrawlAlertPayload:");
	const payload = buildCrawlAlertPayload("2026-06-15", "partial", [
		{ kind: "channel_error", channel: "junsanpo", detail: "error: boom" },
		{ kind: "channel_undercapture", channel: "ntv", detail: "0 rows < 40 (50% of 7d median 80, n=7)" },
	]);
	ok(payload.text.includes("2026-06-15") && payload.text.includes("status: partial"), "payload has date + status header");
	ok(payload.text.includes("[junsanpo] error: boom") && payload.text.includes("[ntv] 0 rows < 40"), "payload lists each alert line");

	console.log("\nmaybeSendCrawlAlert (DI; no real DB/network):");
	const baselines = [base("junsanpo", 139), base("ntv", 85)];
	const loadBaselineStub = async (_d?: number) => baselines;

	// undercapture + url set → sends
	{
		const calls: Array<{ url: string; body: object }> = [];
		const r = await maybeSendCrawlAlert(
			{ jstDate: "2026-06-15", status: "completed", channels: [ch("junsanpo", 0), ch("ntv", 85)] },
			{ loadBaseline: loadBaselineStub, postWebhook: async (url, body) => { calls.push({ url, body }); return { ok: true }; }, webhookUrl: "https://hook.example/x" },
		);
		ok(r.sent === true && r.alerts.length === 1 && calls.length === 1, "undercapture + url → sent once");
		ok(calls[0]?.url === "https://hook.example/x", "posted to the configured url");
	}

	// healthy → no send, no webhook call
	{
		let called = false;
		const r = await maybeSendCrawlAlert(
			{ jstDate: "2026-06-15", status: "completed", channels: [ch("junsanpo", 140), ch("ntv", 85)] },
			{ loadBaseline: loadBaselineStub, postWebhook: async () => { called = true; return { ok: true }; }, webhookUrl: "https://hook.example/x" },
		);
		ok(r.sent === false && r.skippedReason === "no_alerts" && !called, "healthy → not sent, webhook untouched");
	}

	// alerts but no webhook url → skipped, no call
	{
		let called = false;
		const r = await maybeSendCrawlAlert(
			{ jstDate: "2026-06-15", status: "completed", channels: [ch("junsanpo", 0)] },
			{ loadBaseline: loadBaselineStub, postWebhook: async () => { called = true; return { ok: true }; }, webhookUrl: "" },
		);
		ok(r.sent === false && r.skippedReason === "no_webhook_url" && !called, "no url → skipped, webhook untouched");
	}

	// failed run → does NOT load baseline, sends run_failed
	{
		let baselineLoaded = false;
		const r = await maybeSendCrawlAlert(
			{ jstDate: "2026-06-15", status: "failed", channels: [] },
			{ loadBaseline: async (_d?: number) => { baselineLoaded = true; return baselines; }, postWebhook: async () => ({ ok: true }), webhookUrl: "https://hook.example/x" },
		);
		ok(r.sent === true && kinds(r.alerts).join() === "run_failed" && baselineLoaded === false, "failed run → run_failed sent, baseline NOT queried");
	}

	// webhook failure → sent=false, error propagated
	{
		const r = await maybeSendCrawlAlert(
			{ jstDate: "2026-06-15", status: "completed", channels: [ch("junsanpo", 0)] },
			{ loadBaseline: loadBaselineStub, postWebhook: async () => ({ ok: false, error: "webhook HTTP 500" }), webhookUrl: "https://hook.example/x" },
		);
		ok(r.sent === false && r.error === "webhook HTTP 500", "webhook failure → sent=false with error");
	}

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
