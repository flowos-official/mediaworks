import { projectParsedGoalToIntent } from "@/lib/strategy/intent-projection";

const fullGoal = {
  primary_objective: "",
  target_channels: [],
  seasonal_keywords: ["冬"],
  theme_keywords: ["防寒"],
  category_hints: ["暖房家電"],
  excluded_themes: [],
  intent_tier: "specific_keyword" as const,
  channel_scope: [{ channel_slug: "qvc", raw_mention: "QVC", confidence: 1.0 }],
  specific_keyword: { raw: "包丁", normalized: "包丁", aliases: ["ナイフ"], confidence: 0.95 },
};

// Flag off → tier=broad, channel_scope=[], specific_keyword=null
process.env.PHASE_0_5_SEARCH_INTENT_ENABLED = "false";
const off = projectParsedGoalToIntent(fullGoal);
if (off.intent_tier !== "broad") throw new Error(`flag off → tier should be 'broad', got ${off.intent_tier}`);
if (off.channel_scope?.length !== 0) throw new Error(`flag off → channel_scope should be empty`);
if (off.specific_keyword !== null) throw new Error(`flag off → specific_keyword should be null`);
if (off.seasonal_keywords[0] !== "冬") throw new Error(`flag off → legacy 4 arrays still preserved`);

// Flag on → all new fields preserved
process.env.PHASE_0_5_SEARCH_INTENT_ENABLED = "true";
const on = projectParsedGoalToIntent(fullGoal);
if (on.intent_tier !== "specific_keyword") throw new Error(`flag on → tier mismatch`);
if (on.channel_scope?.[0]?.channel_slug !== "qvc") throw new Error(`flag on → channel_scope mismatch`);
if (on.specific_keyword?.normalized !== "包丁") throw new Error(`flag on → specific_keyword mismatch`);

// Null input → empty
const nullInput = projectParsedGoalToIntent(null);
if (nullInput.intent_tier !== "broad") throw new Error(`null input → tier should be 'broad'`);

console.log("✓ intent-projection-flag tests pass");
