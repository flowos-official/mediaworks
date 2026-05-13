import { z } from "zod";

const recommendedProduct = z
	.object({
		name: z.string(),
		tv_revenue: z.string(),
		margin: z.string(),
		weekly_avg: z.number(),
		fit_reason: z.string(),
	})
	.passthrough();

export const outputSchema = z.object({
	channel_recommendations: z.array(
		z.object({
			channel: z.string(),
			fit_score: z.number(),
			reasoning: z.string(),
			estimated_market_size: z.string(),
			recommended_products: z.array(recommendedProduct),
			entry_difficulty: z.string(),
		}),
	),
	product_channel_fit: z.array(
		z.object({
			product: z.string(),
			best_channels: z.array(z.string()),
			reasoning: z.string(),
		}),
	),
	entry_strategy: z.array(
		z.object({
			channel: z.string(),
			steps: z.array(z.string()),
			timeline: z.string(),
			initial_investment: z.string(),
		}),
	),
	risk_assessment: z.array(
		z.object({
			channel: z.string(),
			risks: z.array(z.string()),
			mitigation: z.string(),
		}),
	),
	summary: z.string(),
});

export type ExpansionAnalysisResultOutput = z.infer<typeof outputSchema>;
