import { z } from "zod";

/**
 * LC ParsedGoal — note the differences from md_strategy/goal_analysis:
 * - target_platforms (TikTok Live etc.), not target_channels
 * - default fallback to ["TikTok Live", "Instagram Live", "YouTube Live"]
 * Runtime normalization enforces array-not-null (PR #16 sibling fix).
 */
export const outputSchema = z.object({
	primary_objective: z.string(),
	target_platforms: z.array(z.string()),
	budget_range: z.string().nullable(),
	timeline: z.string().nullable(),
	target_audience: z.string().nullable(),
});

export type LCParsedGoal = z.infer<typeof outputSchema>;
