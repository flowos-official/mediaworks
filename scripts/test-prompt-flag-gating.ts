import { runGoalAnalysis } from "@/lib/md-strategy";

process.env.PHASE_0_5_SEARCH_INTENT_ENABLED = "false";

async function main() {
  // Use a goal that WOULD trigger tier=specific_keyword if flag were on
  const result = await runGoalAnalysis("テレ東マートで売れる包丁");

  if (result.intent_tier !== "broad") {
    throw new Error(`flag off → tier should be 'broad', got ${result.intent_tier}`);
  }
  if ((result.channel_scope?.length ?? 0) !== 0) {
    throw new Error(`flag off → channel_scope should be empty`);
  }
  if (result.specific_keyword !== null && result.specific_keyword !== undefined) {
    throw new Error(`flag off → specific_keyword should be null/undefined`);
  }
  console.log("✓ prompt-flag-gating test passes");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
