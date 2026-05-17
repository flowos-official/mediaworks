/**
 * Quick diagnostic: row count per channel for a given date in historical_broadcasts.
 * Usage:
 *   tsx --env-file=.env.local scripts/check-historical-by-date.ts 2026-05-10
 */
import { getServiceClient } from "../lib/supabase";

const date = process.argv[2];
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
	console.error("Usage: check-historical-by-date.ts YYYY-MM-DD");
	process.exit(1);
}

(async () => {
	const sb = getServiceClient();
	const { data, error, count } = await sb
		.from("historical_broadcasts")
		.select("channel", { count: "exact" })
		.eq("air_date", date);
	if (error) {
		console.error("error:", error.message);
		process.exit(1);
	}
	console.log(`Total rows for ${date}: ${count}`);
	const byChannel = new Map<string, number>();
	for (const row of (data ?? []) as { channel: string }[]) {
		byChannel.set(row.channel, (byChannel.get(row.channel) ?? 0) + 1);
	}
	console.log("By channel:");
	for (const [ch, n] of byChannel) console.log(`  ${ch.padEnd(12)} ${n}`);
})();
