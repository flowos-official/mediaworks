import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
	"supabase/migrations/20260829140000_product_finder_runs.sql",
	"utf8",
).toLowerCase();

for (const table of [
	"product_recommendation_runs",
	"product_recommendation_items",
	"product_recommendation_decisions",
]) {
	assert.ok(sql.includes(`create table ${table}`), `missing table ${table}`);
	assert.ok(
		sql.includes(`alter table ${table} enable row level security`),
		`${table} must have RLS enabled`,
	);
}

assert.ok(sql.includes("mode = 'stored_only'"), "runs must be pinned to stored_only");
assert.ok(sql.includes("expected_contribution_profit_jpy numeric"), "profit column must stay nullable numeric");
assert.ok(sql.includes("decision in ('interested','excluded')"), "decisions are a closed set");

// A run is completed only together with its snapshot and completion time —
// the guarantee that every finished recommendation can say what it consumed.
assert.ok(
	sql.includes("knowledge_snapshot_id is not null and completed_at is not null"),
	"completion must imply a knowledge snapshot",
);

// These tables are derived from canonical_products and evidence_items, both
// member|admin. 20260830100000_intelligence_access_grades.sql exists because
// the last derived tables shipped wider than their sources; owner-only is not
// enough on its own, because a viewer who owns a row would still be reading
// member-only data through it.
const readPolicies = sql
	.split("create policy")
	.slice(1)
	.filter((body) => body.includes("for select"));
assert.equal(readPolicies.length, 3, "each of the three tables needs a read policy");
for (const policy of readPolicies) {
	assert.ok(
		policy.includes("current_user_role() in ('member','admin')"),
		`read policy must inherit the member|admin grade of its sources: ${policy.slice(0, 120)}`,
	);
	assert.ok(
		policy.includes("auth.uid()"),
		`read policy must still be owner-scoped: ${policy.slice(0, 120)}`,
	);
}

console.log("PASS: product finder schema");
