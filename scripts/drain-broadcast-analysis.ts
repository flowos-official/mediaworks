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

function flag(name: string): string | undefined {
	return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main(): Promise<void> {
	const limit = Number(flag("limit") ?? 40);
	const category = flag("category") ?? "家電";
	const concurrency = Number(process.env.BROADCAST_INTEL_BATCH_CONCURRENCY) || 2;
	const sb = getServiceClient();

	console.log(`[drain] recovered ${await recoverStaleAnalysis()} stale slot(s)`);
	console.log(`[drain] seeded ${await seedAnalysisQueue({ limit, category })} slot(s) for ${category}`);

	const counts = { done: 0, failed: 0, skipped: 0, queued: 0 };
	let processed = 0;
	const startedAt = Date.now();

	while (processed < limit) {
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
		}
	}

	const mins = Math.round((Date.now() - startedAt) / 60_000);
	console.log(`\n[drain] processed=${processed} done=${counts.done} failed=${counts.failed} skipped=${counts.skipped} in ~${mins}min`);
	console.log(`[drain] record the wall time and S3 egress in the spec §12.`);
}

main();
