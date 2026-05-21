/**
 * Fetch likely schedule pages for 4 new channels and report findings:
 * - HTTP status
 * - title
 * - count of date-like strings (5/21, 2026-05-21 etc.)
 * - count of yen-price strings
 * - sample of repeating selectors
 */

import { politeFetch } from "@/lib/historical-crawl/fetch";
import * as cheerio from "cheerio";

const TARGETS = [
	{ slug: "ropping",  urls: ["https://ropping.tv-asahi.co.jp/onair/", "https://ropping.tv-asahi.co.jp/"] },
	{ slug: "ichiban",  urls: ["https://shop.tokai-tv.com/", "https://shop.tokai-tv.com/onair"] },
	{ slug: "kaidoki",  urls: ["https://satv.shop/", "https://satv.shop/p/onair"] },
	{ slug: "kantv",    urls: ["https://ktvolm.jp/", "https://ktvolm.jp/onair"] },
];

async function inspect(url: string): Promise<void> {
	console.log(`\n--- ${url} ---`);
	const r = await politeFetch(url);
	if (!r.ok || !r.body) {
		console.log(`  HTTP ${r.status} (no body or fetch failed)`);
		return;
	}
	const $ = cheerio.load(r.body);
	const title = $("title").first().text().trim().slice(0, 80);
	console.log(`  status: ${r.status}, title: "${title}"`);

	const text = $("body").text();
	const dateMatches = text.match(/\d{1,2}\/\d{1,2}/g) ?? [];
	const yenMatches = text.match(/¥[\d,]+|￥[\d,]+|[\d,]+円/g) ?? [];
	console.log(`  date-like strings (X/Y): ${dateMatches.length}`);
	console.log(`  yen prices:               ${yenMatches.length}`);

	// Look for table-like grid containers
	const tables = $("table").length;
	const articles = $("article").length;
	const listItems = $("li").length;
	console.log(`  <table>=${tables}, <article>=${articles}, <li>=${listItems}`);

	// Top repeating class names
	const classFreq = new Map<string, number>();
	$("[class]").each((_, el) => {
		const cls = $(el).attr("class") ?? "";
		for (const c of cls.split(/\s+/)) {
			if (!c || c.length > 60) continue;
			classFreq.set(c, (classFreq.get(c) ?? 0) + 1);
		}
	});
	const topClasses = [...classFreq.entries()]
		.filter(([, n]) => n >= 5 && n < 1000)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 8);
	console.log(`  top repeating classes:`);
	for (const [c, n] of topClasses) console.log(`    .${c} × ${n}`);

	// Time-like patterns
	const timeMatches = text.match(/\d{1,2}:\d{2}/g) ?? [];
	console.log(`  time-like strings: ${timeMatches.length}`);

	// Print first 200 chars of body for first sniff
	const bodySnippet = text.replace(/\s+/g, " ").trim().slice(0, 280);
	console.log(`  body snippet: ${bodySnippet}`);
}

async function main() {
	for (const t of TARGETS) {
		console.log(`\n\n============ ${t.slug.toUpperCase()} ============`);
		for (const u of t.urls) {
			try {
				await inspect(u);
			} catch (err) {
				console.log(`  ! ${err instanceof Error ? err.message : err}`);
			}
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
