/**
 * Quick diagnostic — list all shopch slots in the last 7 days with their
 * video_status / archived_video_s3 to understand why some have ▶ and others don't.
 */
import { getServiceClient } from "../lib/supabase";

async function main(): Promise<void> {
	const sb = getServiceClient();
	const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);

	const { data, error } = await sb
		.from("broadcasts")
		.select("air_date, start_time, video_status, archived_video_s3, video_error, video_download_attempts, program_title")
		.eq("channel", "shopch")
		.gte("air_date", since)
		.order("air_date", { ascending: false })
		.order("start_time", { ascending: true });

	if (error) {
		console.error(error.message);
		process.exit(1);
	}

	const rows = data ?? [];
	const byStatus = new Map<string, number>();
	for (const r of rows) {
		const s = (r as { video_status: string | null }).video_status ?? "(null)";
		byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
	}

	console.log(`Shop CH slots (last 7 days, from ${since}): ${rows.length} total\n`);
	console.log("Breakdown by video_status:");
	for (const [s, c] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${s.padEnd(22)} ${c}`);
	}

	console.log("\nDetail (date | time | status | archived? | error):");
	for (const r of rows as Array<{
		air_date: string;
		start_time: string;
		video_status: string | null;
		archived_video_s3: string | null;
		video_error: string | null;
		video_download_attempts: number | null;
		program_title: string | null;
	}>) {
		const arch = r.archived_video_s3 ? "✓" : " ";
		const err = (r.video_error ?? "").slice(0, 60);
		console.log(
			`  ${r.air_date} ${r.start_time}  ${(r.video_status ?? "(null)").padEnd(22)} ${arch}  attempts=${r.video_download_attempts}  ${err}`,
		);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
