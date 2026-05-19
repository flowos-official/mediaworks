/**
 * One-off drain — keeps calling archive-videos worker logic locally until
 * the queue is empty. Each pass takes up to 8 slots at concurrency 4.
 *
 * Run: tsx --env-file=.env.local scripts/drain-archive-queue.ts
 */
import { archiveOne, type QueuedSlot } from "../lib/broadcasts/video-archival";
import { getServiceClient } from "../lib/supabase";

const BATCH_SIZE = 8;
const CONCURRENCY = 4;
const MAX_ITERATIONS = 60; // safety: 60 * 8 = 480 slots, plenty for current 351

async function pBoundedAll<T, R>(
	items: readonly T[],
	worker: (item: T) => Promise<R>,
	concurrency: number,
): Promise<R[]> {
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
	let totalArchived = 0;
	let totalQueued = 0;
	let totalDeferred = 0;
	let totalAbandoned = 0;
	let totalBytes = 0;
	const t0 = Date.now();

	for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
		const { data, error } = await sb
			.from("broadcasts")
			.select("id, channel, air_date, start_time, product_ids, video_download_attempts")
			.eq("video_status", "queued")
			.lt("video_download_attempts", 5)
			.order("air_date", { ascending: false })
			.limit(BATCH_SIZE);
		if (error) {
			console.error("[drain] queue read failed:", error.message);
			process.exit(1);
		}
		const queue = (data ?? []) as QueuedSlot[];
		if (queue.length === 0) {
			console.log(`\n[drain] queue empty after ${iter - 1} iterations.`);
			break;
		}

		const tBatch = Date.now();
		const results = await pBoundedAll(queue, archiveOne, CONCURRENCY);
		const archived = results.filter((r) => r.status === "archived").length;
		const queuedAgain = results.filter((r) => r.status === "queued").length;
		const deferred = results.filter((r) => r.status === "deferred").length;
		const abandoned = results.filter((r) => r.status === "abandoned").length;
		const batchBytes = results.reduce((s, r) => s + (r.bytes ?? 0), 0);
		totalArchived += archived;
		totalQueued += queuedAgain;
		totalDeferred += deferred;
		totalAbandoned += abandoned;
		totalBytes += batchBytes;
		const elapsedTotal = Math.round((Date.now() - t0) / 1000);
		const elapsedBatch = Math.round((Date.now() - tBatch) / 1000);
		console.log(
			`[drain] iter ${iter} (${elapsedBatch}s, ${elapsedTotal}s total): ` +
				`archived=${archived}, retry=${queuedAgain}, deferred=${deferred}, abandoned=${abandoned}, ` +
				`+${(batchBytes / 1e6).toFixed(1)}MB (total ${(totalBytes / 1e9).toFixed(2)}GB)`,
		);
	}

	console.log(
		`\nDONE. archived=${totalArchived}, retry=${totalQueued}, deferred=${totalDeferred}, abandoned=${totalAbandoned}, ` +
			`total ${(totalBytes / 1e9).toFixed(2)} GB in ${Math.round((Date.now() - t0) / 1000)}s`,
	);
}

void main().catch((e) => {
	console.error(e);
	process.exit(1);
});
