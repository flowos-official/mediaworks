/**
 * Unit test for the generation compliance block builder (feature A). Pure.
 * Run: npm run test:compliance-context
 */
import assert from "node:assert";
import { buildGenerationComplianceBlock } from "../lib/screenplay/compliance/context";
import type { ComplianceRule, ComplianceReference } from "../lib/screenplay/compliance/types";

const rule = (o: Partial<ComplianceRule>): ComplianceRule => ({
  id: "x", law: "yakkiho", category_scope: [], pattern: "p", is_regex: false,
  allowed: false, severity: "high", reason: "r", safe_rewrite: "", citation: "", active: true, ...o,
});
const ref = (o: Partial<ComplianceReference>): ComplianceReference => ({
  id: "x", law: "yakkiho", category_scope: [], topic: "t", body: "b", keywords: [],
  citation: "c", source_url: "", active: true, ...o,
});

// empty corpus → no-op (empty string)
assert.strictEqual(buildGenerationComplianceBlock(null, [], []), "", "empty → no-op");

// NG + allowed + ref render
const block = buildGenerationComplianceBlock("化粧品", [
  rule({ pattern: "シミが消える", reason: "効能逸脱" }),
  rule({ pattern: "乾燥による小じわを目立たなくする", allowed: true }),
], [ref({ topic: "56効能", body: "範囲内のみ可", category_scope: ["化粧品"] })]);
assert.ok(block.includes("禁止表現"), "has NG section");
assert.ok(block.includes("シミが消える"), "NG pattern rendered");
assert.ok(block.includes("許容表現"), "has allowed section");
assert.ok(block.includes("根拠資料"), "has reference section");
assert.ok(block.includes("56効能"), "reference topic rendered");

// category scoping: a 食品-scoped rule must NOT appear for 化粧品
assert.strictEqual(
  buildGenerationComplianceBlock("化粧品", [rule({ pattern: "痩せる", category_scope: ["食品"] })], []),
  "", "out-of-scope rule excluded → empty",
);

// inactive excluded
assert.strictEqual(buildGenerationComplianceBlock(null, [rule({ active: false })], []), "", "inactive excluded");

// empty-scope rule applies to all categories
assert.ok(
  buildGenerationComplianceBlock("食品", [rule({ pattern: "絶対安全", category_scope: [] })], []).includes("絶対安全"),
  "empty scope = all categories",
);

console.log("[test:compliance-context] PASS");
