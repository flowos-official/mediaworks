/**
 * Deeper inspection of kaidoki and kantv schedule pages — print actual
 * HTML of the schedule-bearing containers so we can write parsers.
 */

import { politeFetch } from "@/lib/historical-crawl/fetch";
import * as cheerio from "cheerio";

async function inspect(label: string, url: string, selectors: string[]): Promise<void> {
	console.log(`\n========== ${label}: ${url} ==========`);
	const r = await politeFetch(url);
	if (!r.ok || !r.body) {
		console.log(`HTTP ${r.status}`);
		return;
	}
	const $ = cheerio.load(r.body);
	for (const sel of selectors) {
		const matches = $(sel);
		console.log(`\n  Selector: ${sel}  → ${matches.length} matches`);
		matches.slice(0, 2).each((_, el) => {
			const html = $.html(el);
			console.log(`  --- sample ---`);
			console.log(html.slice(0, 700));
		});
	}
}

async function main() {
	await inspect("kaidoki home", "https://satv.shop/", [
		".monday",
		".sunday",
		"table",
		"[class*='broadcast']",
		"[class*='onair']",
		"[class*='schedule']",
	]);

	await inspect("kantv home", "https://ktvolm.jp/", [
		".c-card",
		"[class*='onair']",
		"[class*='broadcast']",
		"[class*='schedule']",
		"[class*='date']",
	]);

	// Also try potential onair sub-pages
	await inspect("kaidoki onair-product-listing", "https://satv.shop/p/onair?q=&category_id=&sale=", []);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
