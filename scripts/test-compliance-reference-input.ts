/**
 * Unit test for compliance_references input normalization. No DB / no network.
 * Run: npm run test:compliance-reference-input
 */
import assert from "node:assert";
import { normalizeReference } from "../lib/screenplay/compliance/reference-input";

let passed = 0;
function check(label: string, cond: boolean) {
	assert.ok(cond, `FAILED: ${label}`);
	passed++;
}

// 1. valid create
let r = normalizeReference({ law: "keihyo", topic: "No.1", body: "...", category_scope: "化粧品, 健康食品", keywords: "No.1, 根拠", source_url: "https://example.go.jp/x" }, false);
check("valid create ok", r.ok);
if (r.ok) {
	check("category split", Array.isArray(r.value.category_scope) && (r.value.category_scope as string[]).length === 2);
	check("keywords split", Array.isArray(r.value.keywords) && (r.value.keywords as string[]).length === 2);
	check("default active true", r.value.active === true);
}

// 2. invalid law
r = normalizeReference({ law: "nope", topic: "t", body: "b" }, false);
check("invalid law rejected", !r.ok);

// 3. missing topic rejected on create
r = normalizeReference({ law: "other", topic: "  ", body: "b" }, false);
check("empty topic rejected", !r.ok);

// 4. missing body rejected on create
r = normalizeReference({ law: "other", topic: "t", body: "" }, false);
check("empty body rejected", !r.ok);

// 5. invalid source_url rejected (must be http(s) or empty)
r = normalizeReference({ law: "other", topic: "t", body: "b", source_url: "javascript:alert(1)" }, false);
check("non-http url rejected", !r.ok);

// 6. empty source_url allowed
r = normalizeReference({ law: "other", topic: "t", body: "b", source_url: "" }, false);
check("empty url allowed", r.ok);

// 7. partial update only emits provided keys
r = normalizeReference({ active: false }, true);
check("partial emits only active", r.ok && Object.keys(r.value).length === 1 && r.value.active === false);

// 8. partial-mode invalid URL is STILL rejected (the PATCH route uses partial=true,
//    so the citation-URL guard must fire there too — security path).
r = normalizeReference({ source_url: "ftp://bad/x" }, true);
check("partial invalid url rejected", !r.ok);

// 9. partial-mode valid http URL accepted
r = normalizeReference({ source_url: "https://caa.go.jp/x" }, true);
check("partial valid url accepted", r.ok);

// 10. food-axis laws accepted (shokuhin/tokushoho added alongside yakkiho/keihyo/kenzo/other)
r = normalizeReference({ law: "shokuhin", topic: "原産地表示", body: "..." }, false);
check("shokuhin law accepted", r.ok);
r = normalizeReference({ law: "tokushoho", topic: "定期購入の解約条件", body: "..." }, false);
check("tokushoho law accepted", r.ok);

console.log(`[test:compliance-reference-input] ${passed} assertions passed`);
