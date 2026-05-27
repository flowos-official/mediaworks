import { getServiceClient } from "../lib/supabase";

async function main(): Promise<void> {
	const sb = getServiceClient();
	const { data } = await sb
		.from("broadcasts")
		.select("air_date, video_status")
		.eq("channel", "shopch")
		.gte("air_date", "2026-05-15")
		.lte("air_date", "2026-05-27")
		.order("air_date", { ascending: false });
	const byDateStatus = new Map<string, Map<string, number>>();
	for (const r of (data ?? []) as Array<{ air_date: string; video_status: string | null }>) {
		const key = r.air_date;
		const sub = byDateStatus.get(key) ?? new Map<string, number>();
		const s = r.video_status ?? "(null)";
		sub.set(s, (sub.get(s) ?? 0) + 1);
		byDateStatus.set(key, sub);
	}
	console.log("shopch slots by date & status (May 15-27):");
	const dates = [...byDateStatus.keys()].sort().reverse();
	for (const d of dates) {
		const sub = byDateStatus.get(d)!;
		const parts: string[] = [];
		for (const [s, c] of sub) parts.push(`${s}=${c}`);
		console.log(`  ${d}  total=${[...sub.values()].reduce((a,b)=>a+b,0)}  ${parts.join(" ")}`);
	}
}
main().catch((e) => { console.error(e); process.exit(1); });
