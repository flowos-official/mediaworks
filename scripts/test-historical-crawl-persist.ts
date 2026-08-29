import assert from "node:assert/strict";
import {
	__test,
	createHistoricalPersistenceRepository,
	persistRows,
	type HistoricalPersistenceRepository,
} from "../lib/historical-crawl/persist";
import type { HistoricalRow } from "../lib/historical-crawl/types";
import type { SupabaseClient } from "@supabase/supabase-js";

const rows: HistoricalRow[] = [
	{ channel: "japanet", air_date: "2026-08-29", product_name: "new", day_of_week: null, start_time: null, price_text: null, price_jpy: null, price_is_tax_incl: null, source_url: null, source_sheet: "test", image_url: null },
	{ channel: "ntv", air_date: "2026-08-29", product_name: "existing", day_of_week: null, start_time: null, price_text: null, price_jpy: null, price_is_tax_incl: null, source_url: null, source_sheet: "test", image_url: null },
];

async function main() {
const split = __test.splitRowsByExistingKeys(rows, new Set([JSON.stringify(["ntv", "2026-08-29", "existing"])]));
assert.equal(split.inserted, 1);
assert.equal(split.updated, 1);

{
	const longName = "x".repeat(500);
	const filters: Array<{ column: string; values: string[] }> = [];
	const query = {
		select() { return this; },
		in(column: string, values: string[]) { filters.push({ column, values }); return this; },
		order() { return this; },
		range: async () => ({ data: [], error: null }),
	};
	const supabase = { from: () => query };
	const repository = createHistoricalPersistenceRepository(supabase as unknown as SupabaseClient);
	await repository.findExistingRows({ channels: ["ntv"], airDates: ["2026-08-29"] });
	assert.ok(filters.every((filter) => !filter.values.includes(longName)));
	assert.deepEqual(filters, [
		{ column: "channel", values: ["ntv"] },
		{ column: "air_date", values: ["2026-08-29"] },
	]);
	console.log("✓ existing-row lookup filters stay compact when product names are 500 characters");
}

{
	let upsertAttempts = 0;
	const unavailable: HistoricalPersistenceRepository = {
		findExistingRows: async () => { throw new Error("classification unavailable"); },
		upsert: async () => { upsertAttempts++; return { count: 1 }; },
	};
	const outcome = await persistRows(rows, unavailable);
	assert.equal(upsertAttempts, 0);
	assert.deepEqual(outcome, {
		upserted: 0,
		inserted: 0,
		updated: 0,
		skippedDuplicate: 0,
		errors: 2,
		firstError: "classification unavailable",
	});
	console.log("✓ unavailable classification records truthful failures without attempting an unclassified upsert");
}

console.log("PASS: historical persistence distinguishes inserted and updated conflict rows");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
