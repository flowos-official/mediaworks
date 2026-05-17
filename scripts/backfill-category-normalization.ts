import { normalizeCategoriesBatch } from "../lib/discovery/category-normalize";
import { getServiceClient } from "../lib/supabase";

async function main() {
	const sb = getServiceClient();
	const start = Date.now();

	console.log("Loading distinct categories from discovered_products...");
	const { data: distinctRows, error } = await sb
		.from("discovered_products")
		.select("category")
		.not("category", "is", null);
	if (error) {
		console.error("Failed to load categories:", error.message);
		process.exit(1);
	}
	const distinct = [...new Set((distinctRows ?? []).map((r) => r.category as string).filter(Boolean))];
	console.log(`  → ${distinct.length} distinct raw categories`);

	console.log("Filtering already-cached...");
	const { data: cached } = await sb
		.from("discovered_category_normalization")
		.select("raw_category");
	const cachedSet = new Set((cached ?? []).map((r) => r.raw_category as string));
	const todo = distinct.filter((c) => !cachedSet.has(c));
	console.log(`  → ${cachedSet.size} cached, ${todo.length} to classify`);

	if (todo.length === 0) {
		console.log("Nothing to do.");
		return;
	}

	console.log("Classifying via Gemini...");
	const results = await normalizeCategoriesBatch(sb, todo);

	let withMatches = 0;
	let empty = 0;
	for (const [, matches] of results) {
		if (matches.length > 0) withMatches += 1;
		else empty += 1;
	}

	console.log(JSON.stringify({
		event: "backfill-category-normalization.summary",
		distinct: distinct.length,
		previouslyCached: cachedSet.size,
		newlyClassified: results.size,
		withMatches,
		empty,
		durationMs: Date.now() - start,
	}, null, 2));
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
