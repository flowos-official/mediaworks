/**
 * Strict parsing for a product-finder request.
 *
 * `.strict()` rather than the Zod default: an unknown field that is stripped
 * silently is a filter the operator believes was applied and was not, and they
 * would read the resulting ranking as an answer to a question nobody asked.
 *
 * Blank text is absence, not an empty-string filter. Left as "" it reaches the
 * database as an exact match on the empty string and returns nothing, which
 * looks identical to "we hold no data on this".
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import { z } from "zod";
import type { ProductFinderQuery } from "./types";

const MAX_TEXT = 200;
const MAX_ARRAY = 20;

/** Trim first, then bound: whitespace must not buy length. Blank becomes
 *  undefined so the caller can tell "unset" from "set to nothing". */
const text = z
	.string()
	.transform((v) => v.trim())
	.refine((v) => v.length <= MAX_TEXT, { message: `must be at most ${MAX_TEXT} characters` })
	.transform((v) => (v.length === 0 ? undefined : v));

const textList = z
	.array(z.string())
	.max(MAX_ARRAY, { message: `must hold at most ${MAX_ARRAY} entries` })
	.transform((list) => list.map((v) => v.trim()).filter((v) => v.length > 0))
	.refine((list) => list.every((v) => v.length <= MAX_TEXT), {
		message: `each entry must be at most ${MAX_TEXT} characters`,
	})
	.default([]);

const priceJpy = z
	.number()
	.int({ message: "price must be a whole number of yen" })
	.nonnegative({ message: "price must not be negative" });

const schema = z
	.object({
		category: text.optional(),
		targetCustomer: text.optional(),
		priceMinJpy: priceJpy.optional(),
		priceMaxJpy: priceJpy.optional(),
		targetMarginRate: z
			.number()
			.min(0, { message: "margin must be between 0 and 100" })
			.max(100, { message: "margin must be between 0 and 100" })
			.optional(),
		desiredFeatures: textList,
		excludedTerms: textList,
		// Floor of 5 because a ranking of one or two items hides the spread that
		// makes the ordering meaningful; ceiling of 30 because every item costs
		// an evidence read.
		limit: z
			.number()
			.int({ message: "limit must be a whole number" })
			.min(5, { message: "limit must be between 5 and 30" })
			.max(30, { message: "limit must be between 5 and 30" })
			.default(10),
		mode: z.literal("stored_only").default("stored_only"),
	})
	.strict()
	.refine(
		(q) => q.priceMinJpy === undefined || q.priceMaxJpy === undefined || q.priceMinJpy <= q.priceMaxJpy,
		{ message: "price band is inverted: priceMinJpy is above priceMaxJpy", path: ["priceMaxJpy"] },
	);

export function parseProductFinderQuery(input: unknown): ProductFinderQuery {
	const parsed = schema.parse(input);
	// Spread the optional keys explicitly so every stored query_json has the
	// same shape — a run whose category key is simply missing and one whose
	// category is undefined must not read differently in the audit trail.
	return {
		category: parsed.category,
		targetCustomer: parsed.targetCustomer,
		priceMinJpy: parsed.priceMinJpy,
		priceMaxJpy: parsed.priceMaxJpy,
		targetMarginRate: parsed.targetMarginRate,
		desiredFeatures: parsed.desiredFeatures,
		excludedTerms: parsed.excludedTerms,
		limit: parsed.limit,
		mode: parsed.mode,
	};
}
