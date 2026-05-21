/**
 * Debug: for each tv_channel candidate in the latest session, attempt the
 * channel-keyed tv_evidence lookup and report why it returns no rows.
 */

import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { getServiceClient } from "@/lib/supabase";
import { tokenizeName } from "@/lib/discovery/tv-evidence";

async function main() {
	const sessionId = process.argv[2];
	if (!sessionId) {
		console.error("Usage: tsx debug-tv-evidence-channel.ts <sessionId>");
		process.exit(1);
	}

	const sb = getServiceClient();

	const { data: rows } = await sb
		.from("discovered_products")
		.select("name, tv_channel_source")
		.eq("session_id", sessionId)
		.eq("source", "tv_channel");

	for (const r of rows ?? []) {
		const channels = r.tv_channel_source?.split(",") ?? [];
		const tokens = tokenizeName(r.name);
		console.log(`\n--- "${r.name.slice(0, 70)}" ---`);
		console.log(`  channels: ${channels.join(",")}`);
		console.log(`  name tokens: ${JSON.stringify(tokens)}`);

		if (tokens.length === 0) {
			console.log(`  ✗ no tokenized name (would skip)`);
			continue;
		}

		// Channel intersect with historical_broadcasts coverage
		const historicalChannels = channels.filter(
			(c: string) => !["shopch", "qvc"].includes(c),
		);
		if (historicalChannels.length === 0) {
			console.log(`  ✗ no channel covered by historical_broadcasts`);
			continue;
		}

		// Try the actual query — name-tokens ILIKE OR'd against product_name
		const orClause = tokens
			.map((t) => `product_name.ilike.%${t}%`)
			.join(",");
		const { data: hits } = await sb
			.from("historical_broadcasts")
			.select("channel, air_date, product_name")
			.in("channel", historicalChannels)
			.gte("air_date", new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10))
			.or(orClause)
			.limit(5);

		const matchCount = hits?.length ?? 0;
		if (matchCount === 0) {
			console.log(`  ✗ 0 rows in historical_broadcasts for channels=${historicalChannels.join(",")} matching tokens`);
		} else {
			console.log(`  ✓ ${matchCount} matches:`);
			for (const h of hits!) {
				console.log(`    [${h.channel} ${h.air_date}] ${h.product_name.slice(0, 60)}`);
			}
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
