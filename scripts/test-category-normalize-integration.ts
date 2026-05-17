import { normalizeCategory, normalizeCategoriesBatch } from "../lib/discovery/category-normalize";
import { getServiceClient } from "../lib/supabase";

if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.GEMINI_API_KEY) {
	console.error("SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY missing; skipping live test.");
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
	const fakeRaw = `__test_${Date.now()}_家電`;

	console.log(`\n=== normalizeCategory (cache miss) ===`);
	const first = await normalizeCategory(sb, fakeRaw);
	console.log(`first call result: ${JSON.stringify(first)}`);
	assert(Array.isArray(first), "returns array");

	console.log(`\n=== normalizeCategory (cache hit) ===`);
	const second = await normalizeCategory(sb, fakeRaw);
	console.log(`second call result: ${JSON.stringify(second)}`);
	assert(JSON.stringify(first) === JSON.stringify(second), "cache hit returns same result");

	console.log(`\n=== normalizeCategoriesBatch ===`);
	const batchInputs = [fakeRaw, `__test_${Date.now()}_コスメ`];
	const batch = await normalizeCategoriesBatch(sb, batchInputs);
	console.log(`batch size: ${batch.size}, entries:`, [...batch.entries()]);
	assert(batch.size === 2, "batch returns entry per distinct input");

	await sb
		.from("discovered_category_normalization")
		.delete()
		.like("raw_category", "__test_%");
	console.log(`\n=== Cleanup done ===`);

	if (process.exitCode === 1) process.exit(1);
	console.log("\nIntegration test passed.");
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
