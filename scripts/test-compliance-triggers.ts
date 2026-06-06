/**
 * Unit test for remediation trigger helpers. Pure (no DB import chain).
 * Run: npm run test:compliance-triggers
 */
import assert from "node:assert";
import { hasHighViolation, remediableFindings, countHigh } from "../lib/screenplay/compliance/triggers";
import type { Finding, ScriptCheckResult } from "../lib/screenplay/compliance/types";

const f = (o: Partial<Finding>): Finding => ({
  axis: "legal", severity: "low", quote: "q", reason: "r", citedRule: "", suggestedRewrite: "", source: "llm", ...o,
});
const result = (o: Partial<ScriptCheckResult>): ScriptCheckResult => ({
  overallScore: 100, legal: [], facts: [], quality: [], ...o,
});

assert.strictEqual(hasHighViolation(result({})), false, "no findings → false");
assert.strictEqual(hasHighViolation(result({ legal: [f({ severity: "high" })] })), true, "legal high → true");
assert.strictEqual(hasHighViolation(result({ facts: [f({ axis: "facts", severity: "high" })] })), true, "facts high → true");
assert.strictEqual(hasHighViolation(result({ legal: [f({ source: "lexicon", severity: "low" })] })), true, "lexicon any severity → true");
assert.strictEqual(hasHighViolation(result({ quality: [f({ axis: "quality", severity: "high" })] })), false, "quality never triggers");

assert.strictEqual(
  remediableFindings(result({ legal: [f({})], facts: [f({ axis: "facts" })], quality: [f({ axis: "quality" })] })).length,
  2, "remediable = legal + facts only",
);
assert.strictEqual(countHigh(result({ legal: [f({ severity: "high" }), f({ source: "lexicon" })], facts: [f({})] })), 2, "countHigh");

console.log("[test:compliance-triggers] PASS");
