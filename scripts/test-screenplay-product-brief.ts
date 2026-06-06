/**
 * Unit test for buildProductBriefFromRows. Feeds research fields in the REAL
 * shapes the Gemini research schema produces (lib/gemini.ts ResearchOutput):
 *   - broadcast_scripts: { sec30, sec60, min5 }   (object, NOT string[])
 *   - marketing_strategy: [{ strategy_name, type, ... }]  (object[], NOT string[])
 *   - pricing_strategy:   { channel_pricing[], bep_analysis }  (object)
 * These must be serialized into the brief; the previous test used fictional
 * string[] shapes and so never caught the object fields silently dropping out.
 * Pure (no DB). Run: npm run test:screenplay-product-brief
 */
import { buildProductBriefFromRows, isUuid } from "../lib/screenplay/product-brief";

function assert(condition: boolean, message: string) {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		process.exitCode = 1;
	} else {
		console.log(`PASS: ${message}`);
	}
}

const brief = buildProductBriefFromRows({
	product: {
		id: "11111111-1111-4111-8111-111111111111",
		name: "調理家電サンプル",
		description: "忙しい家庭向けの時短調理家電。",
		category: "家電",
		price_range: "¥12,000〜¥16,000",
		target_market: "40代以上の共働き世帯",
		features: ["自動調理", "省スペース"],
		discovered_product_id: "22222222-2222-4222-8222-222222222222",
	},
	research: {
		marketability_description: "テレビ通販では実演性が高く、季節を問わず訴求できる。",
		recommended_price_range: "¥14,800",
		demographics: { primary: "家事時間を短縮したい層" },
		// Real Gemini shapes (the bug was these being silently dropped):
		broadcast_scripts: {
			sec30: "30秒台本サンプル",
			sec60: "60秒台本サンプル",
			min5: "5分台本サンプル",
		},
		marketing_strategy: [
			{ strategy_name: "実演デモ中心", type: "TV", efficiency_score: 9 },
			{ strategy_name: "家事負担軽減訴求", type: "SNS", efficiency_score: 7 },
		],
		pricing_strategy: {
			channel_pricing: [
				{ channel: "QVC", recommended_price: "¥14,800", estimated_margin_pct: 45, reason: "" },
			],
			bep_analysis: { summary: "月500個で黒字化" },
		},
		raw_json: null,
	},
	discoveredProduct: {
		c_package: {
			manufacturer: "Sample Factory",
			wholesale_estimate: "¥6,000前後",
			tv_script: "湯気と完成シーンを強調",
		},
	},
});

assert(brief.name === "調理家電サンプル", "uses product name");
assert(brief.category === "家電", "uses product category");
assert(brief.description.includes("忙しい家庭向け"), "includes product description");
assert(brief.description.includes("テレビ通販では実演性"), "includes research marketability");

// REAL-shape assertions — these are the ones the old string[]-shaped test missed:
assert(brief.description.includes("30秒台本サンプル"), "serializes broadcast_scripts object (sec30)");
assert(brief.description.includes("5分台本サンプル"), "serializes broadcast_scripts object (min5)");
assert(brief.description.includes("実演デモ中心"), "serializes marketing_strategy objects");
assert(brief.notes?.includes("QVC: ¥14,800") === true, "serializes pricing_strategy channel_pricing");
assert(brief.notes?.includes("月500個で黒字化") === true, "serializes pricing_strategy bep summary");

assert(brief.notes?.includes("Sample Factory") === true, "includes C package details in notes");

assert(isUuid("11111111-1111-4111-8111-111111111111"), "accepts valid uuid");
assert(!isUuid("not-a-uuid"), "rejects malformed uuid");

if (process.exitCode === 1) process.exit(1);
console.log("PASS: screenplay product brief helpers");
