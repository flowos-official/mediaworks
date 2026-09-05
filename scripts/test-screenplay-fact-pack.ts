/**
 * What a screenplay is allowed to say, and what it must not.
 *
 * The interesting cases are all about absence. A brief field left blank must
 * not become a fact with an empty value, an `unknown` ledger row must not
 * become a zero, and both must turn into an explicit prohibition rather than
 * silence — a script that simply omits the guarantee reads the same as one
 * that decided there isn't one.
 */
import assert from "node:assert/strict";
import {
	assembleFactPack,
	briefEvidenceDrafts,
	USAGE_BY_CLASS,
	type StoredFactRow,
} from "../lib/screenplay/context/product-facts";
import type { ProductBrief } from "../lib/screenplay/types";
import type { ProductFact } from "../lib/screenplay/context/types";

const SCREENPLAY_ID = "33333333-3333-4333-8333-333333333333";
const CANONICAL_ID = "44444444-4444-4444-8444-444444444444";
const AT = "2026-09-05T00:00:00.000Z";

function row(over: Partial<StoredFactRow> & Pick<StoredFactRow, "predicate">): StoredFactRow {
	return {
		id: `ev-${over.predicate}-${over.evidence_class ?? "x"}`,
		value_json: null,
		value_state: "known",
		evidence_class: "proxy",
		confidence: 0.8,
		observed_at: "2026-09-01T00:00:00.000Z",
		source_type: "discovery",
		source_table: "discovered_products",
		...over,
	};
}

function briefFacts(brief: ProductBrief): ProductFact[] {
	// Mirrors buildProductFactPack's wiring without touching the database: the
	// drafts are what would be persisted, one evidence id each.
	return briefEvidenceDrafts(SCREENPLAY_ID, brief, AT).map((draft, i) => ({
		key: draft.predicate,
		label: draft.predicate,
		value: draft.value,
		...(draft.unit ? { unit: draft.unit } : {}),
		evidenceClass: "internal_input" as const,
		usage: draft.predicate === "notes" ? ("planning_only" as const) : ("direct" as const),
		evidenceItemIds: [`brief-${i}`],
		sourceLabel: draft.sourceType,
		observedAt: draft.observedAt,
	}));
}

const FULL_BRIEF: ProductBrief = {
	name: "静音ブレンダー Pro",
	description: "毎秒2万回転のミキサー",
	category: "家電",
	price: { listJpy: 19800, saleJpy: 14800 },
	bonuses: ["専用レシピブック"],
	guarantee: "1年保証",
	notes: "市場規模仮説: 国内300億円",
};

// --- a blank brief field is absence, never an empty fact --------------------
{
	const sparse: ProductBrief = { name: "試作品", description: "" };
	const drafts = briefEvidenceDrafts(SCREENPLAY_ID, sparse, AT);
	assert.deepEqual(drafts.map((d) => d.predicate), ["name"], "only the filled field becomes evidence");
	for (const draft of drafts) {
		assert.notEqual(draft.value, "", "a blank field must not be persisted as an empty string");
		assert.notEqual(draft.value, 0, "a blank field must not be persisted as zero");
		assert.equal(draft.subjectType, "internal_product");
		assert.equal(draft.subjectId, SCREENPLAY_ID, "brief evidence is keyed on the screenplay");
		assert.equal(draft.evidenceClass, "internal_input");
	}

	const pack = assembleFactPack({
		screenplayId: SCREENPLAY_ID,
		canonicalProductId: null,
		storedRows: [],
		briefFacts: briefFacts(sparse),
		builtAt: AT,
	});
	assert.equal(pack.missing.includes("guarantee"), true, "an unstated guarantee is missing, not absent-by-fact");
	assert.equal(pack.missing.includes("price"), true);
	assert.equal(pack.facts.some((x) => x.value === undefined), false, "no fact may carry undefined");
	assert.equal(pack.facts.some((x) => x.value === ""), false, "no fact may carry an empty string");
	assert.equal(pack.facts.some((x) => x.key === "guarantee"), false);
}
console.log("✓ a blank brief field produces no fact and one explicit gap");

// --- what is missing becomes a prohibition ---------------------------------
// The failure mode this prevents: the writer, given nothing about a guarantee,
// invents 「30日間返金保証」 because home-shopping copy usually has one.
{
	const pack = assembleFactPack({
		screenplayId: SCREENPLAY_ID,
		canonicalProductId: null,
		storedRows: [],
		briefFacts: briefFacts({ name: "試作品", description: "説明" }),
		mustAvoid: ["競合他社名を出さない"],
		builtAt: AT,
	});
	assert.ok(pack.forbiddenClaims.some((l) => l.includes("保証")), "a missing guarantee forbids guarantee talk");
	assert.ok(pack.forbiddenClaims.some((l) => l.includes("価格")), "a missing price forbids price talk");
	assert.ok(pack.forbiddenClaims.includes("競合他社名を出さない"), "the operator's own mustAvoid survives");
	assert.ok(
		pack.forbiddenClaims.some((l) => l.includes("競合商品")),
		"copying a reference broadcast's product facts is always forbidden",
	);
	assert.equal(new Set(pack.forbiddenClaims).size, pack.forbiddenClaims.length, "no duplicates");
}
console.log("✓ every gap becomes an explicit prohibition");

// --- evidence class decides usage, and is never upgraded -------------------
{
	const pack = assembleFactPack({
		screenplayId: SCREENPLAY_ID,
		canonicalProductId: CANONICAL_ID,
		storedRows: [
			row({ predicate: "price_jpy", value_json: 14800, evidence_class: "verified" }),
			row({ predicate: "tv_airing_count", value_json: 7, evidence_class: "proxy" }),
			row({ predicate: "normalized_category", value_json: "家電", evidence_class: "inferred" }),
			row({ predicate: "actual_competitor_sales", value_json: "累計10万台", evidence_class: "source_claim" }),
		],
		briefFacts: [],
		builtAt: AT,
	});
	const by = (k: string) => pack.facts.find((f) => f.key === k);
	assert.equal(by("price_jpy")?.usage, "direct", "a verified measurement may be stated");
	assert.equal(by("seller_claim_units")?.usage, "attributed_only");
	assert.equal(by("seller_claim_units")?.evidenceClass, "source_claim", "a claim is never promoted");
	assert.equal(by("tv_airing_count")?.usage, "planning_only", "a proxy shapes structure, it is not spoken");
	assert.equal(by("category")?.usage, "planning_only", "an inferred category is not a broadcast fact");
	// The name matters: nothing in the pack may read as a measured sale.
	assert.equal(pack.facts.some((f) => /units_sold|actual_sales/.test(f.key)), false);
	assert.ok(
		pack.forbiddenClaims.some((l) => l.includes("出典を明示")),
		"an attributed-only fact carries its attribution requirement",
	);
}
console.log("✓ class decides usage and a seller claim stays a seller claim");

// --- an unknown ledger row is consulted, never converted -------------------
// Every review_count row in the live table is value_state 'unknown'. Read as 0
// the script would say 「レビュー0件」 about a product nobody has collected
// reviews for.
{
	const pack = assembleFactPack({
		screenplayId: SCREENPLAY_ID,
		canonicalProductId: CANONICAL_ID,
		storedRows: [
			row({ predicate: "review_count", value_json: null, value_state: "unknown" }),
			row({ predicate: "price_jpy", value_json: null, value_state: "unknown", evidence_class: "verified" }),
		],
		briefFacts: [],
		builtAt: AT,
	});
	assert.equal(pack.facts.some((f) => f.key === "review_count"), false);
	assert.equal(pack.missing.includes("review_count"), true);
	assert.equal(pack.missing.includes("price"), true);
}
console.log("✓ an unknown value becomes a gap, not a zero");

// --- the brief beats the ledger about the product being sold ---------------
{
	const pack = assembleFactPack({
		screenplayId: SCREENPLAY_ID,
		canonicalProductId: CANONICAL_ID,
		storedRows: [
			row({ predicate: "name", value_json: "旧・型番違いの名称", evidence_class: "source_claim" }),
			row({ predicate: "price_jpy", value_json: 12800, evidence_class: "verified" }),
			row({ predicate: "review_count", value_json: 240 }),
			row({ predicate: "tv_airing_count", value_json: 7 }),
		],
		briefFacts: briefFacts(FULL_BRIEF),
		builtAt: AT,
	});
	const name = pack.facts.find((x) => x.key === "name");
	assert.equal(name?.evidenceClass, "internal_input", "our own input wins for the product we are scripting");
	assert.equal(name?.value, FULL_BRIEF.name);
	assert.ok(
		(name?.evidenceItemIds.length ?? 0) >= 2,
		"the displaced ledger row is still recorded as consulted",
	);
	assert.deepEqual(pack.missing, [], "a complete brief plus ledger leaves no required gap");
	// Order is stable so two runs over one product produce one pack.
	assert.deepEqual(pack.facts.map((f) => f.key), [...pack.facts.map((f) => f.key)].sort());
}
console.log("✓ the brief displaces the ledger, and the displaced row is still recorded");

// --- notes are planning material even though they are our own input --------
{
	const pack = assembleFactPack({
		screenplayId: SCREENPLAY_ID,
		canonicalProductId: null,
		storedRows: [],
		briefFacts: briefFacts(FULL_BRIEF),
		builtAt: AT,
	});
	const notes = pack.facts.find((f) => f.key === "notes");
	assert.equal(notes?.evidenceClass, "internal_input");
	assert.equal(notes?.usage, "planning_only", "a market-size hypothesis must not be readable on air");
}
console.log("✓ notes stay planning-only");

// --- the class → usage map has no gaps -------------------------------------
for (const cls of ["verified", "source_claim", "proxy", "inferred", "internal_input"] as const) {
	assert.ok(USAGE_BY_CLASS[cls], `no usage defined for evidence class ${cls}`);
}

// --- the brief's predicate set is pinned -----------------------------------
// Same reason test-intelligence-evidence-predicates.ts pins the backfill's:
// widening what crosses into evidence_items is a grade decision, not a detail.
{
	const predicates = briefEvidenceDrafts(
		SCREENPLAY_ID,
		{ ...FULL_BRIEF, price: { listJpy: 1, saleJpy: 2, shippingJpy: 3 } },
		AT,
	).map((d) => d.predicate);
	assert.deepEqual(
		[...predicates].sort(),
		[
			"bonuses",
			"category",
			"description",
			"guarantee",
			"name",
			"notes",
			"price_list_jpy",
			"price_sale_jpy",
			"price_shipping_jpy",
		],
		"brief evidence predicates changed — re-check the evidence_items grade",
	);
}
console.log("✓ the brief predicate set is pinned");

console.log("PASS: screenplay fact pack");
