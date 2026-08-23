import { projectParsedGoalToIntent } from "@/lib/strategy/intent-projection";

// Simulate a legacy saved ParsedGoal — no new fields
const legacy = {
  primary_objective: "test",
  target_channels: [],
  seasonal_keywords: ["冬"],
  theme_keywords: [],
  category_hints: [],
  excluded_themes: [],
  // intent_tier, channel_scope, specific_keyword missing
};

process.env.PHASE_0_5_SEARCH_INTENT_ENABLED = "true";
const out = projectParsedGoalToIntent(legacy);

if (out.intent_tier !== "broad") throw new Error(`legacy → tier should default to 'broad', got ${out.intent_tier}`);
if ((out.channel_scope?.length ?? 0) !== 0) throw new Error(`legacy → channel_scope should be []`);
if (out.specific_keyword !== null && out.specific_keyword !== undefined) throw new Error(`legacy → specific_keyword should be null`);
if (out.seasonal_keywords[0] !== "冬") throw new Error(`legacy 4 arrays should still be carried over`);

console.log("✓ backward-compat-parsed-goal test passes");
