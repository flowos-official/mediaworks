import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	extractNtvBicsFromSourceUrl,
	parseNtvApiImage,
	type NtvApiResponse,
} from "../lib/historical-crawl/image-extractors/ntv-api";

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${msg}`);
	}
}

function main() {
	// URL extraction
	assert(
		extractNtvBicsFromSourceUrl("https://shop.ntv.co.jp/item/5003a4010006?areaid=sptvshopping") ===
			"5003a4010006",
		"bics extracted from canonical URL",
	);
	assert(
		extractNtvBicsFromSourceUrl("https://shop.ntv.co.jp/item/5003a4010006") === "5003a4010006",
		"bics extracted from URL without query",
	);
	assert(
		extractNtvBicsFromSourceUrl("https://shop.ntv.co.jp/category/foo") === null,
		"non-item URL returns null",
	);

	// Fixture parsing
	const raw = readFileSync(
		join(process.cwd(), "scripts/fixtures/oa-images/ntv-api-sample.json"),
		"utf-8",
	);
	const body = JSON.parse(raw) as NtvApiResponse;
	const img = parseNtvApiImage(body);
	assert(typeof img === "string", `parseNtvApiImage returns string (got ${typeof img})`);
	if (typeof img === "string") {
		assert(
			img.startsWith("https://img.shop.ntv.co.jp/"),
			`image URL is on img.shop.ntv.co.jp (got ${img.slice(0, 80)})`,
		);
	}

	// Negative cases
	assert(parseNtvApiImage({} as NtvApiResponse) === null, "empty response returns null");
	assert(
		parseNtvApiImage({ itemListInfoXML: { itL: [] } } as NtvApiResponse) === null,
		"empty itL[] returns null",
	);

	if (process.exitCode) {
		console.error("\nntv-api extractor test FAILED");
		process.exit(1);
	}
	console.log("\nAll ntv-api assertions passed.");
}

main();
