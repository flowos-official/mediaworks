/**
 * The boundary that keeps "stored-only" true, and the classification that
 * keeps a search result from becoming a fact.
 *
 * Three separate failures are guarded here:
 *
 *   A gap enum that accepts anything. There is deliberately no
 *   `actual_competitor_revenue`; a field that accepted the request would
 *   eventually hold a number somebody acted on.
 *
 *   A classification that flatters its source. A seller's cumulative-sales
 *   figure is a claim wherever it is printed, including on their own official
 *   page — which is exactly where it looks most like a fact.
 *
 *   An import that quietly crosses the boundary. lib/product-finder/ must not
 *   be able to reach Brave, Rakuten, or this module, and the failure mode is a
 *   per-request bill rather than an error.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	classifyObservation,
	parseSupplementRequest,
	SUPPLEMENT_GAPS,
	SupplementRequestError,
} from "../lib/intelligence/supplement/types";
import {
	extractPageFacts,
	MAX_OBSERVATIONS_PER_GAP,
	MAX_SNIPPET_CHARS,
	researchGap,
	type SupplementProviderDeps,
} from "../lib/intelligence/supplement/providers";
import { isFetchableUrl, isPrivateAddress } from "../lib/intelligence/supplement/safe-fetch";

// --- the gap enum is closed --------------------------------------------------
{
	assert.deepEqual(parseSupplementRequest({ gaps: ["current_price", "review_signal"] }), {
		gaps: ["current_price", "review_signal"],
	});
	assert.throws(
		() => parseSupplementRequest({ gaps: ["actual_competitor_revenue"] }),
		SupplementRequestError,
		"we cannot know a competitor's revenue, so we must not accept the request",
	);
	assert.throws(() => parseSupplementRequest({ gaps: [] }), SupplementRequestError);
	assert.throws(() => parseSupplementRequest({}), SupplementRequestError);
	assert.throws(() => parseSupplementRequest(null), SupplementRequestError);
	// A repeat is a duplicate request, not a second one.
	assert.deepEqual(parseSupplementRequest({ gaps: ["current_price", "current_price"] }).gaps, [
		"current_price",
	]);
	assert.equal(SUPPLEMENT_GAPS.length, 5);
}
console.log("✓ only the five allowed gaps are accepted, and an unknown one fails loudly");

// --- classification never flatters its source -------------------------------
{
	assert.equal(classifyObservation({ sourceKind: "seller", metric: "claimed_units" }), "source_claim");
	assert.equal(classifyObservation({ sourceKind: "marketplace", metric: "review_count" }), "proxy");
	assert.equal(classifyObservation({ sourceKind: "marketplace", metric: "price" }), "verified");
	assert.equal(classifyObservation({ sourceKind: "marketplace", metric: "ranking_position" }), "proxy");

	// The case that matters most: printed on the manufacturer's own page, read
	// from that page, and still a claim.
	assert.equal(
		classifyObservation({ sourceKind: "official", metric: "claimed_units", readFromPage: true }),
		"source_claim",
		"a seller's sales figure is a claim wherever it appears",
	);
	// Read from the official page → verified. Described by a search snippet → not.
	assert.equal(
		classifyObservation({ sourceKind: "official", metric: "product_spec", readFromPage: true }),
		"verified",
	);
	assert.equal(
		classifyObservation({ sourceKind: "official", metric: "product_spec" }),
		"source_claim",
		"a snippet about the official page is not the official page",
	);
	assert.equal(classifyObservation({ sourceKind: "search_snippet", metric: "product_spec" }), "source_claim");
}
console.log("✓ a claim stays a claim and only a fetched official page yields verified");

// --- one gap calls one provider ---------------------------------------------
function deps(over: Partial<SupplementProviderDeps> = {}): {
	deps: SupplementProviderDeps;
	calls: { brave: string[]; rakuten: string[]; pages: string[] };
} {
	const calls = { brave: [] as string[], rakuten: [] as string[], pages: [] as string[] };
	return {
		calls,
		deps: {
			async braveSearch(query) {
				calls.brave.push(query);
				return [
					{ title: "公式サイト", description: "累計10万台突破の人気モデル", url: "https://example.test/p" },
				];
			},
			async rakutenSearch(keyword) {
				calls.rakuten.push(keyword);
				return {
					items: [
						{
							rank: 1,
							itemName: "静音ブレンダー",
							itemPrice: 14800,
							itemCaption: "",
							itemUrl: "https://item.rakuten.co.jp/shop/x/",
							shopName: "テスト店",
							reviewCount: 0,
							reviewAverage: 0,
						},
					],
				};
			},
			async fetchPage(url) {
				calls.pages.push(url);
				return {
					finalUrl: url,
					contentType: "text/html",
					text: '<meta property="og:description" content="容量1.5L、消費電力300W">',
				};
			},
			now: () => new Date("2026-09-05T00:00:00.000Z"),
			...over,
		},
	};
}

const PRODUCT = { id: "cp-1", name: "静音ブレンダー", category: "家電" };

async function main(): Promise<void> {
	{
		const { deps: d, calls } = deps();
		const priced = await researchGap(PRODUCT, "current_price", d);
		assert.deepEqual(calls.brave, [], "a price question must not spend a web search");
		assert.equal(calls.rakuten.length, 1);
		assert.equal(priced[0]?.predicate, "marketplace_price_jpy");
		assert.equal(priced[0]?.evidenceClass, "verified");
		assert.equal(priced[0]?.unit, "JPY");
		assert.equal(priced[0]?.observedAt, "2026-09-05T00:00:00.000Z");
	}
	{
		const { deps: d, calls } = deps();
		const reviews = await researchGap(PRODUCT, "review_signal", d);
		assert.deepEqual(calls.brave, []);
		// Zero reviews is a real observation. Skipping it would make an unreviewed
		// product indistinguishable from one we never looked at.
		assert.equal(reviews[0]?.value, 0);
		assert.equal(reviews[0]?.evidenceClass, "proxy");
	}
	{
		const { deps: d, calls } = deps();
		const claims = await researchGap(PRODUCT, "seller_sales_claim", d);
		assert.deepEqual(calls.rakuten, [], "a sales claim is not a marketplace question");
		assert.equal(claims[0]?.predicate, "seller_claim");
		assert.equal(claims[0]?.evidenceClass, "source_claim");
		assert.equal(
			claims.some((c) => /actual|units_sold|revenue/.test(c.predicate)),
			false,
			"nothing here may be stored under a name that reads as a measured sale",
		);
	}
	{
		const { deps: d, calls } = deps();
		const facts = await researchGap(PRODUCT, "official_product_facts", d);
		assert.equal(calls.brave.length, 1, "Brave only locates the page");
		assert.equal(calls.pages.length, 1, "and the page is then actually read");
		assert.equal(facts[0]?.evidenceClass, "verified");
		assert.equal(facts[0]?.value, "容量1.5L、消費電力300W");
		assert.equal(facts[0]?.sourceType, "official_site");
	}
	console.log("✓ each gap calls exactly the provider it needs");

	// --- an unreadable page degrades to a claim, it does not fail the gap ----
	{
		const { deps: d } = deps({
			fetchPage: async () => {
				throw new Error("refusing to fetch a non-public address");
			},
		});
		const facts = await researchGap(PRODUCT, "official_product_facts", d);
		assert.equal(facts.length, 1);
		assert.equal(
			facts[0].evidenceClass,
			"source_claim",
			"if we could not read the page, we did not verify anything",
		);
		assert.equal(facts[0].sourceType, "brave_result");
	}
	console.log("✓ a page we could not read yields a claim, never a verified fact");

	// --- caps hold ----------------------------------------------------------
	{
		const many = Array.from({ length: 40 }, (_, i) => ({
			rank: i + 1,
			itemName: `item ${i}`,
			itemPrice: 1000 + i,
			itemCaption: "",
			itemUrl: `https://item.rakuten.co.jp/shop/${i}/`,
			shopName: "s",
			reviewCount: i,
			reviewAverage: 4,
		}));
		const { deps: d } = deps({ rakutenSearch: async () => ({ items: many }) });
		const out = await researchGap(PRODUCT, "current_price", d);
		assert.ok(out.length <= MAX_OBSERVATIONS_PER_GAP, "a gap must not return an unbounded list");

		const long = "あ".repeat(5000);
		const { deps: d2 } = deps({
			braveSearch: async () => [{ title: "累計", description: long, url: "https://example.test/x" }],
		});
		const claims = await researchGap(PRODUCT, "seller_sales_claim", d2);
		assert.ok(
			String(claims[0]?.value).length <= MAX_SNIPPET_CHARS,
			"a snippet longer than the cap is somebody else's page, not context",
		);
	}
	console.log("✓ observation count and snippet length are both capped");

	// --- a non-HTTP URL never becomes an observation -------------------------
	{
		const { deps: d } = deps({
			braveSearch: async () => [
				{ title: "累計突破", description: "累計10万台", url: "javascript:alert(1)" },
				{ title: "累計突破", description: "累計10万台", url: "file:///etc/passwd" },
			],
		});
		assert.deepEqual(await researchGap(PRODUCT, "seller_sales_claim", d), []);
	}
	console.log("✓ non-HTTP result URLs are dropped before anything is stored");

	console.log("PASS: supplemental provider contract");
}

// --- SSRF address rules -----------------------------------------------------
{
	for (const address of [
		"127.0.0.1",
		"169.254.169.254", // cloud metadata
		"::ffff:169.254.169.254", // the same, IPv4-mapped
		"10.0.0.5",
		"172.16.0.1",
		"192.168.1.1",
		"::1",
		"fc00::1",
		"fe80::1",
		"0.0.0.0",
		"100.64.0.1",
		"not-an-ip",
	]) {
		assert.equal(isPrivateAddress(address), true, `${address} must be refused`);
	}
	for (const address of ["1.1.1.1", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) {
		assert.equal(isPrivateAddress(address), false, `${address} is publicly routable`);
	}
	assert.equal(isFetchableUrl("https://example.test/a"), true);
	assert.equal(isFetchableUrl("http://example.test/a"), true);
	assert.equal(isFetchableUrl("file:///etc/passwd"), false);
	assert.equal(isFetchableUrl("gopher://x/"), false);
	// Credentials in a URL to a page a search engine found are never legitimate.
	assert.equal(isFetchableUrl("https://user:pw@example.test/"), false);
}
console.log("✓ loopback, link-local, private and mapped addresses are all refused");

// --- page extraction is crude on purpose ------------------------------------
{
	const facts = extractPageFacts(
		'<html><head><title>商品 &amp; 仕様</title><meta name="description" content="容量1.5L"></head></html>',
	);
	assert.equal(facts.title, "商品 & 仕様");
	assert.equal(facts.description, "容量1.5L");
	// A page that supplies nothing yields nothing, not an empty-looking fact.
	assert.deepEqual(extractPageFacts("<html></html>"), { title: "", description: "" });
}
console.log("✓ page extraction reads meta values and invents nothing");

// --- the stored-only modules cannot reach a provider ------------------------
{
	const strip = (source: string): string =>
		source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	for (const file of [
		"lib/product-finder/candidates.ts",
		"lib/product-finder/ranking.ts",
		"lib/product-finder/run.ts",
		"lib/product-finder/request.ts",
	]) {
		const source = strip(readFileSync(file, "utf8"));
		for (const forbidden of ["@/lib/brave", "@/lib/rakuten", "intelligence/supplement", "fetch("]) {
			assert.equal(
				source.includes(forbidden),
				false,
				`${file} must not reference ${forbidden} — stored-only means no provider is reachable from here`,
			);
		}
	}
	// And the reverse: the external imports live in exactly one file.
	const providers = strip(readFileSync("lib/intelligence/supplement/providers.ts", "utf8"));
	assert.ok(providers.includes("@/lib/brave") && providers.includes("@/lib/rakuten"));
	const runService = "lib/intelligence/supplement/run.ts";
	try {
		const source = strip(readFileSync(runService, "utf8"));
		for (const forbidden of ["@/lib/brave", "@/lib/rakuten"]) {
			assert.equal(
				source.includes(forbidden),
				false,
				`${runService} must go through providers.ts, not import a provider directly`,
			);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}
console.log("✓ no stored-only module can reach a provider, and providers.ts is the only one that does");

main().catch((error) => {
	console.error("FAIL:", error);
	process.exit(1);
});
