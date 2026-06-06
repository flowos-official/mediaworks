/**
 * Targeted drain — mirrors the archive-videos cron exactly (queued AND
 * air_date <= today JST), newest-first, until empty. Unlike drain-archive-queue
 * it does NOT touch future-dated queued slots (06-07/08 forward slots) whose
 * video isn't published yet. Runs to completion locally (no 240s budget cap).
 *
 * Run: tsx --env-file=.env.local scripts/drain-up-to-today.ts
 */
import { archiveOne, type QueuedSlot } from "../lib/broadcasts/video-archival";
import { recoverStaleDownloading } from "../lib/broadcasts/stale-downloading-recovery";
import { getServiceClient } from "../lib/supabase";

const BATCH_SIZE = 8;
const CONCURRENCY = 4;
const MAX_ITERATIONS = 30;

async function pBoundedAll<T, R>(items: readonly T[], worker: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let i = 0;
	const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (true) {
			const idx = i++;
			if (idx >= items.length) return;
			results[idx] = await worker(items[idx]);
		}
	});
	await Promise.all(lanes);
	return results;
}

async function main() {
	const sb = getServiceClient();
	const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
	console.log(`Targeted drain: video_status='queued' AND air_date <= ${todayJst} (JST today)`);

	const stale = await recoverStaleDownloading();
	if (stale.requeued || stale.abandoned) {
		console.log(`[drain] stale recovery: requeued=${stale.requeued} abandoned=${stale.abandoned}`);
	}

	let archived = 0, retry = 0, deferred = 0, abandoned = 0, bytes = 0;
	const t0 = Date.now();
	for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
		const { data, error } = await sb
			.from("broadcasts")
			.select("id, channel, air_date, start_time, product_ids, video_download_attempts")
			.eq("video_status", "queued")
			.lt("video_download_attempts", 5)
			.lte("air_date", todayJst)
			.order("air_date", { ascending: false })
			.limit(BATCH_SIZE);
		if (error) { console.error("[drain] read failed:", error.message); process.exit(1); }
		const queue = (data ?? []) as QueuedSlot[];
		if (queue.length === 0) { console.log(`\n[drain] queue empty after ${iter - 1} iterations.`); break; }

		const tB = Date.now();
		const results = await pBoundedAll(queue, archiveOne, CONCURRENCY);
		for (const r of results) {
			if (r.status === "archived") archived++;
			else if (r.status === "queued") retry++;
			else if (r.status === "deferred") deferred++;
			else if (r.status === "abandoned") abandoned++;
			bytes += r.bytes ?? 0;
		}
		const tally = results.reduce((m, r) => m.set(r.status, (m.get(r.status) ?? 0) + 1), new Map<string, number>());
		console.log(
			`[drain] iter ${iter} (${Math.round((Date.now() - tB) / 1000)}s): ` +
			[...tally.entries()].map(([s, c]) => `${s}=${c}`).join(" ") +
			`  (cum archived=${archived} +${(bytes / 1e9).toFixed(2)}GB)`,
		);
	}
	console.log(`\nDONE. archived=${archived} retry=${retry} deferred=${deferred} abandoned=${abandoned}  ${(bytes / 1e9).toFixed(2)}GB in ${Math.round((Date.now() - t0) / 1000)}s`);
}

void main().catch((e) => { console.error(e); process.exit(1); });
