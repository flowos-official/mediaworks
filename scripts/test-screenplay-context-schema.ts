/**
 * The generation-context schema, read as text.
 *
 * Two invariants are worth pinning here rather than discovering in production:
 * the pattern status is a closed set that includes every ABSENCE reason (a
 * pattern that was not applied has to say why — a null column cannot), and a
 * claim link may only be evidence-free when it is explicitly marked for review.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
	"supabase/migrations/20260829150000_screenplay_generation_context.sql",
	"utf8",
).toLowerCase();

for (const table of ["screenplay_generation_contexts", "screenplay_claim_links"]) {
	assert.ok(sql.includes(`create table ${table}`), `missing table ${table}`);
	assert.ok(
		sql.includes(`alter table ${table} enable row level security`),
		`${table} must have RLS enabled`,
	);
}

assert.ok(
	sql.includes("add column generation_context_id"),
	"versions must be able to point at the context they were generated from",
);

// Every way a pattern can be absent is a value, not a null. `disabled` and
// `failed` describe our side; `no_category`, `off_whitelist` and
// `under_sampled` describe the corpus; `timed_out` describes the lookup. A
// reader of an old version must be able to tell which one happened.
assert.ok(
	sql.includes(
		"pattern_status in ('disabled','no_category','off_whitelist','under_sampled','timed_out','failed','applied')",
	),
	"pattern status must enumerate every absence reason",
);
assert.ok(
	sql.includes("status in ('supported','source_claim','needs_review')"),
	"claim status is a closed set",
);

// supported/source_claim carry evidence; needs_review is the only status that
// may not. Written as a biconditional so neither direction can drift.
assert.ok(
	sql.includes("(status = 'needs_review') = (evidence_item_id is null)"),
	"only a needs_review claim may lack evidence, and it must lack it",
);

// A generation context is derived from evidence_items, knowledge_snapshots and
// broadcast_speech_analyses — all member|admin since 20260830100000. A derived
// table inherits the strictest grade among its sources (CLAUDE.md); the
// EXISTS-on-screenplays form the plan sketched relies on RLS nesting to reach
// the same place, which is true today but silently loses the grade if
// screenplays is ever widened.
const readPolicies = sql
	.split("create policy")
	.slice(1)
	.filter((body) => body.includes("for select"));
assert.equal(readPolicies.length, 2, "each table needs exactly one read policy");
for (const policy of readPolicies) {
	assert.ok(
		policy.includes("current_user_role() in ('member','admin')"),
		`read policy must inherit the member|admin grade of its sources: ${policy.slice(0, 120)}`,
	);
}

// Writes stay service-role: the workflow is the only writer, and a member
// write policy would let a user rewrite the account of what a script read.
assert.ok(
	!/create policy[^;]*for (insert|update|delete)/.test(sql),
	"generation contexts and claim links are written by the workflow alone",
);

console.log("PASS: screenplay context schema");
