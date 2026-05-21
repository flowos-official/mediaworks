/**
 * Audit which channels are actually persisting to historical_broadcasts
 * by date. Reveals whether cron is running, whether parsers are silently
 * failing, or whether dedup is dropping rows.
 */

import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { getServiceClient } from "@/lib/supabase";

async function main() {
	const sb = getServiceClient();

	const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
	const { data } = await sb
		.from("historical_broadcasts")
		.select("channel, air_date")
		.gte("air_date", since);

	const byChannel = new Map<string, { count: number; dates: Set<string> }>();
	for (const r of data ?? []) {
		const entry = byChannel.get(r.channel) ?? { count: 0, dates: new Set() };
		entry.count++;
		entry.dates.add(r.air_date);
		byChannel.set(r.channel, entry);
	}

	console.log(`=== historical_broadcasts coverage (last 30d, since ${since}) ===\n`);
	const expected = ["junsanpo", "ntv", "tbs", "senobura", "uranoura", "dinos", "japanet", "txd"];
	for (const ch of expected) {
		const e = byChannel.get(ch);
		if (!e) {
			console.log(`  ${ch.padEnd(10)}: 0 rows / 0 unique dates`);
		} else {
			console.log(
				`  ${ch.padEnd(10)}: ${String(e.count).padStart(4)} rows / ${e.dates.size} unique dates`,
			);
		}
	}

	// Last persisted date per channel — when did each LAST appear?
	console.log("\n=== Most recent air_date per channel (any history) ===\n");
	for (const ch of expected) {
		const { data: row } = await sb
			.from("historical_broadcasts")
			.select("air_date")
			.eq("channel", ch)
			.order("air_date", { ascending: false })
			.limit(1)
			.maybeSingle();
		console.log(`  ${ch.padEnd(10)}: ${row?.air_date ?? "(never)"}`);
	}

	// Recent crawl runs from the observability table
	console.log("\n=== Last 5 daily-historical crawl runs (per channel) ===\n");
	const { data: runs } = await sb
		.from("historical_crawl_runs")
		.select("run_at, channel_results")
		.order("run_at", { ascending: false })
		.limit(5);
	for (const r of runs ?? []) {
		console.log(`  ${r.run_at}:`);
		const cr = r.channel_results as Record<string, { ok: boolean; rowCount: number; error?: string }> | null;
		if (!cr) {
			console.log(`    (no channel_results)`);
			continue;
		}
		for (const [ch, v] of Object.entries(cr)) {
			console.log(`    ${ch.padEnd(10)} ${v.ok ? "✓" : "✗"} rows=${v.rowCount}${v.error ? ` err=${v.error.slice(0, 80)}` : ""}`);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
