import { z } from "zod";

const byChannelEntry = z.object({
	channel: z.string(),
	revenue: z.number(),
	cost: z.number(),
	marketing_spend: z.number(),
	net_profit: z.number(),
	cumulative_profit: z.number(),
});

const monthlyForecast = z.object({
	month: z.string(),
	by_channel: z.array(byChannelEntry),
	total_revenue: z.number(),
	total_profit: z.number(),
});

const roiEntry = z.object({
	channel: z.string(),
	total_investment: z.number(),
	breakeven_month: z.string(),
	year1_roi_pct: z.number(),
	year1_net_profit: z.number(),
});

const scenario = z.object({
	year1_revenue: z.number(),
	year1_profit: z.number(),
});

export const outputSchema = z.object({
	monthly_forecast: z.array(monthlyForecast),
	roi_timeline: z.array(roiEntry),
	scenarios: z.object({
		conservative: scenario,
		moderate: scenario,
		aggressive: scenario,
		assumptions: z.array(z.string()),
	}),
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

export type FinancialProjectionOutput = z.infer<typeof outputSchema>;
