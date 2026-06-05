/**
 * Unit test for grounding snapshot + corpus hash. No DB / no network.
 * Run: npm run test:compliance-grounding
 */
import assert from "node:assert";
import { buildReferenceSnapshot, corpusHashOf } from "../lib/screenplay/compliance/grounding";
import type { ComplianceReference } from "../lib/screenplay/compliance/types";

let passed = 0;
function check(label: string, cond: boolean) {
	assert.ok(cond, `FAILED: ${label}`);
	passed++;
}

function ref(over: Partial<ComplianceReference>): ComplianceReference {
	return {
		id: "a", law: "yakkiho", category_scope: ["化粧品"], topic: "t", body: "原本の本文",
		keywords: ["k1", "k2"], citation: "出典", source_url: "https://x.go.jp/a", active: true, ...over,
	};
}

// --- snapshot completeness (Codex audit #2) ---
const refs = [
	ref({ id: "a", body: "化粧品56効能の本文", category_scope: ["化粧品", "医薬部外品"], keywords: ["シミ", "うるおい"] }),
	ref({ id: "b", body: "No.1根拠の本文", law: "keihyo", category_scope: [], keywords: ["No.1"] }),
];
const snap = buildReferenceSnapshot(refs);
check("snapshot preserves count + order", snap.length === 2 && snap[0].id === "a" && snap[1].id === "b");
check("snapshot carries body (the injected prompt text)", snap[0].body === "化粧品56効能の本文");
check("snapshot carries category_scope (drives retrieval)", snap[0].category_scope.length === 2 && snap[0].category_scope.includes("化粧品") && snap[0].category_scope.includes("医薬部外品"));
check("snapshot carries keywords (drives retrieval)", snap[0].keywords.length === 2 && snap[0].keywords.includes("シミ") && snap[0].keywords.includes("うるおい"));
check("snapshot carries citation + source_url", snap[0].citation === "出典" && snap[0].source_url === "https://x.go.jp/a");

// snapshot is independent of later edits to the source object (deep copy of arrays)
refs[0].category_scope.push("健康食品");
check("snapshot array is a copy, not a live reference", snap[0].category_scope.length === 2);

// --- corpus hash ---
const h1 = corpusHashOf([ref({ id: "a", body: "X" }), ref({ id: "b", body: "Y" })]);
const h2 = corpusHashOf([ref({ id: "b", body: "Y" }), ref({ id: "a", body: "X" })]);
check("corpusHash is order-independent", h1 === h2);
check("corpusHash is deterministic", corpusHashOf([ref({ id: "a", body: "X" })]) === corpusHashOf([ref({ id: "a", body: "X" })]));

// drift detection: editing ANY injected field changes the hash
const base = [ref({ id: "a", body: "B", citation: "C", source_url: "https://x.go.jp/a", topic: "T", keywords: ["k"] })];
const baseHash = corpusHashOf(base);
check("body edit changes hash", corpusHashOf([ref({ id: "a", body: "B2", citation: "C", source_url: "https://x.go.jp/a", topic: "T", keywords: ["k"] })]) !== baseHash);
check("citation edit changes hash", corpusHashOf([ref({ id: "a", body: "B", citation: "C2", source_url: "https://x.go.jp/a", topic: "T", keywords: ["k"] })]) !== baseHash);
check("source_url edit changes hash", corpusHashOf([ref({ id: "a", body: "B", citation: "C", source_url: "https://x.go.jp/b", topic: "T", keywords: ["k"] })]) !== baseHash);
check("topic edit changes hash", corpusHashOf([ref({ id: "a", body: "B", citation: "C", source_url: "https://x.go.jp/a", topic: "T2", keywords: ["k"] })]) !== baseHash);
check("keywords edit changes hash", corpusHashOf([ref({ id: "a", body: "B", citation: "C", source_url: "https://x.go.jp/a", topic: "T", keywords: ["k", "k2"] })]) !== baseHash);

// empty corpus → stable non-throwing hash
check("empty corpus hashes without throwing", typeof corpusHashOf([]) === "string" && corpusHashOf([]) === corpusHashOf([]));

console.log(`[test:compliance-grounding] ${passed} assertions passed`);
