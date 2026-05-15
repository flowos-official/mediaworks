import { z } from "zod";

/**
 * LLM contract for product_selection.
 *
 * Note: discovered_new_products and discovery_history are NOT in this schema.
 * They are injected by the orchestrator AFTER the skill returns, as part of
 * the Strategy ↔ Discovery pool integration. The LLM only produces the
 * tier mapping + portfolio narrative.
 */
const channelEntry = z.object({
	channel: z.string(),
	tier1_products: z.array(
		z.object({
			code: z.string(),
			name: z.string(),
			reason: z.string(),
			monthly_trajectory: z.enum(["growing", "stable", "declining"]),
			margin_headroom: z.string(),
		}),
	),
	tier2_products: z.array(
		z.object({
			code: z.string(),
			name: z.string(),
			reason: z.string(),
		}),
	),
	exclusions: z.array(
		z.object({
			code: z.string(),
			name: z.string(),
			reason: z.string(),
		}),
	),
});

export const outputSchema = z.object({
	channel_product_matrix: z.array(channelEntry),
	portfolio_strategy: z.string(),
	sources_cited: z
		.array(
			z.object({
				index: z.number(),
				title: z.string(),
				url: z.string(),
			}),
		)
		.optional(),
});

export type ProductSelectionOutput = z.infer<typeof outputSchema>;
