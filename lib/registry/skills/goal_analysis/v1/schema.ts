import { z } from "zod";

/**
 * LLM contract for goal_analysis output.
 *
 * Strictness rationale:
 * - target_channels MUST be an array (prompt: "null 은 사용하지 마세요").
 *   Null here triggered the cascade failure fixed in PR #16.
 * - The four optional fields may be null (prompt: "言及されていなければ null").
 *   Runtime caller may normalize null → undefined before downstream use.
 * - primary_objective must be a string; an empty string is acceptable.
 */
export const outputSchema = z.object({
	primary_objective: z.string(),
	target_channels: z.array(z.string()),
	target_revenue: z.string().nullable(),
	target_audience: z.string().nullable(),
	budget_constraint: z.string().nullable(),
	timeline: z.string().nullable(),
});

export type ParsedGoal = z.infer<typeof outputSchema>;
