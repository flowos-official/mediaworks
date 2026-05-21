/**
 * Prototype: for 10 distinct May product names, try to find the japanet image
 * via Brave site:search + page fetch.
 *
 * Pipeline per name:
 *   1. Extract a search key (model number or short name) from product_name
 *   2. Brave site:search → take top result URL
 *   3. Fetch that URL (allow JS-rendered content via cheerio's static HTML —
 *      we observed that catslist pages have empty product lists for retired
 *      items, so success is hit-or-miss)
 *   4. Scan the page for any `img.japanet.co.jp/shopping/simg/{key}-l.jpg` URL
 *      OR for embedded doRefer() call that yields a c_skucd
 *   5. Optionally HEAD-check the constructed image URL to confirm it loads
 *
 * Output: success/failure per name with reason; final success rate.
 */

import { getServiceClient } from "@/lib/supabase";
import { braveSearchItems } from "@/lib/brave";
import { politeFetch } from "@/lib/historical-crawl/fetch";
import { parseDoReferImageKey } from "@/lib/historical-crawl/parsers/japanet";

interface ProbeResult {
	name: string;
	key: string;
	braveUrl: string | null;
	imageUrl: string | null;
	imageOk: boolean;
	reason: string;
}

/**
 * Extract a search key. Most japanet product_names end with a model number in
 * a recognizable shape (e.g., HD-AC2U12WH, RAS-U281DXT(W), AY-T28TD2, TZPS009).
 * Strategy: take the trailing all-CAPS+digits token; if none, take last 2 tokens.
 */
function extractSearchKey(name: string): string {
	const cleaned = name.replace(/^\[\d+\]\s*/, "").trim();
	// Try trailing model number (uppercase letters + digits + dashes, may have parens)
	const tokens = cleaned.split(/[\s　]+/);
	for (let i = tokens.length - 1; i >= 0; i--) {
		const t = tokens[i].replace(/[（）()]/g, "");
		if (/^[A-Z][A-Z0-9-]{3,}$/.test(t) || /^[A-Z]{2,}-[A-Z0-9]+/.test(t)) {
			return t;
		}
	}
	// Fallback: last 2 tokens
	return tokens.slice(-2).join(" ");
}

async function probeName(name: string): Promise<ProbeResult> {
	const key = extractSearchKey(name);

	let braveUrl: string | null = null;
	try {
		const results = await braveSearchItems(`${key} site:japanet.co.jp`, 5);
		// Prefer catslist URLs over swd (search-within-domain) URLs
		const first = results.find((r) => /\/catslist\/|\/catdetail\//.test(r.url)) ?? results[0];
		braveUrl = first?.url ?? null;
	} catch (e) {
		return { name, key, braveUrl: null, imageUrl: null, imageOk: false, reason: `brave: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (!braveUrl) {
		return { name, key, braveUrl: null, imageUrl: null, imageOk: false, reason: "no brave results" };
	}

	// Fetch page
	const r = await politeFetch(braveUrl);
	if (!r.ok || !r.body) {
		return { name, key, braveUrl, imageUrl: null, imageOk: false, reason: `fetch failed: ${r.error ?? "no body"}` };
	}

	// Try 1: doRefer in the HTML (most reliable)
	const drMatches = Array.from(r.body.matchAll(/onclick="doRefer\(([^)]+)\)/g));
	for (const dm of drMatches) {
		const key2 = parseDoReferImageKey(`doRefer(${dm[1]})`);
		if (key2) {
			const url = `https://img.japanet.co.jp/shopping/simg/${key2.c_skucd}-${key2.c_color}-${key2.c_size}-l.jpg`;
			// HEAD check
			const head = await politeFetch(url, { retry: false });
			if (head.ok) {
				return { name, key, braveUrl, imageUrl: url, imageOk: true, reason: "doRefer match" };
			}
		}
	}

	// Try 2: direct simg URL in the HTML
	const simgMatch = r.body.match(/https?:\/\/img\.japanet\.co\.jp\/shopping\/simg\/([\w-]+)-l\.jpg/);
	if (simgMatch) {
		const url = `https://img.japanet.co.jp/shopping/simg/${simgMatch[1]}-l.jpg`;
		const head = await politeFetch(url, { retry: false });
		if (head.ok) {
			return { name, key, braveUrl, imageUrl: url, imageOk: true, reason: "simg in HTML" };
		}
	}

	// Try 3: URL itself contains a product id (PDW0C3000054 style) — see if there's an analyze.do reference
	const analyzeMatch = r.body.match(/product=(\w+)/);
	if (analyzeMatch) {
		return { name, key, braveUrl, imageUrl: null, imageOk: false, reason: `found analyze product=${analyzeMatch[1]} but no simg derivable` };
	}

	return { name, key, braveUrl, imageUrl: null, imageOk: false, reason: "no image found in page (likely retired listing)" };
}

(async () => {
	const sb = getServiceClient();
	const { data } = await sb
		.from("historical_broadcasts")
		.select("product_name")
		.eq("channel", "japanet")
		.gte("air_date", "2026-05-01")
		.lte("air_date", "2026-05-31");
	const unique = Array.from(new Set((data ?? []).map((r) => r.product_name)));
	console.log(`Distinct May names: ${unique.length}. Probing first 10.\n`);

	const SAMPLE_SIZE = 10;
	const sample = unique.slice(0, SAMPLE_SIZE);
	const results: ProbeResult[] = [];
	for (const name of sample) {
		const t0 = Date.now();
		const r = await probeName(name);
		const ms = Date.now() - t0;
		const status = r.imageOk ? "✓" : "✗";
		console.log(`${status} ${ms}ms  key="${r.key}"`);
		console.log(`    name=${name.slice(0, 70)}`);
		console.log(`    brave=${r.braveUrl?.slice(0, 90) ?? "(none)"}`);
		console.log(`    image=${r.imageUrl ?? "(none)"} — ${r.reason}\n`);
		results.push(r);
	}

	const ok = results.filter((r) => r.imageOk).length;
	const pct = ((ok / results.length) * 100).toFixed(0);
	console.log(`=== Prototype result: ${ok}/${results.length} (${pct}%) ===`);
})();
