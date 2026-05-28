import type { DiscoverIntent } from "./discover-intent";
import { emptyDiscoverIntent, normalizeDiscoverIntent } from "./discover-intent";
import { isPhase05Enabled } from "./feature-flags";
import type { ParsedGoal } from "@/lib/md-strategy";
import { runGoalAnalysis } from "@/lib/md-strategy";

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
  parsedGoal: ParsedGoal | null | undefined,
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
