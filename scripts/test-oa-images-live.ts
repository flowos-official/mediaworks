import { ogImageExtractor } from "../lib/historical-crawl/image-extractors/og-image";
import { ntvApiExtractor } from "../lib/historical-crawl/image-extractors/ntv-api";

interface Case {
	channel: string;
	url: string;
	extractor: typeof ogImageExtractor;
}

const CASES: Case[] = [
	{ channel: "junsanpo", url: "https://ropping.jp/product/111643", extractor: ogImageExtractor },
	{ channel: "tbs", url: "https://shopping.tbs.co.jp/tbs/product/P2122145", extractor: ogImageExtractor },
	{ channel: "senobura", url: "https://shop.asahi.co.jp/item/G0032142A.html", extractor: ogImageExtractor },
	{ channel: "uranoura", url: "https://shop.asahi.co.jp/category/URANADJA/Z0032459.html", extractor: ogImageExtractor },
	{ channel: "dinos", url: "https://www.dinos.co.jp/p/1110429450/", extractor: ogImageExtractor },
	{ channel: "ntv", url: "https://shop.ntv.co.jp/item/5003a4010006", extractor: ntvApiExtractor },
];

async function main() {
	console.log(`Live image-extractor test — ${CASES.length} cases\n`);
	let failed = 0;
	for (const c of CASES) {
		const t0 = Date.now();
		try {
			const url = await c.extractor.extract(c.url);
			const ms = Date.now() - t0;
			if (typeof url === "string" && url.startsWith("https://")) {
				console.log(`✓ ${c.channel.padEnd(10)} ${ms}ms  ${url.slice(0, 80)}`);
			} else {
				console.log(`✗ ${c.channel.padEnd(10)} ${ms}ms  (got null or non-HTTPS)`);
				failed++;
			}
		} catch (e) {
			console.log(`✗ ${c.channel.padEnd(10)} threw: ${e instanceof Error ? e.message : String(e)}`);
			failed++;
		}
	}
	console.log();
	if (failed > 0) {
		console.error(`${failed}/${CASES.length} cases failed.`);
		process.exit(1);
	}
	console.log(`All ${CASES.length} cases passed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
