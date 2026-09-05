/**
 * Turn stored evidence into ranked-ready candidates. Reads the database and
 * nothing else.
 *
 * This module is the boundary the whole surface is named after: no Brave, no
 * Rakuten, no Gemini, no `fetch`. A test asserts those absences statically,
 * because the failure mode is not a crash — it is a quiet per-request bill and
 * a "stored-only" label that has stopped being true.
 *
 * Two rules run through the assembly:
 *
 *   An unknown value is not zero. Every `review_count` row in the live table
 *   is `value_state = 'unknown'`; read as 0 it would rank a product nobody has
 *   collected reviews for below one that genuinely has none, and the ranking
 *   would be reporting an artefact of our own collection schedule.
 *
 *   An evidence class is never upgraded. A competitor's "累計10万台突破" stays
 *   a `source_claim` and never reaches a field named for a measured sale. The
 *   signal names encode this: `sellerSalesClaim`, never `actualSales`.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAllPages } from "@/lib/supabase/paginate";
import { INTERNAL_PROFIT_PREDICATES } from "@/lib/intelligence/insights";
import type { EvidenceClass } from "@/lib/intelligence/types";
import type { ProductFinderQuery } from "./types";

/** Pre-rank ceiling. Ranking normalises within the candidate set, so this also
 *  bounds how wide "category-relative" is allowed to mean. */
export const MAX_CANDIDATES = 500;
const EVIDENCE_PAGE_SIZE = 800;

export interface StoredSignal<T> {
	value: T;
	evidenceClass: EvidenceClass;
	confidence: number;
	observedAt: string;
	evidenceItemId: string;
}

export interface CanonicalProductRow {
	id: string;
	display_name: string;
	normalized_category: string | null;
}

export interface EvidenceRow {
	id: string;
	subject_id: string;
	predicate: string;
	value_json: unknown;
	value_state: string;
	evidence_class: EvidenceClass;
	confidence: number;
	observed_at: string;
	/** Added by the controlled-inputs migration. Honoured from the start so the
	 *  first rollback cannot silently keep applying. */
	revoked_at?: string | null;
}

export interface StoredCandidate {
	canonicalProductId: string;
	name: string;
	category: string | null;
	evidenceIds: string[];
	signals: {
		priceJpy?: StoredSignal<number>;
		tvAirings?: StoredSignal<number>;
		recentAirings?: StoredSignal<number>;
		reviewCount?: StoredSignal<number>;
		sellerSalesClaim?: StoredSignal<string | number>;
		internalProfitJpy?: StoredSignal<number>;
		internalMarginRate?: StoredSignal<number>;
		broadcastPatternSample?: StoredSignal<number>;
	};
}

/** Higher wins. Our own input outranks a measurement, which outranks a claim,
 *  which outranks a proxy, which outranks a guess. */
const CLASS_RANK: Record<EvidenceClass, number> = {
	internal_input: 5,
	verified: 4,
	source_claim: 3,
	proxy: 2,
	inferred: 1,
};

const SELLER_CLAIM_PREDICATES = new Set([
	"seller_claim",
	"seller_claims",
	"product_claim",
	"product_claims",
	"actual_competitor_sales",
]);

/** Every predicate this module can turn into a signal — also the read filter,
 *  so a candidate load never pulls the whole ledger. */
export const CANDIDATE_PREDICATES: readonly string[] = [
	"price_jpy",
	"tv_airing_count",
	"recent_airing_count",
	"review_count",
	"broadcast_pattern_sample",
	...SELLER_CLAIM_PREDICATES,
	...INTERNAL_PROFIT_PREDICATES,
];

function isCurrent(row: EvidenceRow): boolean {
	if (row.value_state !== "known") return false;
	if (row.revoked_at) return false;
	return true;
}

/** Class, then confidence, then observation time. Returns true when `a` should
 *  displace `b`. */
function outranks(a: EvidenceRow, b: EvidenceRow): boolean {
	const classDelta = (CLASS_RANK[a.evidence_class] ?? 0) - (CLASS_RANK[b.evidence_class] ?? 0);
	if (classDelta !== 0) return classDelta > 0;
	if (a.confidence !== b.confidence) return a.confidence > b.confidence;
	return Date.parse(a.observed_at) > Date.parse(b.observed_at);
}

function toSignal<T>(row: EvidenceRow, value: T): StoredSignal<T> {
	return {
		value,
		evidenceClass: row.evidence_class,
		confidence: row.confidence,
		observedAt: row.observed_at,
		evidenceItemId: row.id,
	};
}

function numeric(value: unknown): number | undefined {
	// Deliberately not `Number(value)`: that turns "" into 0 and null into 0,
	// which is exactly the unknown-as-zero coercion this module forbids.
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function assembleCandidate(
	product: CanonicalProductRow,
	evidence: readonly EvidenceRow[],
): StoredCandidate {
	const best = new Map<string, EvidenceRow>();
	for (const row of evidence) {
		if (!isCurrent(row)) continue;
		// Seller claims share one slot regardless of which predicate carried
		// them: the ranking asks "is there a claim", not "which wording".
		const slot = SELLER_CLAIM_PREDICATES.has(row.predicate)
			? "seller_claim"
			: INTERNAL_PROFIT_PREDICATES.has(row.predicate) && row.predicate !== "gross_margin_pct"
				? "internal_profit"
				: row.predicate;
		const held = best.get(slot);
		if (!held || outranks(row, held)) best.set(slot, row);
	}

	const signals: StoredCandidate["signals"] = {};
	const numericSignal = (slot: string): [EvidenceRow, number] | undefined => {
		const row = best.get(slot);
		if (!row) return undefined;
		const value = numeric(row.value_json);
		return value === undefined ? undefined : [row, value];
	};

	const price = numericSignal("price_jpy");
	if (price) signals.priceJpy = toSignal(price[0], price[1]);

	const airings = numericSignal("tv_airing_count");
	if (airings) signals.tvAirings = toSignal(airings[0], airings[1]);

	const recent = numericSignal("recent_airing_count");
	if (recent) signals.recentAirings = toSignal(recent[0], recent[1]);

	const reviews = numericSignal("review_count");
	if (reviews) signals.reviewCount = toSignal(reviews[0], reviews[1]);

	const sample = numericSignal("broadcast_pattern_sample");
	if (sample) signals.broadcastPatternSample = toSignal(sample[0], sample[1]);

	const claim = best.get("seller_claim");
	if (claim && (typeof claim.value_json === "string" || typeof claim.value_json === "number")) {
		signals.sellerSalesClaim = toSignal(claim, claim.value_json);
	}

	// Internal figures accept `internal_input` only. A competitor's claimed
	// margin under the same predicate is still their claim, not our cost book.
	const profit = best.get("internal_profit");
	if (profit && profit.evidence_class === "internal_input") {
		const value = numeric(profit.value_json);
		if (value !== undefined) signals.internalProfitJpy = toSignal(profit, value);
	}
	const margin = best.get("gross_margin_pct");
	if (margin && margin.evidence_class === "internal_input") {
		const value = numeric(margin.value_json);
		if (value !== undefined) signals.internalMarginRate = toSignal(margin, value);
	}

	return {
		canonicalProductId: product.id,
		name: product.display_name,
		category: product.normalized_category,
		// Everything consulted, including the rows that turned out to be
		// unknown: coverage must distinguish "we looked and found nothing" from
		// "we never looked".
		evidenceIds: [...new Set(evidence.map((row) => row.id))],
		signals,
	};
}

export async function loadStoredCandidates(
	sb: SupabaseClient,
	query: ProductFinderQuery,
	dataCutoff: string,
): Promise<StoredCandidate[]> {
	let productQuery = sb
		.from("canonical_products")
		.select("id, display_name, normalized_category")
		.order("id", { ascending: true })
		.limit(MAX_CANDIDATES);
	if (query.category) productQuery = productQuery.eq("normalized_category", query.category);

	const { data: productRows, error: productError } = await productQuery;
	if (productError) throw new Error(`candidate product load failed: ${productError.message}`);

	const products = ((productRows ?? []) as CanonicalProductRow[]).filter((p) =>
		// Excluded terms are applied here rather than in SQL so one operator
		// term cannot become a PostgREST filter expression.
		query.excludedTerms.every((term) => !p.display_name.toLowerCase().includes(term.toLowerCase())),
	);
	if (products.length === 0) return [];

	const ids = products.map((p) => p.id);
	const evidence = await selectAllPages<EvidenceRow>(
		({ from, to }) =>
			sb
				.from("evidence_items")
				.select("id, subject_id, predicate, value_json, value_state, evidence_class, confidence, observed_at, revoked_at")
				.eq("subject_type", "product")
				.in("subject_id", ids)
				.in("predicate", CANDIDATE_PREDICATES)
				.lte("observed_at", dataCutoff)
				// Rolled-back evidence is revoked, not deleted, so a past snapshot
				// still resolves. It must not reach a NEW ranking, and the filter
				// belongs in the query rather than in isCurrent alone: without it
				// every revoked row is fetched, paged and paid for.
				.is("revoked_at", null)
				.order("id", { ascending: true })
				.range(from, to),
		{ pageSize: EVIDENCE_PAGE_SIZE, label: "product-finder:evidence" },
	);

	const bySubject = new Map<string, EvidenceRow[]>();
	for (const row of evidence) {
		const held = bySubject.get(row.subject_id);
		if (held) held.push(row);
		else bySubject.set(row.subject_id, [row]);
	}

	const candidates = products.map((p) => assembleCandidate(p, bySubject.get(p.id) ?? []));

	// A price band filters on the price we actually hold. A candidate with no
	// price is NOT excluded — that would silently drop everything we simply
	// have not priced yet, which is most of the ledger.
	return candidates.filter((c) => {
		const price = c.signals.priceJpy?.value;
		if (price === undefined) return true;
		if (query.priceMinJpy !== undefined && price < query.priceMinJpy) return false;
		if (query.priceMaxJpy !== undefined && price > query.priceMaxJpy) return false;
		return true;
	});
}
