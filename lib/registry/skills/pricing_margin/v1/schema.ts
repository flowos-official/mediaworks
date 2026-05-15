import { z } from "zod";

const channelPricing = z.object({
	channel: z.string(),
	recommended_price: z.number(),
	competitor_benchmark: z.string(),
	channel_fees: z.string(),
	net_margin_pct: z.number(),
	net_margin_yen: z.number(),
	reasoning: z.string(),
});

const productPricing = z.object({
	product_code: z.string(),
	product_name: z.string(),
	cost_basis: z.object({
		cost_price: z.number(),
		wholesale_rate: z.number(),
		current_tv_price: z.number(),
	}),
	channel_pricing: z.array(channelPricing),
});

const fixedCost = z.object({
	item: z.string(),
	monthly: z.number(),
});

const bepEntry = z.object({
	channel: z.string(),
	fixed_costs: z.array(fixedCost),
	variable_cost_per_unit: z.number(),
	bep_units: z.number(),
	bep_revenue: z.number(),
	bep_timeline: z.string(),
});

export const outputSchema = z.object({
	product_pricing: z.array(productPricing),
	bep_analysis: z.array(bepEntry),
	margin_optimization: z.array(z.string()),
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

export type PricingMarginOutput = z.infer<typeof outputSchema>;
