import assert from "node:assert/strict";
import {
	formatMultiSeedPromptSection,
	type SeedContext,
} from "@/lib/strategy/seed-context";

function mkSeed(id: string, name: string, category: string): SeedContext {
	return {
		id,
		name,
		priceJpy: 12000,
		category,
		reviewCount: 50,
		reviewAvg: 4.3,
		sellerName: "test",
		productUrl: `https://example.com/${id}`,
		tvFitScore: 70,
		tvFitReason: "test reason",
		context: "home_shopping",
		broadcastTag: "unknown",
	};
}

// Empty input → empty string.
assert.equal(formatMultiSeedPromptSection([]), "", "empty seeds → empty string");

// Single seed → falls back to old single-seed section header.
{
	const txt = formatMultiSeedPromptSection([mkSeed("a", "Product A", "美容")]);
	assert.ok(txt.includes("Product A"), "single seed: name present");
	assert.ok(txt.includes("新商品候補データ"), "single seed: header present");
}

// Multi-seed → comparison block with all seed names + count.
{
	const txt = formatMultiSeedPromptSection([
		mkSeed("a", "Product A", "美容"),
		mkSeed("b", "Product B", "キッチン"),
		mkSeed("c", "Product C", "美容"),
	]);
	assert.ok(txt.includes("Product A"), "multi: A present");
	assert.ok(txt.includes("Product B"), "multi: B present");
	assert.ok(txt.includes("Product C"), "multi: C present");
	assert.ok(txt.includes("3件"), "multi: count rendered");
	assert.ok(txt.includes("複数候補比較"), "multi: comparison header");
}

console.log("PASS: multi-seed formatter");
