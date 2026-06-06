/**
 * Unit test for the remediation engine. Tier1 + grouping are pure; Tier2 is
 * exercised with a FAKE callLLM (no Gemini). No DB / no network.
 * Run: npm run test:screenplay-remediate
 */
import assert from "node:assert";
import { applyDeterministicPatches, groupBySection, remediateSections, remediate } from "../lib/screenplay/remediate";
import type { Finding } from "../lib/screenplay/compliance/types";

const f = (o: Partial<Finding>): Finding => ({
  axis: "legal", severity: "high", quote: "q", reason: "r", citedRule: "", suggestedRewrite: "", source: "llm", ...o,
});

(async () => {
  // --- Tier1: deterministic patch ---
  {
    const md = "[N] シミが消える、業界初の技術。";
    const findings = [
      f({ quote: "シミが消える", suggestedRewrite: "うるおいを与える", source: "lexicon" }),
      f({ quote: "業界初", suggestedRewrite: "", severity: "med", source: "lexicon" }), // no rewrite → remaining
      f({ quote: "に", suggestedRewrite: "へ" }), // quote < 3 chars → skip
    ];
    const r = applyDeterministicPatches(md, findings);
    assert.ok(r.md.includes("うるおいを与える"), "rewrite applied");
    assert.ok(!r.md.includes("シミが消える"), "offending span gone");
    assert.strictEqual(r.patched.length, 1, "1 patched");
    assert.strictEqual(r.remaining.length, 2, "2 remaining (no-rewrite + short)");
  }

  // Tier1 skips self-referential rewrite (rewrite contains quote)
  {
    const r = applyDeterministicPatches("絶対安全です", [f({ quote: "絶対安全", suggestedRewrite: "ほぼ絶対安全" })]);
    assert.strictEqual(r.patched.length, 0, "self-referential rewrite skipped");
    assert.ok(r.md.includes("絶対安全です"), "unchanged");
  }

  // --- grouping by section ---
  {
    const md = ["## 本編", "", "### ■アバン", "[N] シミが消える！", "", "### ■CTA", "[N] お電話を！", ""].join("\n");
    const { groups, unlocatable } = groupBySection(md, [f({ quote: "シミが消える" }), f({ quote: "存在しない文言" })]);
    assert.strictEqual(groups.length, 1, "one affected section");
    assert.strictEqual(groups[0].section.heading, "### ■アバン", "located to ■アバン");
    assert.strictEqual(unlocatable.length, 1, "missing quote is unlocatable");
  }

  // --- Tier2 with fake LLM: only affected section rewritten, siblings verbatim ---
  {
    const md = ["## 本編", "", "### ■アバン", "[N] シミが消える！", "", "### ■CTA", "[N] お電話を！", ""].join("\n");
    const findings = [f({ quote: "シミが消える", reason: "効能逸脱" })];
    const fakeLLM = async () => "### ■アバン\n[N] うるおいを与える！\n";
    const r = await remediateSections(md, findings, fakeLLM, { brief: { name: "x", description: "d" } });
    assert.strictEqual(r.sectionsRewritten, 1, "one section rewritten");
    assert.ok(r.md.includes("うるおいを与える"), "rewrite spliced in");
    assert.ok(!r.md.includes("シミが消える"), "offending text gone");
    assert.ok(r.md.includes("### ■CTA") && r.md.includes("お電話を"), "sibling section intact");
  }

  // Tier2 under-output guard: keep original when LLM returns too-short text
  {
    const md = ["### ■アバン", "とても長い本文がここにたくさん続きます。".repeat(5), ""].join("\n");
    const findings = [f({ quote: "長い本文" })];
    const r = await remediateSections(md, findings, async () => "短い", { brief: { name: "x", description: "d" } });
    assert.strictEqual(r.sectionsRewritten, 0, "too-short rewrite rejected");
    assert.ok(r.md.includes("長い本文"), "original kept");
  }

  // --- remediate orchestrator: Tier1 handles rewritable, Tier2 handles the rest ---
  {
    const md = ["### ■アバン", "[N] シミが消える！ そして最強です。", ""].join("\n");
    const findings = [
      f({ quote: "シミが消える", suggestedRewrite: "うるおいを与える", source: "lexicon" }), // Tier1
      f({ quote: "最強", suggestedRewrite: "", source: "lexicon" }),                          // Tier2
    ];
    const fakeLLM = async () => "### ■アバン\n[N] うるおいを与える！ そして高評価です。\n";
    const out = await remediate(md, findings, fakeLLM, { brief: { name: "x", description: "d" } });
    assert.strictEqual(out.tier1Count, 1, "1 deterministic patch");
    assert.strictEqual(out.sectionsRewritten, 1, "1 section rewrite for the remainder");
    assert.ok(!out.md.includes("最強"), "remainder fixed by Tier2");
  }

  console.log("[test:screenplay-remediate] PASS");
})().catch((e) => { console.error(e); process.exit(1); });
