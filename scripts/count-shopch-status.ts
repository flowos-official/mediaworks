import { getServiceClient } from "../lib/supabase";

async function main(): Promise<void> {
	const sb = getServiceClient();
	const statuses = ["archived", "queued", "downloading", "failed_unsupported", "deferred", "abandoned"];
	console.log("shopch video_status counts (all-time):");
	for (const s of statuses) {
		const { count } = await sb.from("broadcasts").select("*", { count: "exact", head: true }).eq("channel", "shopch").eq("video_status", s);
		console.log(`  ${s.padEnd(22)} ${count}`);
	}
	const { data } = await sb.from("broadcasts").select("air_date").eq("channel", "shopch").eq("video_status", "archived").order("air_date", { ascending: false });
	const byDate = new Map<string, number>();
	for (const r of (data ?? []) as Array<{ air_date: string }>) byDate.set(r.air_date, (byDate.get(r.air_date) ?? 0) + 1);
	console.log("\narchived by date (top 15):");
	let i = 0;
	for (const [d, c] of byDate) {
		console.log(`  ${d}  ${c}`);
		if (++i >= 15) break;
	}
}
main().catch((e) => { console.error(e); process.exit(1); });
