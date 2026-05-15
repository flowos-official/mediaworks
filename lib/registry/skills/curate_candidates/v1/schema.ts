import { z } from "zod";

const curationScore = z.object({
	review_signal: z.number(),
	tv_category_match: z.number(),
	trend_signal: z.number(),
	price_fit: z.number(),
	purchase_signal: z.number(),
	total: z.number(),
});

// Loose schema for the curated Candidate. The full Candidate extends PoolItem
// with many DB-side fields; here we only capture what the LLM contributes
// (the score breakdown + reasoning), letting the rest pass through.
const curatedCandidate = z
	.object({
		productUrl: z.string(),
		name: z.string(),
		tvFitScore: z.number(),
		tvFitReason: z.string(),
		score: curationScore.optional(),
	})
	.passthrough();

export const outputSchema = z.array(curatedCandidate);

export type CurationOutput = z.infer<typeof outputSchema>;
