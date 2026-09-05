/**
 * The running order, decided before prose and checked before it is used.
 *
 * The cases that matter are the ones where a model returns something that
 * looks like a plan and isn't: shares that sum to half a broadcast, two
 * sections with the same id, a demo attached to a section that does not
 * exist, and fact keys the pack never contained. Each of those would produce
 * a script that reads fine and is wrong.
 */
import assert from "node:assert/strict";
import {
	buildStructurePlan,
	buildStructurePlanPrompt,
	formatStructurePlanBlock,
	genericStructurePlan,
	StructurePlanError,
	validateStructurePlan,
	type StructurePlanInput,
} from "../lib/screenplay/context/structure-plan";
import type { ProductFactPack } from "../lib/screenplay/context/types";
import type { PatternLoadResult } from "../lib/screenplay/context/pattern-result";
import type { ProductBrief } from "../lib/screenplay/types";

const BRIEF: ProductBrief = {
	name: "静音ブレンダー Pro",
	category: "家電",
	description: "氷も砕ける静音ミキサー",
	price: { saleJpy: 14800 },
	customization: { runtimeMinutes: 30, mustDemos: ["氷を砕く実演", "洗浄の実演"] },
};

const FACT_PACK: ProductFactPack = {
	subjectId: "sp-1",
	canonicalProductId: null,
	facts: [
		{ key: "name", label: "商品名", value: "静音ブレンダー Pro", evidenceClass: "internal_input", usage: "direct", evidenceItemIds: ["e1"], sourceLabel: "screenplay_brief", observedAt: "2026-09-05T00:00:00.000Z" },
		{ key: "price_sale_jpy", label: "販売価格", value: 14800, unit: "JPY", evidenceClass: "internal_input", usage: "direct", evidenceItemIds: ["e2"], sourceLabel: "screenplay_brief", observedAt: "2026-09-05T00:00:00.000Z" },
		{ key: "description", label: "商品説明", value: "氷も砕ける静音ミキサー", evidenceClass: "internal_input", usage: "direct", evidenceItemIds: ["e3"], sourceLabel: "screenplay_brief", observedAt: "2026-09-05T00:00:00.000Z" },
		{ key: "tv_airing_count", label: "他局放送回数", value: 7, evidenceClass: "proxy", usage: "planning_only", evidenceItemIds: ["e4"], sourceLabel: "discovery", observedAt: "2026-09-01T00:00:00.000Z" },
	],
	missing: ["guarantee", "bonuses"],
	forbiddenClaims: ["保証・返金・交換条件に言及しないこと（保証データがありません）"],
	builtAt: "2026-09-05T00:00:00.000Z",
};

const THIN_PATTERN: PatternLoadResult = {
	status: "under_sampled",
	pattern: null,
	detail: 'category "家電" has fewer than 5 analyzed broadcasts in the lookback window',
};

const INPUT: StructurePlanInput = {
	factPack: FACT_PACK,
	patternResult: THIN_PATTERN,
	references: [],
	brief: BRIEF,
};

function modelPlan(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		runtimeMinutes: 30,
		sections: [
			{ id: "opening", title: "導入", purpose: "つかむ", runtimeShare: 0.1, keyMessages: ["静かさ"], factKeys: ["name"], patternBasis: [] },
			{ id: "demo", title: "実演", purpose: "見せる", runtimeShare: 0.5, keyMessages: [], factKeys: ["description"], patternBasis: [] },
			{ id: "offer", title: "オファー", purpose: "売る", runtimeShare: 0.4, keyMessages: [], factKeys: ["price_sale_jpy"], patternBasis: [] },
		],
		demos: [
			{ id: "d1", sectionId: "demo", title: "氷を砕く実演", hostAction: "氷を入れて回す", cameraCue: "手元アップ", requiredFactKeys: [], safetyNote: null },
		],
		...over,
	});
}

async function main(): Promise<void> {
	// --- a well-formed plan is normalised, not rewritten --------------------
	{
		const plan = await buildStructurePlan(INPUT, async () => modelPlan());
		const sum = plan.sections.reduce((acc, s) => acc + s.runtimeShare, 0);
		assert.ok(sum > 0.95 && sum < 1.05, `runtime shares must sum to ~1, got ${sum}`);
		assert.equal(plan.runtimeMinutes, 30);
		assert.equal(plan.sections.length, 3, "sections are not invented or dropped");
	}
	console.log("✓ a valid plan keeps its shape and sums to one");

	// --- every required demo appears exactly once ---------------------------
	// The model returned one of the two the operator asked for. The missing one
	// is appended rather than lost, and the one it did return is not doubled.
	{
		const plan = await buildStructurePlan(INPUT, async () => modelPlan());
		const titles = plan.demos.map((d) => d.title);
		for (const required of BRIEF.customization!.mustDemos!) {
			assert.equal(
				titles.filter((t) => t.includes(required) || required.includes(t)).length,
				1,
				`required demo "${required}" must appear exactly once, got ${JSON.stringify(titles)}`,
			);
		}
		for (const demo of plan.demos) {
			assert.ok(
				plan.sections.some((s) => s.id === demo.sectionId),
				"every demo belongs to a section that exists",
			);
		}
	}
	console.log("✓ every required demo lands exactly once");

	// --- a fact key outside the pack is dropped ----------------------------
	// A section citing a key we do not hold is a section claiming grounding it
	// does not have. Dropping makes it claim less, never more.
	{
		const plan = await buildStructurePlan(INPUT, async () =>
			modelPlan({
				sections: [
					{ id: "opening", title: "導入", purpose: "つかむ", runtimeShare: 0.2, keyMessages: [], factKeys: ["name", "guarantee", "customer_satisfaction"], patternBasis: [] },
					{ id: "demo", title: "実演", purpose: "見せる", runtimeShare: 0.4, keyMessages: [], factKeys: [], patternBasis: [] },
					{ id: "offer", title: "オファー", purpose: "売る", runtimeShare: 0.4, keyMessages: [], factKeys: ["price_sale_jpy"], patternBasis: [] },
				],
			}),
		);
		const keys = plan.sections.flatMap((s) => s.factKeys);
		assert.equal(keys.includes("guarantee"), false, "a missing fact must not become a citable key");
		assert.equal(keys.includes("customer_satisfaction"), false, "an invented fact key must not survive");
		assert.equal(keys.includes("name"), true, "a real key survives");
		// planning_only facts are not speakable, so they are not citable either.
		assert.equal(keys.includes("tv_airing_count"), false);
	}
	console.log("✓ unsupported fact keys never reach the plan");

	// --- incoherent runtime is a failure, not something to scale up --------
	{
		await assert.rejects(
			buildStructurePlan(INPUT, async () =>
				modelPlan({
					sections: [
						{ id: "a", title: "A", purpose: "x", runtimeShare: 0.1, keyMessages: [], factKeys: [], patternBasis: [] },
						{ id: "b", title: "B", purpose: "x", runtimeShare: 0.1, keyMessages: [], factKeys: [], patternBasis: [] },
						{ id: "c", title: "C", purpose: "x", runtimeShare: 0.2, keyMessages: [], factKeys: [], patternBasis: [] },
					],
					demos: [],
				}),
			),
			(error: unknown) =>
				error instanceof StructurePlanError && error.code === "structure_plan_incoherent_runtime",
			"shares summing to 0.4 must fail rather than be scaled 2.5x",
		);
	}
	console.log("✓ a half-finished plan fails instead of being scaled up");

	// --- structural corruption is rejected ---------------------------------
	{
		const cases: Array<[string, Record<string, unknown>]> = [
			[
				"structure_plan_duplicate_section",
				{
					sections: [
						{ id: "dup", title: "A", purpose: "x", runtimeShare: 0.4, keyMessages: [], factKeys: [], patternBasis: [] },
						{ id: "dup", title: "B", purpose: "x", runtimeShare: 0.3, keyMessages: [], factKeys: [], patternBasis: [] },
						{ id: "c", title: "C", purpose: "x", runtimeShare: 0.3, keyMessages: [], factKeys: [], patternBasis: [] },
					],
					demos: [],
				},
			],
			[
				"structure_plan_orphan_demo",
				{
					demos: [
						{ id: "d1", sectionId: "nowhere", title: "実演", hostAction: "x", cameraCue: "y", requiredFactKeys: [], safetyNote: null },
					],
				},
			],
			["structure_plan_invalid", { sections: [] }],
		];
		for (const [code, over] of cases) {
			await assert.rejects(
				buildStructurePlan(INPUT, async () => modelPlan(over)),
				(error: unknown) => error instanceof StructurePlanError && error.code === code,
				`expected ${code}`,
			);
		}
		await assert.rejects(
			buildStructurePlan(INPUT, async () => "申し訳ありませんが作成できません"),
			(error: unknown) => error instanceof StructurePlanError && error.code === "structure_plan_unparseable",
		);
	}
	console.log("✓ duplicate ids, orphan demos and non-JSON are all rejected");

	// --- basis is ours, never the model's ----------------------------------
	// A model asked what informed it reports whatever the prompt implied.
	{
		const thin = validateStructurePlan(JSON.parse(modelPlan({ basis: "competitor_pattern" })), INPUT);
		assert.equal(thin.basis, "generic", "a thin corpus produces a generic plan whatever the model says");

		const applied = validateStructurePlan(JSON.parse(modelPlan()), {
			...INPUT,
			patternResult: {
				status: "applied",
				pattern: {
					category: "家電",
					sampleSize: 12,
					channels: ["qvc", "shopch"],
					runtimeMedianSec: 1800,
					actSequence: [],
					sellingPointOrder: [],
					evidenceMix: [],
					objectionMix: [],
					offerTiming: { firstPriceShare: 0.3, firstPriceMedianSec: 540, ctaCountMedian: 3 },
				},
				detail: "12 analyzed broadcasts across qvc, shopch",
			},
		});
		assert.equal(applied.basis, "competitor_pattern");
	}
	console.log("✓ basis comes from the pattern status, not from the model");

	// --- a thin pattern still yields a usable generic plan ------------------
	{
		const generic = genericStructurePlan(INPUT);
		assert.equal(generic.basis, "generic");
		const sum = generic.sections.reduce((acc, s) => acc + s.runtimeShare, 0);
		assert.ok(Math.abs(sum - 1) < 1e-9, `the deterministic skeleton must sum to exactly 1, got ${sum}`);
		assert.equal(generic.runtimeMinutes, 30, "the operator's runtime is respected");
		assert.equal(generic.demos.length, 2, "both required demos are planned");
		assert.equal(
			generic.sections.some((s) => s.factKeys.includes("guarantee")),
			false,
			"the skeleton cannot cite a fact we do not hold",
		);
	}
	console.log("✓ a thin pattern still produces a valid generic plan");

	// --- the prompt carries the constraints, not the competitor's words ----
	{
		const prompt = buildStructurePlanPrompt({
			...INPUT,
			references: [
				{
					broadcastId: "b1",
					channel: "shopch",
					airDate: "2026-08-01",
					category: "家電",
					programTitle: "他社の番組タイトル",
					similarity: 0.8,
					matchedOn: ["category"],
					analysisId: "b1",
				},
			],
		});
		assert.ok(prompt.includes("guarantee"), "what is missing is stated");
		assert.ok(prompt.includes("保証・返金"), "the derived prohibition is stated");
		assert.equal(
			prompt.includes("他社の番組タイトル"),
			false,
			"a competitor programme title is their copy and must not reach the prompt",
		);
	}
	console.log("✓ the planning prompt states the limits and carries no competitor copy");

	// --- the block the writer reads ----------------------------------------
	{
		const plan = await buildStructurePlan(INPUT, async () => modelPlan());
		const block = formatStructurePlanBlock(plan);
		assert.ok(block.startsWith("## 確定済み放送構成"));
		assert.ok(block.includes("氷を砕く実演") && block.includes("洗浄の実演"));
		assert.ok(block.includes("競合データなし"), "a generic plan says so to the writer");
		for (const section of plan.sections) assert.ok(block.includes(section.title));
	}
	console.log("✓ the injected block states the order, the shares and the demos");

	console.log("PASS: screenplay structure plan");
}

main().catch((error) => {
	console.error("FAIL:", error);
	process.exit(1);
});
