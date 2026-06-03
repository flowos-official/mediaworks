/**
 * Live integration: checkScreenplay against seeded rules + Gemini.
 * Requires .env.local + the compliance_rules migration applied.
 * Run: npm run test:screenplay-check
 */
import assert from "node:assert";
import { loadActiveRules, checkScreenplay } from "../lib/screenplay/compliance/check";
import type { ProductBrief } from "../lib/screenplay/types";

async function main() {
	const rules = await loadActiveRules();
	if (rules.length === 0) {
		console.log("[test:screenplay-check] SKIPPED — compliance_rules empty (migration not applied?)");
		return;
	}
	const brief: ProductBrief = {
		name: "モイスチャークリーム",
		category: "化粧品",
		description: "保湿クリーム。希望小売価格3,000円。",
	};
	const markdown = [
		"# モイスチャークリーム 台本",
		"## オープニング",
		"[N] このクリームならシミが消える、まさにアンチエイジングの決定版！",
		"業界初の技術を採用。今だけ500円！",
	].join("\n");

	const result = await checkScreenplay(markdown, brief, rules);
	console.log("[test:screenplay-check]", JSON.stringify(result, null, 2));

	// Deterministic legal findings MUST be present (strict).
	assert.ok(result.legal.some((f) => f.quote.includes("シミが消える")), "expected シミが消える legal flag");
	assert.ok(result.legal.some((f) => f.source === "lexicon"), "expected a lexicon-sourced legal flag");
	// Score reduced from 100 by the findings.
	assert.ok(result.overallScore < 100, "expected overallScore < 100");
	// Shape sanity (LLM axes are loose — presence/shape only).
	assert.ok(Array.isArray(result.facts) && Array.isArray(result.quality), "facts/quality arrays present");
	console.log("[test:screenplay-check] PASS");
}

main().catch((e) => { console.error(e); process.exit(1); });
