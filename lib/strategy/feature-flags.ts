/**
 * Dependency-free feature flag readers. Kept separate from intent-projection.ts
 * to avoid an import cycle: md-strategy.ts (which defines runGoalAnalysis) must
 * read the flag during prompt selection, but intent-projection.ts (which wraps
 * runGoalAnalysis) also reads the flag. Putting the flag here breaks the cycle.
 */
export function isPhase05Enabled(): boolean {
  return process.env.PHASE_0_5_SEARCH_INTENT_ENABLED === "true";
}
