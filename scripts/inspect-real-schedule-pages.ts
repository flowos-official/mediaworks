/**
 * Inspect the real broadcast-list pages discovered for each channel.
 */

import { politeFetch } from "@/lib/historical-crawl/fetch";
import * as cheerio from "cheerio";

async function inspect(label: string, url: string): Promise<void> {
	console.log(`\n========== ${label} ==========`);
	console.log(`URL: ${url}`);
	const r = await politeFetch(url);
	if (!r.ok || !r.body) {
		console.log(`  HTTP ${r.status}`);
		return;
	}
	const $ = cheerio.load(r.body);
	const title = $("title").first().text().trim();
	console.log(`  title: ${title.slice(0, 80)}`);

	const text = $("body").text();
	const dateMatches = text.match(/\d{1,2}\/\d{1,2}/g) ?? [];
	const fullDateMatches = text.match(/202[4-6][-\/]\d{1,2}[-\/]\d{1,2}/g) ?? [];
	const jpDateMatches = text.match(/\d{1,2}月\d{1,2}日/g) ?? [];
	const yenMatches = text.match(/[\d,]+円|¥[\d,]+/g) ?? [];
	console.log(`  date strings: X/Y=${dateMatches.length} full=${fullDateMatches.length} 月日=${jpDateMatches.length} yen=${yenMatches.length}`);

	// Top repeating classes
	const classFreq = new Map<string, number>();
	$("[class]").each((_, el) => {
		const cls = $(el).attr("class") ?? "";
		for (const c of cls.split(/\s+/)) {
			if (!c || c.length > 50) continue;
			classFreq.set(c, (classFreq.get(c) ?? 0) + 1);
		}
	});
	const topClasses = [...classFreq.entries()]
		.filter(([, n]) => n >= 3 && n < 500)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 6);
	console.log(`  top classes:`);
	for (const [c, n] of topClasses) console.log(`    .${c} × ${n}`);

	// Look for repeated container patterns — divs/li/a with consistent class
	// First show a few sample items
	const candidateSels = ["li.item", "div.item", "div.product", "li.product", ".onair-product", ".broadcast-item"];
	for (const sel of candidateSels) {
		const ms = $(sel);
		if (ms.length > 0) {
			console.log(`\n  --- ${sel} (×${ms.length}) ---`);
			const first = $(ms[0]);
			console.log(first.html()?.slice(0, 400) ?? "");
		}
	}

	// First 400 chars of body text
	console.log(`\n  body snippet:`);
	console.log(`  ${text.replace(/\s+/g, " ").trim().slice(0, 360)}`);
}

async function main() {
	await inspect("ropping product_onair_list", "https://ropping.jp/product_onair_list");
	await inspect("kaidoki this-week category", "https://satv.shop/view/category/ct11");
	await inspect("kantv home (with date filter)", "https://ktvolm.jp/?field_onair_dates_target_id_entityreference_filter=4399");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
