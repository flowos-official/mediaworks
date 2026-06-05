/**
 * Unit test for fact-claim extraction heuristic. No DB / no network.
 * Run: npm run test:compliance-fact-extract
 */
import assert from "node:assert";
import {
	extractFactClaims,
	isHttpUrl,
	buildAllowedUrls,
	filterReferences,
	capEvidencePerClaim,
	type FactEvidence,
} from "../lib/screenplay/compliance/fact-search";

let passed = 0;
function check(label: string, cond: boolean) {
	assert.ok(cond, `FAILED: ${label}`);
	passed++;
}

const SCRIPT = [
	"こんにちは、本日の商品をご紹介します。",          // no number/superlative → skip
	"なんと売上No.1の実績があります。",                 // superlative
	"通常価格9,800円のところ、本日は5,980円。",         // number+円
	"愛用者の98%が満足と回答しました。",                // number+%
	"気持ちのいい肌ざわりです。",                       // skip
	"業界初の新技術を採用。",                           // superlative
].join("\n");

const claims = extractFactClaims(SCRIPT, 5);
check("picks the No.1 claim", claims.some((c) => c.includes("No.1")));
check("picks the price claim", claims.some((c) => c.includes("9,800円") || c.includes("5,980円")));
check("picks the percentage claim", claims.some((c) => c.includes("98%")));
check("picks the 業界初 claim", claims.some((c) => c.includes("業界初")));
check("skips the plain greeting", !claims.some((c) => c.includes("こんにちは")));
check("skips the plain 肌ざわり line", !claims.some((c) => c.includes("肌ざわり")));
check("respects maxClaims cap", extractFactClaims(SCRIPT, 2).length === 2);
check("dedupes / returns array", Array.isArray(claims));

// --- citation allowlist validation (Codex #2) ---
check("isHttpUrl accepts https", isHttpUrl("https://x.go.jp/a"));
check("isHttpUrl rejects javascript:", !isHttpUrl("javascript:alert(1)"));
check("isHttpUrl rejects empty", !isHttpUrl(""));

const evidence: FactEvidence[] = [
	{ claim: "c", results: [
		{ title: "A", description: "", url: "https://caa.go.jp/a" },
		{ title: "B", description: "", url: "ftp://bad/x" },
	] },
];
const allowed = buildAllowedUrls(["https://mhlw.go.jp/56", "notaurl"], evidence);
check("allowlist keeps http corpus url", allowed.has("https://mhlw.go.jp/56"));
check("allowlist keeps http evidence url", allowed.has("https://caa.go.jp/a"));
check("allowlist drops non-http corpus url", !allowed.has("notaurl"));
check("allowlist drops non-http evidence url", !allowed.has("ftp://bad/x"));

const filtered = filterReferences(
	[
		{ title: "real", url: "https://caa.go.jp/a" },        // in allowlist
		{ title: "hallucinated", url: "https://evil.example/x" }, // NOT in allowlist
		{ title: "scheme", url: "javascript:alert(1)" },      // bad scheme
	],
	allowed,
);
check("filterReferences keeps only allowlisted http url", filtered.length === 1 && filtered[0].url === "https://caa.go.jp/a");

// --- render/allowlist parity (Codex audit #3) ---
// Brave returned 5 results for a claim but only the first 3 are rendered into the
// prompt. The allowlist must be built from the capped (shown) set, so URLs 4-5
// can never pass validation even though search fetched them.
const fiveResults: FactEvidence[] = [
	{ claim: "c", results: [
		{ title: "1", description: "", url: "https://caa.go.jp/1" },
		{ title: "2", description: "", url: "https://caa.go.jp/2" },
		{ title: "3", description: "", url: "https://caa.go.jp/3" },
		{ title: "4", description: "", url: "https://caa.go.jp/4" },
		{ title: "5", description: "", url: "https://caa.go.jp/5" },
	] },
];
const capped = capEvidencePerClaim(fiveResults, 3);
check("capEvidencePerClaim caps results to n", capped[0].results.length === 3);
check("capEvidencePerClaim preserves claim", capped[0].claim === "c");
const cappedAllowed = buildAllowedUrls([], capped);
check("allowlist includes shown URL #3", cappedAllowed.has("https://caa.go.jp/3"));
check("allowlist EXCLUDES unshown URL #4", !cappedAllowed.has("https://caa.go.jp/4"));
check("allowlist EXCLUDES unshown URL #5", !cappedAllowed.has("https://caa.go.jp/5"));
const unshown = filterReferences([{ title: "u4", url: "https://caa.go.jp/4" }], cappedAllowed);
check("filterReferences rejects an unshown (4th) evidence URL", unshown.length === 0);
check("capEvidencePerClaim n=0 yields empty results", capEvidencePerClaim(fiveResults, 0)[0].results.length === 0);

console.log(`[test:compliance-fact-extract] ${passed} assertions passed`);
