/**
 * Unit test for compliance_rules input normalization. No DB / no network.
 * Run: npm run test:compliance-rule-input
 */
import assert from "node:assert";
import { normalizeRule, isUnsafeRegex, validateRegexPattern } from "../lib/screenplay/compliance/rule-input";

let passed = 0;
function check(label: string, cond: boolean) {
	assert.ok(cond, `FAILED: ${label}`);
	passed++;
}

// 1. valid create
let r = normalizeRule({ law: "yakkiho", pattern: "シミが消える", severity: "high", category_scope: "化粧品, 医薬部外品" }, false);
check("valid create ok", r.ok);
if (r.ok) {
	check("law preserved", r.value.law === "yakkiho");
	check("pattern trimmed/preserved", r.value.pattern === "シミが消える");
	check("category split into array", Array.isArray(r.value.category_scope) && (r.value.category_scope as string[]).length === 2);
	check("severity preserved", r.value.severity === "high");
	check("defaults active=true on create", r.value.active === true);
	check("defaults allowed=false on create", r.value.allowed === false);
	check("defaults is_regex=false", r.value.is_regex === false);
}

// 2. invalid law
r = normalizeRule({ law: "nope", pattern: "x" }, false);
check("invalid law rejected", !r.ok);

// 3. empty pattern rejected on create
r = normalizeRule({ law: "keihyo", pattern: "   " }, false);
check("empty pattern rejected", !r.ok);

// 4. invalid severity rejected
r = normalizeRule({ law: "keihyo", pattern: "業界初", severity: "extreme" }, false);
check("invalid severity rejected", !r.ok);

// 5. invalid regex rejected when is_regex=true
r = normalizeRule({ law: "keihyo", pattern: "(unclosed", is_regex: true }, false);
check("invalid regex rejected", !r.ok);

// 6. valid regex accepted
r = normalizeRule({ law: "keihyo", pattern: "No\\.?1", is_regex: true }, false);
check("valid regex accepted", r.ok);

// 6b. catastrophic-backtracking regex rejected (ReDoS guard)
r = normalizeRule({ law: "keihyo", pattern: "(a+)+$", is_regex: true }, false);
check("nested-quantifier ReDoS regex rejected", !r.ok);

// 6c. isUnsafeRegex unit cases
check("isUnsafeRegex (a+)+ true", isUnsafeRegex("(a+)+"));
check("isUnsafeRegex (a*)* true", isUnsafeRegex("(a*)*"));
check("isUnsafeRegex (.*)+ true", isUnsafeRegex("(.*)+"));
check("isUnsafeRegex ((a)+)+ true", isUnsafeRegex("((a)+)+"));
check("isUnsafeRegex {n,} nested true", isUnsafeRegex("(a{2,}){3,}"));
check("isUnsafeRegex No\\.?1 false", !isUnsafeRegex("No\\.?1"));
check("isUnsafeRegex (株式|有限)会社 false", !isUnsafeRegex("(株式|有限)会社"));
check("isUnsafeRegex (ab+)c false (group not quantified)", !isUnsafeRegex("(ab+)c"));
check("isUnsafeRegex bounded (a+){2,4} false", !isUnsafeRegex("(a+){2,4}"));
check("isUnsafeRegex char-class [a+]+ false", !isUnsafeRegex("[a+]+"));

// 6d. validateRegexPattern returns null on safe, string on unsafe/invalid
check("validateRegexPattern safe → null", validateRegexPattern("No\\.?1") === null);
check("validateRegexPattern ReDoS → error", typeof validateRegexPattern("(a+)+$") === "string");
check("validateRegexPattern invalid → error", typeof validateRegexPattern("(unclosed") === "string");
check("validateRegexPattern overlong → error", typeof validateRegexPattern("a".repeat(201)) === "string");

// 6e. partial update toggling is_regex with a stored-unsafe pattern is caught at
// the route layer (validateRegexPattern); here confirm normalizeRule still
// rejects when both arrive together.
r = normalizeRule({ pattern: "(x+)+", is_regex: true }, true);
check("partial create-with-unsafe-regex rejected", !r.ok);

// 7. partial update only emits provided keys
r = normalizeRule({ active: false }, true);
check("partial emits only active", r.ok && Object.keys(r.value).length === 1 && r.value.active === false);

// 8. partial update with empty pattern present is rejected (can't blank a pattern)
r = normalizeRule({ pattern: "" }, true);
check("partial empty pattern rejected", !r.ok);

// 9. partial update does NOT inject defaults (no active when absent)
r = normalizeRule({ reason: "updated" }, true);
check("partial no default active", r.ok && !("active" in r.value) && r.value.reason === "updated");

// 10. category_scope array passthrough + trim
r = normalizeRule({ law: "yakkiho", pattern: "x", category_scope: [" 化粧品 ", "", "健康食品"] }, false);
check("array category trimmed + empties dropped", r.ok && JSON.stringify(r.value.category_scope) === JSON.stringify(["化粧品", "健康食品"]));

// 11. overlong pattern rejected
r = normalizeRule({ law: "keihyo", pattern: "あ".repeat(501) }, false);
check("overlong pattern rejected", !r.ok);

// 12. non-object input coerced safely (no throw), rejected for missing law on create
r = normalizeRule(null, false);
check("null input rejected gracefully on create", !r.ok);

// 13. food-axis laws accepted (shokuhin/tokushoho added alongside yakkiho/keihyo/kenzo)
r = normalizeRule({ law: "shokuhin", pattern: "国産100%" }, false);
check("shokuhin law accepted", r.ok);
r = normalizeRule({ law: "tokushoho", pattern: "定期便の解約条件" }, false);
check("tokushoho law accepted", r.ok);

console.log(`[test:compliance-rule-input] ${passed} assertions passed`);
