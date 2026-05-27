/**
 * One-shot recovery: re-classify ShopCh broadcast slots stuck on
 * `video_status='failed_unsupported'`.
 *
 * Context: until 2026-05-27 the archive pipeline marked every ShopCh slot as
 * `failed_unsupported` based on a false-positive observation that the m3u8
 * host returned 403 (it turned out 403 just means "no object for that
 * programId"). This script re-fetches each slot's JSON, reads `pgmMovie`, and
 * sets:
 *   pgmMovie present → queued   (archive cron will pick it up)
 *   pgmMovie absent  → deferred (genuinely no aired-program video for that slot)
 *
 * It also clears `video_error` and resets `video_download_attempts` so a fresh
 * archive attempt starts cleanly.
 *
 * Usage:
 *   npm run reset:shopch-video-status
 */
import { getServiceClient } from "../lib/supabase";
import {
	buildProgramId,
	fetchShopChSlotMetadataBatch,
} from "../lib/broadcasts/shopch-json";

const PAGE_SIZE = 200;
const META_BATCH = 5;        // slots per ShopCh JSON fetch wave
const META_CONCURRENCY = 3;  // fetch concurrency inside the batch

interface Row {
	id: string;
	air_date: string;
	start_time: string | null;
}

async function main(): Promise<void> {
	const sb = getServiceClient();

	let offset = 0;
	let page = 0;
	let totalSeen = 0;
	let queued = 0;
	let deferred = 0;
	let skippedNoStartTime = 0;
	let skippedNoMeta = 0;

	while (true) {
		const { data, error } = await sb
			.from("broadcasts")
			.select("id, air_date, start_time")
			.eq("channel", "shopch")
			.eq("video_status", "failed_unsupported")
			.order("air_date", { ascending: true })
			.range(offset, offset + PAGE_SIZE - 1);

		if (error) {
			console.error(`[reset] page ${page} fetch failed:`, error.message);
			process.exit(1);
		}
		if (!data || data.length === 0) break;

		const rows = data as Row[];
		totalSeen += rows.length;

		// Process in fixed-size meta-batches so a stuck JSON fetch doesn't stall the run.
		for (let i = 0; i < rows.length; i += META_BATCH) {
			const slice = rows.slice(i, i + META_BATCH);
			const programIds: string[] = [];
			const idByProgramId = new Map<string, string>();

			for (const row of slice) {
				if (!row.start_time) {
					skippedNoStartTime += 1;
					continue;
				}
				const pid = buildProgramId(row.air_date, row.start_time);
				programIds.push(pid);
				idByProgramId.set(pid, row.id);
			}

			if (programIds.length === 0) continue;

			const metaMap = await fetchShopChSlotMetadataBatch(
				programIds,
				META_CONCURRENCY,
			);

			for (const pid of programIds) {
				const broadcastId = idByProgramId.get(pid);
				if (!broadcastId) continue;
				const meta = metaMap.get(pid);

				// Slots older than ~30 days are no longer reachable via the JSON
				// API — leave them alone so they can be reviewed manually.
				if (!meta) {
					skippedNoMeta += 1;
					continue;
				}

				const nextStatus = meta.videoPath ? "queued" : "deferred";
				const { error: updErr } = await sb
					.from("broadcasts")
					.update({
						video_status: nextStatus,
						video_error: null,
						video_download_attempts: 0,
					})
					.eq("id", broadcastId);

				if (updErr) {
					console.warn(`[reset] update ${broadcastId} failed:`, updErr.message);
					continue;
				}

				if (nextStatus === "queued") queued += 1;
				else deferred += 1;
			}
		}

		console.log(
			`[reset] page ${page} rows=${rows.length} queued=${queued} deferred=${deferred} skipped_no_meta=${skippedNoMeta} skipped_no_start_time=${skippedNoStartTime}`,
		);

		if (data.length < PAGE_SIZE) break;
		offset += PAGE_SIZE;
		page += 1;
	}

	console.log("\n[reset] DONE");
	console.log(`  total scanned   : ${totalSeen}`);
	console.log(`  → queued        : ${queued}`);
	console.log(`  → deferred      : ${deferred}`);
	console.log(`  skipped (no JSON): ${skippedNoMeta}`);
	console.log(`  skipped (no start_time): ${skippedNoStartTime}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
