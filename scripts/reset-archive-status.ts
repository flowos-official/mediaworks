/**
 * One-off: reset archive_status on qvc_products rows that have a video but were
 * archived under the old "720p re-encode" default, so the next archive run picks
 * them up and stores the source-codec MP4 instead.
 */
import { getServiceClient } from "../lib/supabase";

async function main() {
	const sb = getServiceClient();
	const ids = process.argv.slice(2);
	if (ids.length === 0) {
		// Default: any qvc row archived with video_quality='720p'
		const { data } = await sb
			.from("qvc_products")
			.select("id")
			.eq("video_quality", "720p");
		ids.push(...((data ?? []) as Array<{ id: string }>).map((r) => r.id));
	}
	console.log(`Resetting ${ids.length} row(s): ${ids.join(", ")}`);
	const { error } = await sb
		.from("qvc_products")
		.update({
			archive_status: "pending",
			archived_video_s3: null,
			video_size_bytes: null,
			video_duration_sec: null,
			video_quality: null,
		})
		.in("id", ids);
	if (error) {
		console.error("update error:", error.message);
		process.exit(1);
	}
	console.log("Done.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
