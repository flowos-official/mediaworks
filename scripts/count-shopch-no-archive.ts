import { getServiceClient } from "../lib/supabase";

async function main(): Promise<void> {
	const sb = getServiceClient();

	// Total May ShopCh slots by status
	const { data: all } = await sb
		.from("broadcasts")
		.select("air_date, video_status, archived_video_s3, category, video_error")
		.eq("channel", "shopch")
		.gte("air_date", "2026-05-01")
		.lte("air_date", "2026-05-31")
		.order("air_date", { ascending: false });

	type Row = { air_date: string; video_status: string | null; archived_video_s3: string | null; category: string | null; video_error: string | null };
	const rows = (all ?? []) as Row[];

	console.log(`Total May ShopCh slots: ${rows.length}\n`);

	const byStatus = new Map<string, number>();
	for (const r of rows) byStatus.set(r.video_status ?? "(null)", (byStatus.get(r.video_status ?? "(null)") ?? 0) + 1);
	console.log("By video_status:");
	for (const [s, c] of byStatus) console.log(`  ${s.padEnd(22)} ${c}`);

	const withVideo = rows.filter((r) => r.archived_video_s3).length;
	const withoutVideo = rows.length - withVideo;
	console.log(`\nWith ▶ button:    ${withVideo}`);
	console.log(`Without ▶ button: ${withoutVideo}`);

	// Detail of "without ▶" slots by date
	console.log("\n--- 'without ▶' breakdown by date and status ---");
	const noVideo = rows.filter((r) => !r.archived_video_s3);
	const byDateStatus = new Map<string, Map<string, number>>();
	for (const r of noVideo) {
		const ds = byDateStatus.get(r.air_date) ?? new Map<string, number>();
		const s = r.video_status ?? "(null)";
		ds.set(s, (ds.get(s) ?? 0) + 1);
		byDateStatus.set(r.air_date, ds);
	}
	for (const [d, ds] of byDateStatus) {
		const parts: string[] = [];
		for (const [s, c] of ds) parts.push(`${s}=${c}`);
		console.log(`  ${d}  ${parts.join(" ")}`);
	}

	// Sample errors from failed_unsupported
	const failedSamples = rows.filter((r) => r.video_status === "failed_unsupported").slice(0, 5);
	if (failedSamples.length > 0) {
		console.log("\n--- failed_unsupported sample errors ---");
		for (const r of failedSamples) console.log(`  ${r.air_date}  cat=${r.category}  err=${r.video_error}`);
	}
}
main().catch((e) => { console.error(e); process.exit(1); });
