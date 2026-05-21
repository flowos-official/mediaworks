/**
 * Print actual card HTML for ropping product_onair_list and kantv
 * filtered home page so we can write parsers.
 */

import { politeFetch } from "@/lib/historical-crawl/fetch";
import * as cheerio from "cheerio";

async function inspect(label: string, url: string, sel: string): Promise<void> {
	console.log(`\n========== ${label} ==========`);
	console.log(`URL: ${url}`);
	const r = await politeFetch(url);
	if (!r.ok || !r.body) {
		console.log(`HTTP ${r.status}`);
		return;
	}
	const $ = cheerio.load(r.body);
	const cards = $(sel);
	console.log(`Cards (${sel}): ${cards.length}\n`);
	cards.slice(0, 3).each((i, el) => {
		console.log(`--- card #${i + 1} ---`);
		console.log($.html(el).slice(0, 1200));
		console.log();
	});
}

async function main() {
	await inspect(
		"ropping product_onair_list",
		"https://ropping.jp/product_onair_list",
		".c-product-card",
	);
	await inspect(
		"kantv filtered home",
		"https://ktvolm.jp/?field_onair_dates_target_id_entityreference_filter=4399",
		".c-card",
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
