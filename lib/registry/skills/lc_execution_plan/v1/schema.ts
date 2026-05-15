import { z } from "zod";

const phase = z.object({
	phase: z.string(),
	period: z.string(),
	objectives: z.array(z.string()),
	actions: z.array(
		z.object({
			action: z.string(),
			owner: z.string(),
			deadline: z.string(),
		}),
	),
	budget: z.string(),
	kpis: z.array(
		z.object({
			metric: z.string(),
			target: z.string(),
		}),
	),
});

export const outputSchema = z.object({
	phases: z.array(phase),
	total_investment: z.string(),
	staffing: z.array(
		z.object({
			role: z.string(),
			type: z.string(),
			timing: z.string(),
		}),
	),
	tools_and_services: z.array(
		z.object({
			name: z.string(),
			purpose: z.string(),
			cost: z.string(),
		}),
	),
});

export type ExecutionPlanOutput = z.infer<typeof outputSchema>;
