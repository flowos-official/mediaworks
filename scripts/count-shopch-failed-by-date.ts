import { getServiceClient } from "../lib/supabase";

async function main(): Promise<void> {
	const sb = getServiceClient();

	for (const status of ["failed_unsupported", "archived"] as const) {
		const { data } = await sb
			.from("broadcasts")
			.select("air_date")
			.eq("channel", "shopch")
			.eq("video_status", status)
			.gte("air_date", "2026-05-01")
			.order("air_date", { ascending: false });
		const byDate = new Map<string, number>();
		for (const r of (data ?? []) as Array<{ air_date: string }>) byDate.set(r.air_date, (byDate.get(r.air_date) ?? 0) + 1);
		console.log(`\n=== ${status} (May 2026, by date) ===`);
		for (const [d, c] of byDate) console.log(`  ${d}  ${c}`);
	}
}
main().catch((e) => { console.error(e); process.exit(1); });
