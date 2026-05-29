import { derivePreviewKeyword, mergePreviewByKeyword, runFastPreviewSearch } from "@/lib/strategy/fast-preview-search";
import { emptyDiscoverIntent } from "@/lib/strategy/discover-intent";
import type { DiscoveredProduct } from "@/lib/md-strategy";

let failures = 0;
function assert(cond: boolean, msg: string) {
	if (cond) {
		console.log(`PASS: ${msg}`);
	} else {
		console.error(`FAIL: ${msg}`);
		failures++;
	}
}

// 1) specific_keyword.normalized takes priority (flag ON)
const iSpecific = emptyDiscoverIntent();
iSpecific.intent_tier = "specific_keyword";
iSpecific.specific_keyword = { raw: "包丁", normalized: "包丁", aliases: ["ナイフ"], confidence: 0.95 };
iSpecific.category_hints = ["キッチン用品"];
assert(derivePreviewKeyword(iSpecific) === "包丁", "specific_keyword.normalized wins");

// 2) category_hints[0] fallback (flag OFF — legacy prompt still fills category_hints)
const iBroad = emptyDiscoverIntent();
iBroad.category_hints = ["包丁", "三徳包丁"];
assert(derivePreviewKeyword(iBroad) === "包丁", "category_hints[0] fallback when no specific_keyword");

// 3) null when no signal
assert(derivePreviewKeyword(emptyDiscoverIntent()) === null, "null when no keyword signal");
assert(derivePreviewKeyword(undefined) === null, "null for undefined intent");

// 4) mergePreviewByKeyword: pool keyword-matches first, dedup by source_url
const pool = [
	{ name: "スーパーストーンバリア包丁", source_url: "u1" } as DiscoveredProduct,
	{ name: "EMSストレッチブーツ", source_url: "u2" } as DiscoveredProduct,
];
const fresh = [
	{ name: "三徳包丁 18cm", source_url: "u3" } as DiscoveredProduct,
	{ name: "スーパーストーンバリア包丁", source_url: "u1" } as DiscoveredProduct, // dup url
];
const merged = mergePreviewByKeyword(pool, fresh, "包丁");
assert(merged.length === 2, "merge dedups u1 → [u1, u3]");
assert(merged[0].source_url === "u1", "pool knife match placed first");
assert(!merged.some((m) => m.source_url === "u2"), "non-matching pool item not injected");

// 5) live integration (guarded on Rakuten creds)
(async () => {
	if (process.env.RAKUTEN_APPLICATION_ID && process.env.RAKUTEN_ACCESS_KEY) {
		const products = await runFastPreviewSearch({ intent: iBroad });
		assert(products.length > 0, "live Rakuten returns products for 包丁");
		const knifeish = products.filter((p) => /包丁|ナイフ|三徳|牛刀|ペティ/.test(p.name)).length;
		console.log(`[live] ${products.length} products, ${knifeish} knife-ish`);
		assert(knifeish > 0, "≥1 knife-ish product from live search");
	} else {
		console.log("SKIP live: no Rakuten creds");
	}
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
})();
