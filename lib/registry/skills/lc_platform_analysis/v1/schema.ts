import { z } from "zod";

const platformEntry = z.object({
	name: z.string(),
	fit_score: z.number(),
	user_base: z.string(),
	commission_structure: z.string(),
	strengths: z.array(z.string()),
	weaknesses: z.array(z.string()),
	success_cases: z.array(
		z.object({
			brand: z.string(),
			description: z.string(),
			result: z.string(),
		}),
	),
	recommended_products: z.array(z.string()),
	entry_steps: z.array(z.string()),
	our_recommended_products: z.array(
		z.object({
			code: z.string(),
			name: z.string(),
			reason: z.string(),
		}),
	),
	search_keywords: z.array(z.string()),
});

/**
 * Note: discovered_new_products and discovery_history are NOT in this schema
 * — they're injected by the orchestrator after the LLM returns, mirroring
 * the md_strategy/product_selection pattern.
 */
export const outputSchema = z.object({
	platforms: z.array(platformEntry),
	comparison_summary: z.string(),
	recommended_priority: z.array(z.string()),
});

export type PlatformAnalysisOutput = z.infer<typeof outputSchema>;
