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
	const batchRaw = `__test_${Date.now()}_コスメ`;

	console.log(`\n=== normalizeCategory (cache miss) ===`);
	const first = await normalizeCategory(sb, fakeRaw);
	console.log(`first call result: ${JSON.stringify(first)}`);
	assert(Array.isArray(first), "returns array");

	const firstPersisted = await sb
		.from("discovered_category_normalization")
		.select("raw_category, whitelist_categories")
		.eq("raw_category", fakeRaw)
		.maybeSingle();
	assert(!firstPersisted.error, `cache row can be read after normalizeCategory: ${firstPersisted.error?.message ?? ""}`);
	assert(
		firstPersisted.data?.raw_category === fakeRaw,
		"normalizeCategory persists a cache row for the raw category",
	);
	assert(
		JSON.stringify(firstPersisted.data?.whitelist_categories ?? []) === JSON.stringify(first),
		"persisted whitelist categories match normalizeCategory result",
	);

	console.log(`\n=== normalizeCategory (cache hit) ===`);
	const second = await normalizeCategory(sb, fakeRaw);
	console.log(`second call result: ${JSON.stringify(second)}`);
	assert(JSON.stringify(first) === JSON.stringify(second), "cache hit returns same result");

	console.log(`\n=== normalizeCategoriesBatch ===`);
	const batchInputs = [fakeRaw, batchRaw];
	const batch = await normalizeCategoriesBatch(sb, batchInputs);
	console.log(`batch size: ${batch.size}, entries:`, [...batch.entries()]);
	assert(batch.size === 2, "batch returns entry per distinct input");

	const batchPersisted = await sb
		.from("discovered_category_normalization")
		.select("raw_category, whitelist_categories")
		.in("raw_category", batchInputs);
	assert(!batchPersisted.error, `batch cache rows can be read: ${batchPersisted.error?.message ?? ""}`);
	const persistedRaw = new Set((batchPersisted.data ?? []).map((row) => row.raw_category));
	assert(persistedRaw.has(fakeRaw), "batch keeps the existing cache row");
	assert(persistedRaw.has(batchRaw), "normalizeCategoriesBatch persists newly classified raw categories");

	const cleanup = await sb
		.from("discovered_category_normalization")
		.delete()
		.like("raw_category", "__test_%");
	assert(!cleanup.error, `cleanup removes test cache rows: ${cleanup.error?.message ?? ""}`);
	console.log(`\n=== Cleanup done ===`);

	if (process.exitCode === 1) process.exit(1);
	console.log("\nIntegration test passed.");
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
