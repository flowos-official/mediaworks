import { z } from "zod";

const platformEntry = z.object({
	name: z.string(),
	broadcast_format: z.string(),
	optimal_times: z.array(z.string()),
	frequency: z.string(),
	host_style: z.string(),
	content_ideas: z.array(
		z.object({
			title: z.string(),
			description: z.string(),
			format: z.string(),
		}),
	),
	engagement_tactics: z.array(z.string()),
	sample_script_outline: z.string(),
});

export const outputSchema = z.object({
	platforms: z.array(platformEntry),
	cross_platform_strategy: z.string(),
});

export type ContentStrategyOutput = z.infer<typeof outputSchema>;
