import { z } from "zod";

const risk = z.object({
	risk: z.string(),
	category: z.enum(["operational", "financial", "competitive", "regulatory", "market"]),
	likelihood: z.enum(["high", "medium", "low"]),
	impact: z.enum(["high", "medium", "low"]),
	mitigation: z.array(z.string()),
	contingency_trigger: z.string(),
	contingency_action: z.string(),
});

const channelRiskMatrix = z.object({
	channel: z.string(),
	risks: z.array(risk),
});

const top5Risk = z.object({
	risk: z.string(),
	channel: z.string(),
	mitigation_playbook: z.array(z.string()),
	owner: z.string(),
	review_frequency: z.string(),
});

const goNoGo = z.object({
	channel: z.string(),
	criteria: z.array(z.string()),
	decision_date: z.string(),
});

export const outputSchema = z.object({
	risk_matrix: z.array(channelRiskMatrix),
	top_5_risks: z.array(top5Risk),
	go_nogo_criteria: z.array(goNoGo),
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

export type RiskContingencyOutput = z.infer<typeof outputSchema>;
