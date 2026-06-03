/**
 * Unit test for the deterministic compliance lexicon matcher. No DB / no LLM.
 * Run: npm run test:compliance-lexicon
 */
import assert from "node:assert";
import { matchLexicon } from "../lib/screenplay/compliance/lexicon-match";
import type { ComplianceRule } from "../lib/screenplay/compliance/types";

let passed = 0;
function check(label: string, cond: boolean) {
	assert.ok(cond, `FAILED: ${label}`);
	passed++;
}

function rule(over: Partial<ComplianceRule>): ComplianceRule {
	return {
		id: "x", law: "yakkiho", category_scope: [], pattern: "", is_regex: false,
		allowed: false, severity: "med", reason: "r", safe_rewrite: "fix", citation: "c",
		active: true, ...over,
	};
}

const RULES: ComplianceRule[] = [
	rule({ pattern: "シミが消える", category_scope: ["化粧品"], severity: "high" }),
	rule({ pattern: "アンチエイジング", category_scope: ["化粧品"] }),
	rule({ pattern: "業界初", law: "keihyo", category_scope: [] }),
	rule({ pattern: "乾燥による小じわを目立たなくする", category_scope: ["化粧品"], allowed: true }),
];

// 1. literal hit, category in scope
let f = matchLexicon("このクリームはシミが消えると評判です。", RULES, "化粧品");
check("hits シミが消える for 化粧品", f.some((x) => x.quote.includes("シミが消える") && x.severity === "high"));

// 2. category NOT in scope → 化粧品-scoped rule does not fire
f = matchLexicon("シミが消える", RULES, "健康食品");
check("does not fire 化粧品 rule for 健康食品", !f.some((x) => x.quote.includes("シミが消える")));

// 3. empty-scope rule (keihyo) fires regardless of category
f = matchLexicon("業界初の技術！", RULES, "家電");
check("empty-scope keihyo rule fires for any category", f.some((x) => x.quote.includes("業界初")));

// 4. allowed (whitelist) phrase never produces a finding
f = matchLexicon("乾燥による小じわを目立たなくする（効能評価試験済み）", RULES, "化粧品");
check("allowed/whitelist phrase is not flagged", f.length === 0);

// 5. all lexicon findings are axis=legal, source=lexicon
f = matchLexicon("シミが消える、業界初。", RULES, "化粧品");
check("lexicon findings are legal+lexicon", f.length >= 2 && f.every((x) => x.axis === "legal" && x.source === "lexicon"));

// 6+7. Text-span suppression: an NG pattern that is a SUBSTRING of an allowed
// phrase must still fire when it occurs standalone, and be suppressed only when
// it occurs inside the allowed phrase span.
const RULES_SUB: ComplianceRule[] = [
	...RULES,
	rule({ pattern: "目立たなく", category_scope: ["化粧品"], severity: "med" }),
];
f = matchLexicon("シワが目立たなくなります。", RULES_SUB, "化粧品");
check("NG substring fires when outside any allowed span", f.some((x) => x.quote === "目立たなく"));
f = matchLexicon("乾燥による小じわを目立たなくする（効能評価試験済み）", RULES_SUB, "化粧品");
check("NG substring suppressed when only inside an allowed span", !f.some((x) => x.quote === "目立たなく"));

console.log(`[test:compliance-lexicon] ${passed} assertions passed`);
