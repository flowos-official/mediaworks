import { z } from "zod";

export const outputSchema = z.object({
	market_size: z.string(),
	growth_rate: z.string(),
	key_trends: z.array(
		z.object({
			trend: z.string(),
			description: z.string(),
		}),
	),
	major_players: z.array(
		z.object({
			name: z.string(),
			platform: z.string(),
			description: z.string(),
		}),
	),
	consumer_behavior: z.string(),
	market_outlook: z.string(),
	sources_referenced: z.array(z.number()),
});

export type MarketResearchOutput = z.infer<typeof outputSchema>;
