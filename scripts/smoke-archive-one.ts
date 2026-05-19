/**
 * Smoke test: pick the first queued broadcast slot with attempts=0 and run
 * archiveOne() on it end-to-end, then print the resulting DB row.
 *
 * Prerequisites:
 *   1. Migration 2026-05-19_broadcasts_video_status_full_enum.sql applied.
 *   2. AWS env vars set: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 *      AWS_S3_BUCKET, VIDEO_ARCHIVE_BASE_URL.
 *   3. At least one row with video_status='queued' and video_download_attempts=0.
 *      Run backfill:broadcast-products first if none exist.
 *
 * Usage:
 *   npm run smoke:archive-one
 */
import { getServiceClient } from "../lib/supabase";
import { archiveOne, type QueuedSlot } from "../lib/broadcasts/video-archival";

async function main() {
	const sb = getServiceClient();

	// Pick the first queued slot with 0 prior attempts (safest for a smoke test)
	const { data, error } = await sb
		.from("broadcasts")
		.select("id, channel, air_date, start_time, product_ids, video_download_attempts")
		.eq("video_status", "queued")
		.eq("video_download_attempts", 0)
		.order("air_date", { ascending: true })
		.limit(1)
		.maybeSingle();

	if (error) {
		console.error("[smoke] DB query failed:", error.message);
		process.exit(1);
	}
	if (!data) {
		console.error(
			"[smoke] No queued slot with attempts=0 found.\n" +
			"  Run `npm run backfill:broadcast-products` first, or confirm the migration is applied.",
		);
		process.exit(1);
	}

	const slot = data as QueuedSlot;
	console.log(`[smoke] Picked slot id=${slot.id} channel=${slot.channel} air_date=${slot.air_date} start_time=${slot.start_time}`);
	console.log("[smoke] Running archiveOne()...");

	const result = await archiveOne(slot);
	console.log("[smoke] archiveOne() result:", JSON.stringify(result, null, 2));

	// Fetch and print the final DB row state
	const { data: finalRow, error: fetchErr } = await sb
		.from("broadcasts")
		.select(
			"id, video_status, video_download_attempts, video_error, " +
			"archived_video_s3, video_size_bytes, video_duration_sec, video_downloaded_at",
		)
		.eq("id", slot.id)
		.single();

	if (fetchErr) {
		console.error("[smoke] Final row fetch failed:", fetchErr.message);
		process.exit(1);
	}

	console.log("[smoke] Final DB row:");
	console.log(JSON.stringify(finalRow, null, 2));

	if (result.status === "archived") {
		console.log("\n[smoke] PASS — slot archived successfully.");
	} else {
		console.log(`\n[smoke] status=${result.status}${result.error ? ` error=${result.error}` : ""}`);
		process.exit(result.status === "deferred" || result.status === "failed_unsupported" ? 0 : 1);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
