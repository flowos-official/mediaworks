import { z } from "zod";

const risk = z.object({
	category: z.string(),
	description: z.string(),
	severity: z.enum(["high", "medium", "low"]),
	probability: z.enum(["high", "medium", "low"]),
	mitigation: z.string(),
});

export const outputSchema = z.object({
	risks: z.array(risk),
	contingency_plans: z.array(
		z.object({
			scenario: z.string(),
			response: z.string(),
		}),
	),
	success_factors: z.array(z.string()),
});

export type RiskAnalysisOutput = z.infer<typeof outputSchema>;
