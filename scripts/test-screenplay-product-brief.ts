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
		market_size: "キッチン家電市場は堅調。",
		usp_points: ["材料を入れるだけ", "洗いやすい"],
		recommended_sales_timing: "新生活シーズン前",
		recommended_price_range: "¥14,800",
		marketing_strategy: ["実演デモ中心", "家事負担軽減を訴求"],
		broadcast_scripts: ["材料投入から完成までを短尺で見せる"],
		demographics: { primary: "家事時間を短縮したい層" },
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
assert(brief.description.includes("材料を入れるだけ"), "includes research USP points");
assert(brief.description.includes("材料投入から完成まで"), "includes broadcast script ideas");
assert(brief.notes?.includes("¥14,800") === true, "includes recommended price in notes");
assert(brief.notes?.includes("Sample Factory") === true, "includes C package details in notes");

assert(isUuid("11111111-1111-4111-8111-111111111111"), "accepts valid uuid");
assert(!isUuid("not-a-uuid"), "rejects malformed uuid");

if (process.exitCode === 1) process.exit(1);
console.log("PASS: screenplay product brief helpers");
