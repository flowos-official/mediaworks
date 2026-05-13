import { z } from "zod";

const kpi = z.object({
	metric: z.string(),
	target: z.string(),
	timeline: z.string(),
});

const costEntry = z.object({
	item: z.string(),
	cost: z.string(),
});

const channelEntry = z.object({
	name: z.string(),
	priority: z.enum(["immediate", "3month", "6month", "12month"]),
	fit_score: z.number(),
	market_size: z.string(),
	entry_requirements: z.object({
		account_type: z.string(),
		required_documents: z.array(z.string()),
		setup_timeline: z.string(),
		initial_costs: z.array(costEntry),
	}),
	fee_structure: z.object({
		commission_rate: z.string(),
		monthly_fee: z.string(),
		fulfillment_options: z.array(z.string()),
		advertising_minimum: z.string(),
	}),
	competitive_landscape: z.object({
		competitor_count: z.string(),
		price_range: z.string(),
		dominant_players: z.array(z.string()),
		differentiation_opportunity: z.string(),
	}),
	operations_requirements: z.object({
		inventory_model: z.string(),
		cs_requirements: z.string(),
		content_requirements: z.array(z.string()),
		update_frequency: z.string(),
	}),
	kpis: z.array(kpi),
});

const launchPhase = z.object({
	phase: z.string(),
	channels: z.array(z.string()),
	timeline: z.string(),
	rationale: z.string(),
});

export const outputSchema = z.object({
	channels: z.array(channelEntry),
	launch_sequence: z.array(launchPhase),
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

export type ChannelStrategyOutput = z.infer<typeof outputSchema>;
