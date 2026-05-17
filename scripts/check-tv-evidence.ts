import { computeTvEvidence } from "../lib/discovery/tv-evidence";
import { getServiceClient } from "../lib/supabase";

async function main() {
	const id = process.argv[2];
	if (!id) {
		console.error("Usage: tsx scripts/check-tv-evidence.ts <discovered_product_id>");
		process.exit(1);
	}

	const sb = getServiceClient();
	const { data, error } = await sb
		.from("discovered_products")
		.select("id, name, category, price_jpy, tv_evidence, tv_evidence_at, tv_fit_score, tv_fit_reason")
		.eq("id", id)
		.single();

	if (error || !data) {
		console.error("Lookup failed:", error?.message ?? "not found");
		process.exit(1);
	}

	console.log(`Product: ${data.name}`);
	console.log(`  category: ${data.category}`);
	console.log(`  price_jpy: ${data.price_jpy}`);
	console.log(`  tv_fit_score: ${data.tv_fit_score}`);
	console.log(`  tv_fit_reason: ${data.tv_fit_reason}`);
	console.log(`  stored tv_evidence_at: ${data.tv_evidence_at}`);

	console.log("\nRecomputing live...");
	const fresh = await computeTvEvidence(sb, {
		name: data.name,
		category: data.category,
		price_jpy: data.price_jpy,
	});

	console.log("\nLive result:");
	console.log(JSON.stringify(fresh, null, 2));

	console.log("\nStored result:");
	console.log(JSON.stringify(data.tv_evidence, null, 2));
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
