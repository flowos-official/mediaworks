import type { DiscoverIntent, IntentTier, ChannelScope, SpecificKeyword } from "./discover-intent";
import { emptyDiscoverIntent, normalizeDiscoverIntent } from "./discover-intent";
import { isPhase05Enabled } from "./feature-flags";
import type { ParsedGoal } from "@/lib/md-strategy";
import { runGoalAnalysis } from "@/lib/md-strategy";

/**
 * Structural subset of MD/LC `ParsedGoal` shared across both pipelines.
 * Only includes the fields this projector reads — keeps the helper
 * pipeline-agnostic so LC's ParsedGoal (with `target_platforms`) and MD's
 * ParsedGoal (with `target_channels`) both flow through unchanged.
 */
export interface ProjectableParsedGoal {
	seasonal_keywords?: string[];
	theme_keywords?: string[];
	category_hints?: string[];
	excluded_themes?: string[];
	intent_tier?: IntentTier;
	channel_scope?: ChannelScope[];
	specific_keyword?: SpecificKeyword | null;
}

// isPhase05Enabled is now imported from "./feature-flags" (Task 7a) to avoid
// circular dependency with md-strategy.ts. Do NOT redefine it here.

/**
 * Project ParsedGoal → DiscoverIntent.
 *
 * Single chokepoint for the Phase 0.5 feature flag. Callers (workflow,
 * runMDSkill, LC workflow, the 3 direct API routes) MUST route through
 * either this function or analyzeGoalToIntent() below. CI grep guard
 * enforces this — see docs/superpowers/specs/.../§9-1.
 *
 * When flag is off: returns legacy 4-array DiscoverIntent with
 * intent_tier='broad', channel_scope=[], specific_keyword=null. Behavior
 * matches pre-Phase-0.5 code paths.
 */
export function projectParsedGoalToIntent(
  parsedGoal: ProjectableParsedGoal | null | undefined,
): DiscoverIntent {
  if (!parsedGoal) return emptyDiscoverIntent();

  const legacyOnly: DiscoverIntent = {
    seasonal_keywords: parsedGoal.seasonal_keywords ?? [],
    theme_keywords: parsedGoal.theme_keywords ?? [],
    category_hints: parsedGoal.category_hints ?? [],
    excluded_themes: parsedGoal.excluded_themes ?? [],
    intent_tier: "broad",
    channel_scope: [],
    specific_keyword: null,
  };

  if (!isPhase05Enabled()) return legacyOnly;

  return normalizeDiscoverIntent({
    ...legacyOnly,
    intent_tier: parsedGoal.intent_tier ?? "broad",
    channel_scope: parsedGoal.channel_scope ?? [],
    specific_keyword: parsedGoal.specific_keyword ?? null,
  });
}

/**
 * Wraps runGoalAnalysis + projectParsedGoalToIntent into a single call.
 * Direct API routes (discovery, MD rediscover, LC rediscover) MUST use
 * this instead of calling runGoalAnalysis themselves — otherwise the
 * grep guard (Task 33) will fail the build.
 *
 * Returns both the ParsedGoal (for persistence) and the projected
 * DiscoverIntent (for the downstream pipeline) in one shot.
 */
export async function analyzeGoalToIntent(
  userGoal: string,
): Promise<{ parsedGoal: ParsedGoal; intent: DiscoverIntent }> {
  const parsedGoal = await runGoalAnalysis(userGoal);
  const intent = projectParsedGoalToIntent(parsedGoal);
  return { parsedGoal, intent };
}

/**
 * Live-Commerce variant of analyzeGoalToIntent. The LC pipeline has its
 * own goal-analysis prompt tuned for live-commerce platforms (TikTok Live /
 * Instagram Live / YouTube Live / etc.) and its own `ParsedGoal` shape
 * (with `target_platforms` instead of `target_channels`).
 *
 * Direct LC API routes (e.g. /api/analytics/live-commerce/[id]/rediscover)
 * MUST use this instead of calling `runLCGoalAnalysis` themselves so the
 * Task 33 grep guard stays green.
 */
export async function analyzeLCGoalToIntent(
  userGoal: string,
): Promise<{ parsedGoal: import("@/lib/live-commerce-strategy").ParsedGoal; intent: DiscoverIntent }> {
  const { runLCGoalAnalysis } = await import("@/lib/live-commerce-strategy");
  const parsedGoal = await runLCGoalAnalysis(userGoal);
  const intent = projectParsedGoalToIntent(parsedGoal);
  return { parsedGoal, intent };
}
