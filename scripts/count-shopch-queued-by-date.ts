import { getServiceClient } from "../lib/supabase";

async function main(): Promise<void> {
	const sb = getServiceClient();

	for (const status of ["queued", "downloading"] as const) {
		const { data } = await sb
			.from("broadcasts")
			.select("air_date, start_time")
			.eq("channel", "shopch")
			.eq("video_status", status)
			.order("air_date", { ascending: false })
			.order("start_time", { ascending: true });
		const byDate = new Map<string, number>();
		for (const r of (data ?? []) as Array<{ air_date: string; start_time: string }>) byDate.set(r.air_date, (byDate.get(r.air_date) ?? 0) + 1);
		console.log(`\n=== ${status} (by date) ===`);
		for (const [d, c] of byDate) console.log(`  ${d}  ${c}`);
	}
}
main().catch((e) => { console.error(e); process.exit(1); });
