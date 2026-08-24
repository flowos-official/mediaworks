/**
 * Local drain — the actual backfill path.
 * Usage: npm run drain:broadcast-analysis -- --limit=40 --category=家電
 *
 * The cron cannot do this: at 100-200s per slot inside a 300s function it
 * clears 2-4 per run.
 */
import { getServiceClient } from "@/lib/supabase";
import { analyzeOne, MAX_ATTEMPTS, type QueuedAnalysisSlot } from "@/lib/broadcast-intel/analyze-one";
import { recoverStaleAnalysis, seedAnalysisQueue } from "@/lib/broadcast-intel/queue";

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
	const category = flag("category") ?? "家電";
	const concurrency = Number(process.env.BROADCAST_INTEL_BATCH_CONCURRENCY) || 2;
	const sb = getServiceClient();

	console.log(`[drain] recovered ${await recoverStaleAnalysis()} stale slot(s)`);
	console.log(`[drain] seeded ${await seedAnalysisQueue({ limit, category })} slot(s) for ${category}`);

	const counts = { done: 0, failed: 0, skipped: 0, queued: 0 };
	let processed = 0;
	let consecutiveFailures = 0;
	let abortedOn: string | undefined;
	const startedAt = Date.now();

	outer: while (processed < limit) {
		const { data, error } = await sb
			.from("broadcasts")
			.select("id, channel, air_date, category, archived_video_s3, analysis_attempts")
			.eq("analysis_status", "queued")
			.eq("category", category)
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
