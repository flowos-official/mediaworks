import { fetchMatchingBroadcastRows, computeTvEvidence } from "../lib/discovery/tv-evidence";
import { getServiceClient } from "../lib/supabase";

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
	console.error("SUPABASE_SERVICE_ROLE_KEY not set; skipping live integration test.");
	process.exit(0);
}

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${msg}`);
	}
}

async function main() {
	const sb = getServiceClient();

	// Pick a real candidate with a category and price to exercise all 3 axes.
	const { data: candidates, error } = await sb
		.from("discovered_products")
		.select("id, name, category, price_jpy")
		.not("category", "is", null)
		.not("price_jpy", "is", null)
		.limit(5);

	if (error) {
		console.error("Failed to load test candidates:", error.message);
		process.exit(1);
	}
	if (!candidates || candidates.length === 0) {
		console.error("No suitable candidates in DB — populate discovered_products first.");
		process.exit(0); // soft-skip, not fail
	}

	for (const c of candidates) {
		console.log(`\n=== Candidate: ${c.name.slice(0, 40)} (${c.category}, ¥${c.price_jpy}) ===`);
		const rows = await fetchMatchingBroadcastRows(sb, {
			name: c.name,
			category: c.category,
			price_jpy: c.price_jpy,
		});
		console.log(`  matched broadcast rows: ${rows.length}`);

		const ev = await computeTvEvidence(sb, {
			name: c.name,
			category: c.category,
			price_jpy: c.price_jpy,
		});
		if (ev === null) {
			console.log(`  evidence: null (no category match)`);
			continue;
		}
		console.log(`  airing_count=${ev.airing_count}, strength=${ev.evidence_strength}`);
		assert(ev.airing_count === rows.length, "evidence airing_count matches row count");
		assert(
			ev.evidence_strength >= 0 && ev.evidence_strength <= 1,
			"evidence_strength in [0,1]",
		);
		if (ev.price_jpy) {
			assert(ev.price_jpy.median > 0, "price median positive when present");
		}
	}

	if (process.exitCode === 1) process.exit(1);
	console.log("\nIntegration test passed.");
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
