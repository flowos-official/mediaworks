import { getServiceClient } from "../lib/supabase";

async function main(): Promise<void> {
	const sb = getServiceClient();
	const { data } = await sb
		.from("broadcasts")
		.select("channel, video_status, archived_video_s3")
		.gte("air_date", "2026-05-01")
		.lte("air_date", "2026-05-31");

	type Row = { channel: string; video_status: string | null; archived_video_s3: string | null };
	const rows = (data ?? []) as Row[];

	console.log(`Total May slots (broadcasts table, all channels): ${rows.length}\n`);

	const channels = new Set(rows.map((r) => r.channel));
	for (const ch of channels) {
		const subset = rows.filter((r) => r.channel === ch);
		const withVideo = subset.filter((r) => r.archived_video_s3).length;
		const noVideo = subset.length - withVideo;
		console.log(`${ch.padEnd(10)}  total=${subset.length}  withVideo=${withVideo}  noVideo=${noVideo}`);
		if (noVideo > 0) {
			const byStatus = new Map<string, number>();
			for (const r of subset.filter((x) => !x.archived_video_s3)) byStatus.set(r.video_status ?? "(null)", (byStatus.get(r.video_status ?? "(null)") ?? 0) + 1);
			for (const [s, c] of byStatus) console.log(`             - ${s}: ${c}`);
		}
	}
}
main().catch((e) => { console.error(e); process.exit(1); });
