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
 *
 * Additive-safety: schema uses .passthrough() so legacy saved-strategy rows
 * that were persisted before any of the newer fields existed are not rejected
 * during parse — unknown keys are forwarded rather than stripped/errored.
 * Never add .strict() to this schema.
 *
 * Field groups:
 * A) Core (original)       — primary_objective … timeline
 * B) DiscoverIntent arrays — seasonal_keywords … excluded_themes
 *    (existed at runtime in runGoalAnalysis but were missing from this schema)
 * C) Phase 0.5 SearchIntent — intent_tier, channel_scope, specific_keyword
 */
export const outputSchema = z
	.object({
		// ── Group A: core goal fields ──────────────────────────────────────────
		primary_objective: z.string(),
		target_channels: z.array(z.string()),
		target_revenue: z.string().nullable(),
		target_audience: z.string().nullable(),
		budget_constraint: z.string().nullable(),
		timeline: z.string().nullable(),

		// ── Group B: DiscoverIntent arrays (synced from runtime ParsedGoal) ───
		seasonal_keywords: z.array(z.string()).default([]),
		theme_keywords: z.array(z.string()).default([]),
		category_hints: z.array(z.string()).default([]),
		excluded_themes: z.array(z.string()).default([]),

		// ── Group C: Phase 0.5 SearchIntent fields ────────────────────────────
		intent_tier: z
			.enum(["broad", "seasonal", "genre", "specific_keyword"])
			.default("broad"),
		channel_scope: z
			.array(
				z.object({
					channel_slug: z.string(),
					raw_mention: z.string(),
					confidence: z.number().min(0).max(1),
				}),
			)
			.default([]),
		specific_keyword: z
			.object({
				raw: z.string(),
				normalized: z.string(),
				aliases: z.array(z.string()).max(6).default([]),
				confidence: z.number().min(0).max(1),
			})
			.nullable()
			.default(null),
	})
	.passthrough();

export type ParsedGoal = z.infer<typeof outputSchema>;
