/**
 * Targeted smoke test: archive ONE shopch slot end-to-end (m3u8 → S3 → DB row).
 * Picks the most-recently aired queued shopch slot with attempts=0 so we test
 * the freshest video stem (CloudFront keeps recent objects warm).
 *
 * Usage: npm run smoke:archive-one-shopch
 */
import { getServiceClient } from "../lib/supabase";
import { archiveOne, type QueuedSlot } from "../lib/broadcasts/video-archival";

async function main(): Promise<void> {
	const sb = getServiceClient();

	const { data, error } = await sb
		.from("broadcasts")
		.select("id, channel, air_date, start_time, product_ids, video_download_attempts")
		.eq("channel", "shopch")
		.eq("video_status", "queued")
		.eq("video_download_attempts", 0)
		.order("air_date", { ascending: false })
		.limit(1)
		.maybeSingle();

	if (error) {
		console.error("[smoke-shopch] DB query failed:", error.message);
		process.exit(1);
	}
	if (!data) {
		console.error("[smoke-shopch] No queued shopch slot with attempts=0 — run reset:shopch-video-status first.");
		process.exit(1);
	}

	const slot = data as QueuedSlot;
	console.log(
		`[smoke-shopch] Picked id=${slot.id} air_date=${slot.air_date} start_time=${slot.start_time}`,
	);

	const result = await archiveOne(slot);
	console.log("[smoke-shopch] result:", JSON.stringify(result, null, 2));

	const { data: finalRow } = await sb
		.from("broadcasts")
		.select(
			"id, video_status, video_download_attempts, video_error, " +
			"archived_video_s3, video_size_bytes, video_duration_sec, video_downloaded_at",
		)
		.eq("id", slot.id)
		.single();

	console.log("[smoke-shopch] final row:", JSON.stringify(finalRow, null, 2));

	process.exit(result.status === "archived" ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
