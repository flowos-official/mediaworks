/**
 * Local drain — the actual backfill path.
 * Usage: npm run drain:broadcast-analysis -- --limit=40 [--category=家電] [--channel=shopch]
 *        …--reset=cold_storage   requeue slots abandoned for that reason first
 *
 * The cron cannot do this: at 100-200s per slot inside a 300s function it
 * clears 2-4 per run.
 */
import { getServiceClient } from "@/lib/supabase";
import { analyzeOne, MAX_ATTEMPTS, type QueuedAnalysisSlot } from "@/lib/broadcast-intel/analyze-one";
import { recoverStaleAnalysis, resetAnalysisError, seedAnalysisQueue } from "@/lib/broadcast-intel/queue";
import { buildDrainAnalysisScope, parseDrainCategory } from "@/lib/broadcast-intel/drain-scope";
import type { AnalysisErrorCode } from "@/lib/broadcast-intel/error-codes";

/** Consecutive failed/requeued slots before the drain aborts. A dead Gemini
 *  key or bad S3 credentials makes every slot fail the same way — without
 *  this, 40 slots x up to 3 attempts each still downloads 606 MB per attempt
 *  before failing, burning egress silently. */
const CONSECUTIVE_FAILURE_LIMIT = 3;

function flag(name: string): string | undefined {
	return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

/** `--limit` unvalidated would let `Number("abc")` become NaN, which
 *  `.limit(NaN)` silently ignores — seedAnalysisQueue would then queue the
 *  entire category instead of the intended slice. */
function parseLimit(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		throw new Error(`--limit must be a positive integer, got ${JSON.stringify(raw)}`);
	}
	const CEILING = 100;
	return Math.min(n, CEILING);
}

async function main(): Promise<void> {
	const limit = parseLimit(flag("limit"), 40);
	const category = parseDrainCategory(flag("category"));
	// One channel at a time: QVC archives ~2-minute digest clips with no offer
	// segment, ShopCh archives ~1-hour full programmes. Mixing them averages a
	// highlight reel against a sales programme.
	const channelArg = flag("channel");
	if (channelArg && channelArg !== "qvc" && channelArg !== "shopch") {
		throw new Error(`--channel must be qvc or shopch, got "${channelArg}"`);
	}
	const channel = channelArg as "qvc" | "shopch" | undefined;
	const scope = buildDrainAnalysisScope(category, channel);
	const concurrency = Number(process.env.BROADCAST_INTEL_BATCH_CONCURRENCY) || 2;
	const sb = getServiceClient();

	// Only codes a later operator action can actually invalidate. `--reset` is
	// not a general "try everything again": no_archived_video and no_category
	// are properties of the row, and resetting them just re-skips every run.
	const RESETTABLE = ["cold_storage", "empty_object", "gemini_error", "gemini_timeout", "s3_fetch_failed"] as const;
	const resetArg = flag("reset");
	if (resetArg) {
		if (!(RESETTABLE as readonly string[]).includes(resetArg)) {
			throw new Error(`--reset must be one of ${RESETTABLE.join(", ")}; got "${resetArg}"`);
		}
		const n = await resetAnalysisError(resetArg as AnalysisErrorCode, scope);
		console.log(`[drain] reset ${n} slot(s) from ${resetArg} back to pending`);
	}

	console.log(`[drain] recovered ${await recoverStaleAnalysis()} stale slot(s)`);
	const scopeLabel = category ?? "balanced categories";
	console.log(`[drain] seeded ${await seedAnalysisQueue({ limit, ...scope })} slot(s) for ${scopeLabel}${channel ? ` / ${channel}` : ""}`);

	const counts = { done: 0, failed: 0, skipped: 0, queued: 0 };
	let processed = 0;
	let consecutiveFailures = 0;
	let abortedOn: string | undefined;
	const startedAt = Date.now();

	outer: while (processed < limit) {
		let q = sb
			.from("broadcasts")
			.select("id, channel, air_date, category, archived_video_s3, analysis_attempts")
			.eq("analysis_status", "queued");
		if (scope.category !== undefined) q = q.eq("category", scope.category);
		if (channel) q = q.eq("channel", channel);
		const { data, error } = await q
			.lt("analysis_attempts", MAX_ATTEMPTS)
			.order("air_date", { ascending: false })
			.limit(Math.min(concurrency, limit - processed));
		if (error) throw new Error(error.message);

		const slots = (data ?? []) as QueuedAnalysisSlot[];
		if (slots.length === 0) break;

		for (const r of await Promise.all(slots.map(analyzeOne))) {
			processed++;
			counts[r.status]++;
			console.log(`  ${r.status.padEnd(8)} ${r.broadcastId}${r.error ? ` — ${r.error}` : ""}`);

			// "skipped" (no video / no category / claim lost) never touched
			// ffmpeg or Gemini, so it neither proves nor disproves a systemic
			// outage — leave the streak alone.
			if (r.status === "skipped") continue;
			if (r.status === "done") {
				consecutiveFailures = 0;
				continue;
			}
			consecutiveFailures++;
			if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
				abortedOn = r.error ?? "unknown error";
				break outer;
			}
		}
	}

	const mins = Math.round((Date.now() - startedAt) / 60_000);
	console.log(`\n[drain] processed=${processed} done=${counts.done} failed=${counts.failed} skipped=${counts.skipped} in ~${mins}min`);
	if (abortedOn) {
		console.error(
			`[drain] ABORTED after ${consecutiveFailures} consecutive failures. Last error: ${abortedOn}`,
		);
		console.error(`[drain] a dead Gemini key or bad S3 credentials fails every slot the same way — check credentials before rerunning.`);
		process.exitCode = 1;
		return;
	}
	console.log(`[drain] record the wall time and S3 egress in the spec §12.`);
}

main();
