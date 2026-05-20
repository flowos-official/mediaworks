import { z } from "zod";

const recommendedChannel = z.object({
	name: z.string(),
	priority: z.enum(["primary", "secondary"]),
	rationale: z.string(),
});

const salesStrategy = z.object({
	positioning: z.string(),
	unique_value_prop: z.string(),
	target_segment: z.string(),
	key_selling_points: z.array(z.string()),
	recommended_channels: z.array(recommendedChannel),
	pricing_approach: z.string(),
	bundle_ideas: z.array(z.string()),
	promo_hook: z.string(),
	launch_timing: z.string(),
	content_angle: z.string(),
	content_pillars: z.array(z.string()),
	competitor_diff: z.string(),
	first_30_days: z.array(z.string()),
	risks: z.array(z.string()),
});

const japanMarketFit = z.object({
	popularity_evidence: z.string(),
	trend_context: z.string(),
	why_japan_now: z.string(),
	review_signal: z.string().optional(),
});

const discoveredProduct = z.object({
	name: z.string(),
	reason: z.string(),
	japan_fit_score: z.number(),
	estimated_demand: z.string(),
	supply_source: z.string(),
	estimated_price_jpy: z.string(),
	source: z.enum(["rakuten", "web"]),
	source_url: z.string(),
	ranking_info: z.string().optional(),
	signal_basis: z.string(),
	japan_market_fit: japanMarketFit,
	sales_strategy: salesStrategy.optional(),
	// Restored post-curation from the pool index; not produced by the LLM directly.
	pool_source: z.enum(["discovery_pool", "fresh_search", "seed", "research"]).optional(),
	discovered_product_id: z.string().optional(),
	tv_channel_source: z.string().nullable().optional(),
});

export const outputSchema = z.array(discoveredProduct);

export type DiscoverCurationOutput = z.infer<typeof outputSchema>;
