import { z } from "zod";

export const outputSchema = z.object({
	tv_proven: z.array(z.string()),
	exploration: z.array(z.string()),
	reasoning: z.string().optional(),
});

export type CategoryPlanOutput = z.infer<typeof outputSchema>;
