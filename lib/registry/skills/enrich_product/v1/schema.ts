import { z } from "zod";

const confidence = z.enum(["high", "medium", "low"]);

const manufacturerInfo = z.object({
	name: z.string().nullable(),
	is_seller_same_as_manufacturer: z.boolean(),
	official_site: z.string().nullable(),
	address: z.string().nullable(),
	contact_hints: z.array(z.string()),
	confidence: confidence,
});

const wholesaleEstimate = z.object({
	retail_jpy: z.number(),
	estimated_cost_jpy: z.number().nullable(),
	estimated_margin_rate: z.number().nullable(),
	method: z.enum(["baseline", "blended", "mediaworks_adjusted"]),
	sample_size: z.number(),
	confidence: confidence,
});

const snsTrend = z.object({
	signal_strength: z.enum(["high", "medium", "low", "none"]),
	sources: z.array(z.string()),
});

export const outputSchema = z.object({
	manufacturer: manufacturerInfo,
	wholesale_estimate: wholesaleEstimate,
	moq_hint: z.string().nullable(),
	tv_script_draft: z.string(),
	sns_trend: snsTrend,
	enriched_at: z.string(),
	tool_calls_used: z.number(),
	partial: z.boolean(),
	error: z.string().optional(),
});

export type CPackageOutput = z.infer<typeof outputSchema>;
