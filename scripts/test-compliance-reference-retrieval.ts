/**
 * Unit test for structured reference retrieval. No DB / no network.
 * Run: npm run test:compliance-reference-retrieval
 */
import assert from "node:assert";
import { selectReferences } from "../lib/screenplay/compliance/reference-retrieval";
import type { ComplianceReference } from "../lib/screenplay/compliance/types";

let passed = 0;
function check(label: string, cond: boolean) {
	assert.ok(cond, `FAILED: ${label}`);
	passed++;
}

function ref(over: Partial<ComplianceReference>): ComplianceReference {
	return {
		id: "x", law: "yakkiho", category_scope: [], topic: "t", body: "b",
		keywords: [], citation: "c", source_url: "u", active: true, ...over,
	};
}

const REFS: ComplianceReference[] = [
	ref({ topic: "化粧品56効能", category_scope: ["化粧品"], keywords: ["シミ", "うるおい", "効能"] }),
	ref({ topic: "No.1表示の根拠", law: "keihyo", category_scope: [], keywords: ["No.1", "業界初", "根拠"] }),
	ref({ topic: "健康食品の効能", category_scope: ["健康食品"], keywords: ["免疫", "治る"] }),
	ref({ topic: "無キーワード", category_scope: ["化粧品"], keywords: [] }),
];

// 1. category filter: 健康食品 ref excluded for 化粧品 script
let out = selectReferences("このクリームはシミに効くと評判、業界初の技術。", "化粧品", REFS, 8);
check("includes in-scope keyword-hit ref", out.some((r) => r.topic === "化粧品56効能"));
check("includes empty-scope keihyo ref (業界初 hit)", out.some((r) => r.topic === "No.1表示の根拠"));
check("excludes out-of-scope 健康食品 ref", !out.some((r) => r.topic === "健康食品の効能"));
check("excludes zero-keyword-hit ref", !out.some((r) => r.topic === "無キーワード"));

// 2. ordering: more keyword hits first
out = selectReferences("シミ うるおい 効能 No.1", "化粧品", REFS, 8);
check("higher keyword-overlap ranks first", out[0].topic === "化粧品56効能");

// 3. top-K cap
const many = Array.from({ length: 20 }, (_, i) => ref({ topic: `t${i}`, category_scope: [], keywords: ["x"] }));
out = selectReferences("x", null, many, 8);
check("respects top-K=8", out.length === 8);

// 4. null category: only empty-scope refs eligible
out = selectReferences("業界初", null, REFS, 8);
check("null category keeps empty-scope ref", out.some((r) => r.topic === "No.1表示の根拠"));
check("null category drops category-scoped ref", !out.some((r) => r.topic === "化粧品56効能"));

// 5. determinism: same input → same output
const a = selectReferences("シミ No.1", "化粧品", REFS, 8).map((r) => r.topic).join(",");
const b = selectReferences("シミ No.1", "化粧品", REFS, 8).map((r) => r.topic).join(",");
check("deterministic", a === b);

console.log(`[test:compliance-reference-retrieval] ${passed} assertions passed`);
