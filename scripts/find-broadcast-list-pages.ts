/**
 * Scrape navigation links on the home pages to discover where the actual
 * "broadcast list with dates" page is hidden. Look for hrefs containing
 * onair, schedule, broadcast, "今週", "今日" etc.
 */

import { politeFetch } from "@/lib/historical-crawl/fetch";
import * as cheerio from "cheerio";

const CHANNELS = [
	{ slug: "ropping", home: "https://ropping.tv-asahi.co.jp/" },
	{ slug: "ichiban", home: "https://shop.tokai-tv.com/" },
	{ slug: "kaidoki", home: "https://satv.shop/" },
	{ slug: "kantv",   home: "https://ktvolm.jp/" },
];

const INTERESTING = ["onair", "on-air", "schedule", "broadcast", "放送", "今週", "本日", "今日", "番組"];

async function main() {
	for (const c of CHANNELS) {
		console.log(`\n--- ${c.slug} ---`);
		const r = await politeFetch(c.home);
		if (!r.ok || !r.body) {
			console.log(`  HTTP ${r.status}`);
			continue;
		}
		const $ = cheerio.load(r.body);
		const matched = new Set<string>();
		$("a[href]").each((_, el) => {
			const href = $(el).attr("href") ?? "";
			const text = $(el).text().trim().slice(0, 60);
			const hayHref = href.toLowerCase();
			const hayText = text;
			const hit = INTERESTING.some((k) =>
				hayHref.includes(k.toLowerCase()) || hayText.includes(k),
			);
			if (!hit) return;
			try {
				const absolute = new URL(href, c.home).toString();
				matched.add(`${absolute}  ←  "${text}"`);
			} catch {
				// invalid url, skip
			}
		});
		const list = [...matched].slice(0, 12);
		if (list.length === 0) {
			console.log(`  no schedule-like links found on home page`);
		} else {
			for (const m of list) console.log(`  ${m}`);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
