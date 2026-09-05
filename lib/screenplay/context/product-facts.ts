/**
 * Build the fact pack a screenplay is allowed to speak from.
 *
 * Two sources meet here and they are not equal. Stored evidence describes a
 * canonical product as the ledger found it — a verified price, a proxy airing
 * count, a seller's claim. The operator's brief is our own input about the
 * product we are actually selling. When both describe the same thing the
 * brief wins, because it is the thing being scripted.
 *
 * The rules that matter:
 *
 *   An unknown value is not zero and not an empty string. A brief field the
 *   operator left blank produces no evidence row at all; it goes into
 *   `missing`, and `missing` turns into an explicit prohibition. That is the
 *   difference between "this product has no guarantee" and "nobody told us".
 *
 *   An evidence class is never upgraded, and `usage` follows from it
 *   mechanically. A `source_claim` can only ever be attributed; a `proxy` or
 *   an `inferred` value can shape the running order but must never be spoken.
 *
 *   `notes` is the one place we override the mechanical mapping. It is our own
 *   input, so its class is `internal_input`, but its contents are research
 *   hypotheses, price bands and sourcing notes assembled by
 *   buildProductBriefFromRows — planning material, not product facts. It is
 *   pinned to `planning_only` so a market-size guess cannot be read on air.
 *
 * Writing brief evidence needs the service client: evidence_items is
 * service-role-write by design (20260830100000).
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAllPages } from "@/lib/supabase/paginate";
import { upsertEvidence } from "@/lib/intelligence/repository";
import type { EvidenceClass, EvidenceDraft } from "@/lib/intelligence/types";
import type { ProductBrief } from "@/lib/screenplay/types";
import type { FactUsage, ProductFact, ProductFactPack } from "./types";

/** Higher wins. Our own input outranks a measurement, which outranks a claim,
 *  which outranks a proxy, which outranks a guess. Same order as
 *  lib/product-finder/candidates.ts — one ledger, one precedence. */
const CLASS_RANK: Record<EvidenceClass, number> = {
	internal_input: 5,
	verified: 4,
	source_claim: 3,
	proxy: 2,
	inferred: 1,
};

export const USAGE_BY_CLASS: Record<EvidenceClass, FactUsage> = {
	verified: "direct",
	internal_input: "direct",
	source_claim: "attributed_only",
	proxy: "planning_only",
	inferred: "planning_only",
};

export interface StoredFactRow {
	id: string;
	predicate: string;
	value_json: unknown;
	value_state: string;
	evidence_class: EvidenceClass;
	confidence: number;
	observed_at: string;
	source_type: string;
	source_table: string;
}

interface StoredFactSpec {
	key: string;
	label: string;
	unit?: string;
}

/** Ledger predicate → fact key. Anything not listed is ignored: the pack is
 *  what a writer may use, not a dump of the subject's evidence. */
const STORED_FACT_SPECS: Record<string, StoredFactSpec> = {
	name: { key: "name", label: "商品名" },
	normalized_category: { key: "category", label: "カテゴリ" },
	price_jpy: { key: "price_jpy", label: "販売価格", unit: "JPY" },
	review_count: { key: "review_count", label: "レビュー件数", unit: "件" },
	tv_airing_count: { key: "tv_airing_count", label: "他局放送回数", unit: "回" },
	recent_airing_count: { key: "recent_airing_count", label: "直近放送回数", unit: "回" },
	// A claimed sales figure keeps "seller_claim" in its NAME, all the way to
	// the prompt. lib/product-finder/candidates.ts makes the same choice for
	// the same reason: a field called `unitsSold` invites a writer to say it.
	actual_competitor_sales: { key: "seller_claim_units", label: "販売実績（メーカー申告）" },
	seller_claim: { key: "seller_claim", label: "メーカー主張" },
	seller_claims: { key: "seller_claim", label: "メーカー主張" },
	product_claim: { key: "seller_claim", label: "メーカー主張" },
	product_claims: { key: "seller_claim", label: "メーカー主張" },
};

export const STORED_FACT_PREDICATES: readonly string[] = Object.keys(STORED_FACT_SPECS);

/** Predicates written for a manual/uploaded brief. Pinned by the test for the
 *  same reason test-intelligence-evidence-predicates.ts pins the backfill's:
 *  widening what crosses into evidence_items is a grade decision. */
const BRIEF_FACT_LABELS: Record<string, string> = {
	name: "商品名",
	description: "商品説明",
	category: "カテゴリ",
	price_list_jpy: "定価",
	price_sale_jpy: "販売価格",
	price_shipping_jpy: "送料",
	bonuses: "特典",
	guarantee: "保証",
	notes: "企画メモ",
};

const BRIEF_FACT_UNITS: Record<string, string> = {
	price_list_jpy: "JPY",
	price_sale_jpy: "JPY",
	price_shipping_jpy: "JPY",
};

/** Facts whose absence changes what the script is allowed to say. `satisfiedBy`
 *  lists the keys that can supply one, best first — a sale price and a ledger
 *  price both answer "do we know what this costs". */
const REQUIRED_FACTS: ReadonlyArray<{ id: string; satisfiedBy: readonly string[] }> = [
	{ id: "name", satisfiedBy: ["name"] },
	{ id: "description", satisfiedBy: ["description"] },
	{ id: "category", satisfiedBy: ["category"] },
	{ id: "price", satisfiedBy: ["price_sale_jpy", "price_list_jpy", "price_jpy"] },
	{ id: "bonuses", satisfiedBy: ["bonuses"] },
	{ id: "guarantee", satisfiedBy: ["guarantee"] },
	{ id: "review_count", satisfiedBy: ["review_count"] },
	{ id: "tv_airing_count", satisfiedBy: ["tv_airing_count"] },
];

/** True whatever the product is: these are the two ways a grounded script
 *  stops being grounded. */
const STANDING_FORBIDDEN: readonly string[] = [
	"参照放送に登場する競合商品の事実・数値・表現を、自社商品の事実として述べないこと",
	"事実欄にない数値（販売実績・満足度・順位・シェア）を作らないこと",
];

const FORBIDDEN_WHEN_MISSING: Record<string, string> = {
	price: "価格・割引額・値引き幅に言及しないこと（価格データがありません）",
	guarantee: "保証・返金・交換条件に言及しないこと（保証データがありません）",
	bonuses: "特典・おまけ・同梱品に言及しないこと（特典データがありません）",
	review_count: "レビュー件数・評価点・購入者数に言及しないこと（レビューデータがありません）",
	tv_airing_count: "放送実績・人気度をデータとして述べないこと（放送データがありません）",
};

function trimmed(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => trimmed(item)).filter(Boolean);
}

/**
 * The brief, as evidence drafts. A blank field yields nothing — not a row with
 * value 0, not a row with "", not an `unknown` row. `missing` is where absence
 * is recorded, and only there.
 */
export function briefEvidenceDrafts(
	screenplayId: string,
	brief: ProductBrief,
	observedAt: string,
): EvidenceDraft[] {
	const values: Array<[string, unknown]> = [
		["name", trimmed(brief.name) || undefined],
		["description", trimmed(brief.description) || undefined],
		["category", trimmed(brief.category) || undefined],
		["price_list_jpy", positiveNumber(brief.price?.listJpy)],
		["price_sale_jpy", positiveNumber(brief.price?.saleJpy)],
		["price_shipping_jpy", positiveNumber(brief.price?.shippingJpy)],
		["bonuses", stringList(brief.bonuses).length > 0 ? stringList(brief.bonuses) : undefined],
		["guarantee", trimmed(brief.guarantee) || undefined],
		["notes", trimmed(brief.notes) || undefined],
	];

	return values
		.filter(([, value]) => value !== undefined)
		.map(([predicate, value]) => ({
			subjectType: "internal_product" as const,
			subjectId: screenplayId,
			predicate,
			value,
			...(BRIEF_FACT_UNITS[predicate] ? { unit: BRIEF_FACT_UNITS[predicate] } : {}),
			valueState: "known" as const,
			evidenceClass: "internal_input" as const,
			sourceType: "screenplay_brief",
			sourceTable: "screenplays",
			sourceRecordId: screenplayId,
			observedAt,
			// The structured fields are what the operator typed. `notes` is a
			// composed digest of research output, so it is trusted less even
			// though it arrives through the same door.
			confidence: predicate === "notes" ? 0.5 : 1,
		}));
}

function factFromStoredRow(row: StoredFactRow, spec: StoredFactSpec): ProductFact {
	return {
		key: spec.key,
		label: spec.label,
		value: row.value_json,
		...(spec.unit ? { unit: spec.unit } : {}),
		evidenceClass: row.evidence_class,
		usage: USAGE_BY_CLASS[row.evidence_class] ?? "planning_only",
		evidenceItemIds: [row.id],
		sourceLabel: row.source_type || row.source_table,
		observedAt: row.observed_at,
	};
}

function factFromBriefDraft(draft: EvidenceDraft, evidenceItemId: string): ProductFact {
	return {
		key: draft.predicate,
		label: BRIEF_FACT_LABELS[draft.predicate] ?? draft.predicate,
		value: draft.value,
		...(draft.unit ? { unit: draft.unit } : {}),
		evidenceClass: "internal_input",
		// `notes` is the documented exception: our own input, but planning
		// material rather than a product fact.
		usage: draft.predicate === "notes" ? "planning_only" : "direct",
		evidenceItemIds: [evidenceItemId],
		sourceLabel: draft.sourceType,
		observedAt: draft.observedAt,
	};
}

/** Class, then confidence, then observation time — the same ordering the
 *  product finder uses to pick between two rows about one thing. */
function outranks(a: StoredFactRow, b: StoredFactRow): boolean {
	const classDelta = (CLASS_RANK[a.evidence_class] ?? 0) - (CLASS_RANK[b.evidence_class] ?? 0);
	if (classDelta !== 0) return classDelta > 0;
	if (a.confidence !== b.confidence) return a.confidence > b.confidence;
	return Date.parse(a.observed_at) > Date.parse(b.observed_at);
}

export interface AssembleFactPackInput {
	screenplayId: string;
	canonicalProductId: string | null;
	storedRows: readonly StoredFactRow[];
	briefFacts: readonly ProductFact[];
	mustAvoid?: readonly string[];
	builtAt: string;
}

/** Pure. Everything that decides what the writer may say happens here, so it
 *  can be exercised without a database. */
export function assembleFactPack(input: AssembleFactPackInput): ProductFactPack {
	// One winner per key from the ledger, but keep the ids of the rows it beat:
	// they were consulted, and the knowledge snapshot has to say so.
	const bestByKey = new Map<string, { row: StoredFactRow; spec: StoredFactSpec }>();
	const consultedByKey = new Map<string, string[]>();
	for (const row of input.storedRows) {
		const spec = STORED_FACT_SPECS[row.predicate];
		if (!spec) continue;
		const ids = consultedByKey.get(spec.key);
		if (ids) ids.push(row.id);
		else consultedByKey.set(spec.key, [row.id]);
		// An unknown row still counts as consulted, but it can never become a
		// fact: that is the unknown-as-zero bug, one layer up.
		if (row.value_state !== "known" || row.value_json === null || row.value_json === undefined) continue;
		const held = bestByKey.get(spec.key);
		if (!held || outranks(row, held.row)) bestByKey.set(spec.key, { row, spec });
	}

	const facts = new Map<string, ProductFact>();
	for (const [key, { row, spec }] of bestByKey) {
		const fact = factFromStoredRow(row, spec);
		// Winner first, then everything it displaced.
		fact.evidenceItemIds = [row.id, ...(consultedByKey.get(key) ?? []).filter((id) => id !== row.id)];
		facts.set(key, fact);
	}

	// The brief is our own input about the product actually being sold, so it
	// displaces a ledger row describing the same key.
	for (const fact of input.briefFacts) {
		const held = facts.get(fact.key);
		if (held && CLASS_RANK[held.evidenceClass] > CLASS_RANK[fact.evidenceClass]) continue;
		facts.set(fact.key, {
			...fact,
			evidenceItemIds: [...fact.evidenceItemIds, ...(held?.evidenceItemIds ?? [])],
		});
	}

	const present = new Set(facts.keys());
	const missing = REQUIRED_FACTS.filter((r) => !r.satisfiedBy.some((k) => present.has(k))).map((r) => r.id);

	const forbiddenClaims = [
		...STANDING_FORBIDDEN,
		...missing.map((id) => FORBIDDEN_WHEN_MISSING[id]).filter((line): line is string => Boolean(line)),
		...[...facts.values()]
			.filter((f) => f.usage === "attributed_only")
			.map((f) => `「${f.label}」は出典を明示した引用としてのみ述べること（自社の実測値として述べないこと）`),
		...(input.mustAvoid ?? []).map((line) => line.trim()).filter(Boolean),
	];

	return {
		subjectId: input.screenplayId,
		canonicalProductId: input.canonicalProductId,
		// Stable order so two runs over the same evidence produce the same pack.
		facts: [...facts.values()].sort((a, b) => a.key.localeCompare(b.key)),
		missing,
		forbiddenClaims: [...new Set(forbiddenClaims)],
		builtAt: input.builtAt,
	};
}

async function loadStoredFactRows(
	sb: SupabaseClient,
	canonicalProductId: string,
	observedAt: string,
): Promise<StoredFactRow[]> {
	return selectAllPages<StoredFactRow>(
		({ from, to }) =>
			sb
				.from("evidence_items")
				.select(
					"id, predicate, value_json, value_state, evidence_class, confidence, observed_at, source_type, source_table",
				)
				.eq("subject_type", "product")
				.eq("subject_id", canonicalProductId)
				.in("predicate", STORED_FACT_PREDICATES)
				.lte("observed_at", observedAt)
				.order("id", { ascending: true })
				.range(from, to),
		{ pageSize: 800, label: "screenplay:product-facts" },
	);
}

export async function buildProductFactPack(
	sb: SupabaseClient,
	input: {
		screenplayId: string;
		canonicalProductId: string | null;
		brief: ProductBrief;
		observedAt: string;
	},
): Promise<ProductFactPack> {
	const drafts = briefEvidenceDrafts(input.screenplayId, input.brief, input.observedAt);
	// Persisted, not just described: a claim link in Task 7 points at an
	// evidence row, so a fact the script speaks from has to BE one.
	const evidenceIds = drafts.length > 0 ? await upsertEvidence(sb, drafts) : [];
	const briefFacts = drafts.map((draft, i) => factFromBriefDraft(draft, evidenceIds[i]!));

	const storedRows = input.canonicalProductId
		? await loadStoredFactRows(sb, input.canonicalProductId, input.observedAt)
		: [];

	return assembleFactPack({
		screenplayId: input.screenplayId,
		canonicalProductId: input.canonicalProductId,
		storedRows,
		briefFacts,
		mustAvoid: input.brief.customization?.mustAvoid,
		builtAt: input.observedAt,
	});
}
