import { z } from "zod";

export const outputSchema = z.object({
	sourced_product_patterns: z.string(),
	exploration_wins: z.string(),
	next_week_suggestions: z.string(),
});

export type WeeklyInsightOutput = z.infer<typeof outputSchema>;
