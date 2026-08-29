import assert from "node:assert/strict";
import { __test } from "../lib/historical-crawl/persist";
import type { HistoricalRow } from "../lib/historical-crawl/types";

const rows: HistoricalRow[] = [
	{ channel: "japanet", air_date: "2026-08-29", product_name: "new", day_of_week: null, start_time: null, price_text: null, price_jpy: null, price_is_tax_incl: null, source_url: null, source_sheet: "test", image_url: null },
	{ channel: "ntv", air_date: "2026-08-29", product_name: "existing", day_of_week: null, start_time: null, price_text: null, price_jpy: null, price_is_tax_incl: null, source_url: null, source_sheet: "test", image_url: null },
];

const split = __test.splitRowsByExistingKeys(rows, new Set([JSON.stringify(["ntv", "2026-08-29", "existing"])]));
assert.equal(split.inserted, 1);
assert.equal(split.updated, 1);
console.log("PASS: historical persistence distinguishes inserted and updated conflict rows");
