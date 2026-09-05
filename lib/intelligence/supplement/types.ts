/**
 * What an operator may ask us to go and find out, and what we are allowed to
 * conclude from the answer.
 *
 * The gap list is CLOSED, in the type and in the database CHECK. The absent
 * entry is the important one: there is no `actual_competitor_revenue`, because
 * we have no way to know a competitor's revenue, and a field that accepted the
 * request would eventually hold a number somebody would act on.
 *
 * Classification is the other half. A search result is not a fact. What a
 * seller says about their own sales is a claim however many times it is
 * repeated, a review count is a proxy for demand rather than a measure of it,
 * and only something read off the official page itself is verified.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import type { EvidenceClass } from "@/lib/intelligence/types";

export const SUPPLEMENT_GAPS = [
	"official_product_facts",
	"current_price",
	"seller_sales_claim",
	"review_signal",
	"ranking_signal",
] as const;

export type SupplementGap = (typeof SUPPLEMENT_GAPS)[number];

export interface SupplementRequest {
	gaps: SupplementGap[];
}

/** Where an observation physically came from. */
export type SourceKind = "official" | "seller" | "marketplace" | "search_snippet";

/** What kind of thing was observed. Named so a claim can never be stored under
 *  a name that reads as a measurement. */
export type SupplementMetric =
	| "product_spec"
	| "price"
	| "claimed_units"
	| "review_count"
	| "review_average"
	| "ranking_position";

export type SupplementSourceType = "official_site" | "seller_page" | "rakuten" | "brave_result";

export interface SupplementObservation {
	gap: SupplementGap;
	predicate: string;
	value: unknown;
	unit?: string;
	evidenceClass: Extract<EvidenceClass, "verified" | "source_claim" | "proxy">;
	sourceType: SupplementSourceType;
	sourceUrl: string;
	sourceTitle: string;
	sourceLocator?: string;
	observedAt: string;
	confidence: number;
}

export class SupplementRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SupplementRequestError";
	}
}

/** Strict. An unknown gap is rejected rather than dropped: a request for
 *  something we refuse to research must fail loudly, not quietly return a
 *  narrower job the operator did not ask for. */
export function parseSupplementRequest(input: unknown): SupplementRequest {
	if (!input || typeof input !== "object") {
		throw new SupplementRequestError("a supplemental request body is required");
	}
	const raw = (input as { gaps?: unknown }).gaps;
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new SupplementRequestError("at least one gap must be selected");
	}
	const allowed = new Set<string>(SUPPLEMENT_GAPS);
	const gaps: SupplementGap[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || !allowed.has(entry)) {
			throw new SupplementRequestError(`unsupported gap: ${String(entry)}`);
		}
		if (!gaps.includes(entry as SupplementGap)) gaps.push(entry as SupplementGap);
	}
	if (gaps.length > SUPPLEMENT_GAPS.length) {
		throw new SupplementRequestError("too many gaps requested");
	}
	return { gaps };
}

/**
 * The class an observation is allowed to carry.
 *
 * `claimed_units` is checked first and unconditionally: a seller's sales figure
 * is a claim wherever it is found, including on their official site. That is
 * the one rule this whole feature exists to hold, because "累計10万台突破"
 * printed on a manufacturer page is exactly the thing that looks verified.
 *
 * A marketplace price is `verified` — it is a direct machine-readable
 * observation that a listing exists at that price — and the predicate it is
 * stored under says so (`marketplace_price_jpy`), the same way
 * `sellerSalesClaim` carries its caveat in its name. Review counts and ranking
 * positions stay `proxy`: they stand in for demand, they do not measure it.
 */
export function classifyObservation(input: {
	sourceKind: SourceKind;
	metric: SupplementMetric;
	/** True only when the value was read from the fetched page body, not from a
	 *  search snippet describing it. */
	readFromPage?: boolean;
}): Extract<EvidenceClass, "verified" | "source_claim" | "proxy"> {
	if (input.metric === "claimed_units") return "source_claim";
	if (input.metric === "review_count" || input.metric === "review_average") return "proxy";
	if (input.metric === "ranking_position") return "proxy";

	if (input.sourceKind === "marketplace") return "verified";
	// Read off the official page itself. A Brave snippet ABOUT the official page
	// is not the official page.
	if (input.sourceKind === "official" && input.readFromPage) return "verified";
	return "source_claim";
}
