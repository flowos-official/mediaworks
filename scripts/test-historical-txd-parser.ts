import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTxdResponse, type TxdApiResponse } from "../lib/historical-crawl/parsers/txd";

const FIXTURE = join(
	process.cwd(),
	"scripts/fixtures/historical-crawl/txd-2026-05-19.json",
);
const JST_DATE = "2026-05-19";

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${msg}`);
	}
}

function main() {
	const raw = readFileSync(FIXTURE, "utf-8");
	const response = JSON.parse(raw) as TxdApiResponse;
	const rows = parseTxdResponse(response, JST_DATE);

	assert(response.RSuccess === true, "fixture RSuccess is true");
	assert(rows.length >= 1, `parser returns ≥1 row (got ${rows.length})`);
	assert(
		rows.length <= (response.RCount ?? Infinity),
		`row count ≤ RCount (${rows.length} ≤ ${response.RCount})`,
	);

	const sample = rows[0];
	assert(sample.channel === "txd", "channel slug is 'txd'");
	assert(sample.air_date === JST_DATE, `air_date matches input (got ${sample.air_date})`);
	assert(sample.start_time === null, "start_time is null (API doesn't expose it)");
	assert(
		typeof sample.product_name === "string" && sample.product_name.length >= 3,
		`product_name non-empty (got "${sample.product_name}")`,
	);
	assert(
		typeof sample.source_url === "string" &&
			sample.source_url.startsWith("https://www.tv-tokyoshop.jp/detail?Gcode="),
		`source_url has expected detail-page shape (got ${sample.source_url})`,
	);
	assert(sample.source_sheet === "live-crawl:txd", "source_sheet tagged correctly");
	assert(
		sample.price_jpy === null || (Number.isInteger(sample.price_jpy) && sample.price_jpy > 0),
		`price_jpy is positive integer or null (got ${sample.price_jpy})`,
	);
	assert(
		sample.price_is_tax_incl === true || sample.price_is_tax_incl === null,
		"price_is_tax_incl is true or null",
	);

	// Defensive: short-name products should have been skipped
	const shortNames = rows.filter((r) => r.product_name.length < 3);
	assert(shortNames.length === 0, "no rows with name shorter than 3 chars");

	if (process.exitCode) {
		console.error("\nParser test failed.");
		process.exit(1);
	}
	console.log(`\nAll assertions passed (${rows.length} rows from fixture).`);
}

main();
