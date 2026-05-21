/**
 * End-to-end debug: pull a real tv_channel candidate from the latest session,
 * call computeTvEvidence with the same inputs the cron uses, and print why
 * it returned null (or what evidence it actually found).
 */

import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { getServiceClient } from "@/lib/supabase";
import { computeTvEvidence, tokenizeName, __test } from "@/lib/discovery/tv-evidence";

async function main() {
	const sessionId = process.argv[2];
	if (!sessionId) {
		console.error("Usage: tsx debug-tv-evidence-runtime.ts <sessionId>");
		process.exit(1);
	}

	const sb = getServiceClient();
	const { data: rows } = await sb
		.from("discovered_products")
		.select("name, category, price_jpy, tv_channel_source, source")
		.eq("session_id", sessionId)
		.eq("source", "tv_channel")
		.limit(20);

	const candidates = rows ?? [];
	const eligibleChannels = ["japanet", "ntv", "tbs", "dinos", "senobura", "junsanpo", "uranoura", "txd"];

	for (const c of candidates) {
		const tvChannels = c.tv_channel_source?.split(",").map((s: string) => s.trim()).filter(Boolean) ?? [];
		const eligible = tvChannels.some((ch: string) => eligibleChannels.includes(ch));
		if (!eligible) continue; // skip channels without historical data

		const tokens = tokenizeName(c.name);
		console.log(`\n--- ch=${tvChannels.join(",")} ---`);
		console.log(`  name: "${c.name.slice(0, 80)}"`);
		console.log(`  category: ${c.category ?? "(null)"}`);
		console.log(`  price: ${c.price_jpy ?? "(null)"}`);
		console.log(`  tokens: ${JSON.stringify(tokens)}`);

		const ev = await computeTvEvidence(sb, {
			name: c.name,
			category: c.category ?? null,
			price_jpy: c.price_jpy ?? null,
			tv_channels: tvChannels,
		});

		if (ev) {
			console.log(`  ✓ EVIDENCE: airing_count=${ev.airing_count}, recent_30d=${ev.recent_30d_count}, channels=${JSON.stringify(ev.channel_breakdown)}`);
			console.log(`    sample[0]: [${ev.samples[0]?.channel}] ${ev.samples[0]?.title.slice(0, 60)}`);
		} else {
			console.log(`  ✗ evidence=null`);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
