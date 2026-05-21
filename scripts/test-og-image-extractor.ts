import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseOgImageFromHtml } from "../lib/historical-crawl/image-extractors/og-image";

interface Case {
	name: string;
	html: string;
	sourceUrl: string;
	expectedHost: string;
}

function load(channel: string, sourceUrl: string, expectedHost: string): Case {
	const html = readFileSync(
		join(process.cwd(), `scripts/fixtures/oa-images/${channel}-sample.html`),
		"utf-8",
	);
	return { name: channel, html, sourceUrl, expectedHost };
}

// Source URLs mirror real `historical_broadcasts.source_url` values per channel.
// Note junsanpo product detail pages live on ropping.jp (テレ朝じゅん散歩's e-commerce host).
const CASES: Case[] = [
	load("junsanpo", "https://ropping.jp/product/111643", "ropping.jp"),
	load("tbs", "https://shopping.tbs.co.jp/tbs/product/P2122145", "shopping.tbs.co.jp"),
	load("senobura", "https://shop.asahi.co.jp/item/G0032142A.html", "shop.asahi.co.jp"),
	load("uranoura", "https://shop.asahi.co.jp/category/URANADJA/Z0032459.html", "shop.asahi.co.jp"),
	load("dinos", "https://www.dinos.co.jp/p/1110429450/", "dinos.co.jp"),
];

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${msg}`);
	}
}

function main() {
	for (const c of CASES) {
		const url = parseOgImageFromHtml(c.html, c.sourceUrl);
		assert(typeof url === "string", `${c.name}: extractor returns string (got ${typeof url})`);
		if (typeof url === "string") {
			assert(url.startsWith("https://"), `${c.name}: URL is absolute HTTPS (got ${url.slice(0, 60)}...)`);
			assert(url.includes(c.expectedHost), `${c.name}: URL contains expected host '${c.expectedHost}' (got ${url.slice(0, 80)})`);
		}
	}

	// Negative case: HTML without og:image
	const empty = parseOgImageFromHtml("<html><head></head><body>no meta</body></html>", "https://example.com/p/1");
	assert(empty === null, `no og:image returns null (got ${empty})`);

	// Negative case: og:image present but content is empty
	const emptyContent = parseOgImageFromHtml(
		'<html><head><meta property="og:image" content=""></head></html>',
		"https://example.com/p/1",
	);
	assert(emptyContent === null, `empty og:image content returns null (got ${emptyContent})`);

	// Negative case: javascript: URL must be rejected
	const jsUrl = parseOgImageFromHtml(
		'<html><head><meta property="og:image" content="javascript:void(0)"></head></html>',
		"https://example.com/p/1",
	);
	assert(jsUrl === null, `javascript: URL is rejected (got ${jsUrl})`);

	if (process.exitCode) {
		console.error("\nog-image extractor test FAILED");
		process.exit(1);
	}
	console.log("\nAll og-image assertions passed.");
}

main();
