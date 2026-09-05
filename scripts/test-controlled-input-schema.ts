/**
 * The schema that makes a controlled input auditable.
 *
 * Two properties are worth pinning as text. Evidence is never deleted — it is
 * REVOKED, so a snapshot taken before a rollback still resolves and the
 * account of what a past recommendation read stays true. And the recommendation
 * mode is where "did anything reach the internet" is answered: widening it to
 * `supplemented` is a schema change, which is the point.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
	"supabase/migrations/20260829160000_controlled_knowledge_inputs.sql",
	"utf8",
).toLowerCase();

assert.ok(sql.includes("create table supplemental_research_runs"), "missing supplemental_research_runs");
assert.ok(
	sql.includes("alter table supplemental_research_runs enable row level security"),
	"supplemental_research_runs must have RLS enabled",
);

// The stored-only pin is deliberately widened HERE and nowhere else.
assert.ok(sql.includes("mode in ('stored_only','supplemented')"), "mode must widen to exactly two values");

// Revocation, not deletion. A deleted evidence row would break the RESTRICT
// from knowledge_snapshot_items and, worse, silently rewrite what a past
// recommendation is recorded as having read.
assert.ok(sql.includes("add column revoked_at"), "evidence must be revocable");
assert.ok(sql.includes("revoked_by"), "a revocation names who did it");
assert.ok(sql.includes("revocation_reason"), "a revocation names why");
assert.ok(sql.includes("add column import_batch_id"), "imported evidence must name its batch");
assert.ok(
	sql.includes("where revoked_at is null"),
	"the active-evidence index must exclude revoked rows, or every consumer pays for them",
);

assert.ok(sql.includes("requested_gaps"), "a supplemental run records exactly what was asked for");
assert.ok(
	sql.includes("cardinality(requested_gaps) > 0"),
	"a research run with no gap is a network call nobody asked for",
);
// The gap enum is closed at the database. A caller cannot invent
// 'actual_competitor_revenue' and have it stored as if we could know it.
for (const gap of [
	"official_product_facts",
	"current_price",
	"seller_sales_claim",
	"review_signal",
	"ranking_signal",
]) {
	assert.ok(sql.includes(`'${gap}'`), `gap ${gap} must be in the allowed set`);
}
assert.ok(
	sql.includes("status in ('queued','running','completed','partial','failed')"),
	"a partial research run is its own state, not a success",
);

// Same grade rule as 20260830100000: these rows derive from member|admin
// canonical_products and evidence_items, so ownership alone is not enough.
const readPolicies = sql
	.split("create policy")
	.slice(1)
	.filter((body) => body.includes("for select"));
assert.ok(readPolicies.length >= 1, "supplemental runs need a read policy");
for (const policy of readPolicies) {
	assert.ok(
		policy.includes("current_user_role() in ('member','admin')"),
		`read policy must inherit the member|admin grade of its sources: ${policy.slice(0, 120)}`,
	);
	assert.ok(policy.includes("auth.uid()"), "read policy must stay owner-scoped");
}

console.log("PASS: controlled input schema");
