import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Static route review.
 *
 * These are assertions about the SHAPE of the routes, not their behaviour:
 * "does every entry point gate on a role" and "can any of them reach a search
 * provider" are questions a reader has to answer by grepping otherwise, and
 * the answer changes silently when someone adds a convenience import.
 */

const ROUTES = [
	"app/api/product-finder/route.ts",
	"app/api/product-finder/runs/[runId]/route.ts",
	"app/api/product-finder/runs/[runId]/items/[itemId]/decision/route.ts",
];

const sources = new Map(ROUTES.map((path) => [path, readFileSync(path, "utf8")]));

// --- every route is gated ---------------------------------------------------
for (const [path, src] of sources) {
	assert.ok(src.includes("requireUser("), `${path} must call requireUser`);
	assert.ok(
		/requireUser\(\[\s*"member",\s*"admin"\s*\]\)/.test(src),
		`${path} must gate on member|admin — a viewer must not reach derived member-only evidence`,
	);
	assert.ok(src.includes('if ("error" in auth) return auth.error'), `${path} must return the auth error`);
}
console.log("✓ every product-finder route gates on member|admin");

// --- no route reaches outside ----------------------------------------------
// The surface is defined by what it does NOT do. An import added for
// convenience would turn a free, auditable read into a metered search without
// changing any behaviour a test would notice.
for (const [path, src] of sources) {
	for (const forbidden of [
		"@/lib/brave",
		"@/lib/rakuten",
		"@google/genai",
		"@/lib/gemini",
		"/api/analyze",
		"/api/recommend",
		"/api/screenplay",
	]) {
		assert.ok(!src.includes(forbidden), `${path} must not reference ${forbidden}`);
	}
}
console.log("✓ no route imports a search provider, a model, or a downstream job");

// --- the POST runs the stored-only service ---------------------------------
{
	const post = sources.get("app/api/product-finder/route.ts")!;
	assert.ok(post.includes("runStoredProductFinder"), "POST must call the stored-only runner");
	assert.ok(post.includes("parseProductFinderQuery"), "POST must parse strictly");
	// A supplemented request is refused, not downgraded: external research costs
	// money, and an operator who asked for it must learn it did not happen.
	assert.ok(post.includes("explicit_supplement_required"), "POST must refuse a supplemented mode");
	assert.ok(post.includes("409"), "the refusal is a 409, not a silent stored-only answer");
	assert.ok(post.includes("product_finder_failed"), "a failed run answers with a stable code");
	assert.ok(post.includes("{ status: 201 }"), "a created run answers 201");
}
console.log("✓ POST parses strictly, refuses supplement, and returns stable codes");

// --- GET is owner-scoped ----------------------------------------------------
{
	const get = sources.get("app/api/product-finder/runs/[runId]/route.ts")!;
	assert.ok(get.includes('.eq("created_by", auth.user.id)'), "GET must scope by owner as well as id");
	assert.ok(get.includes('{ status: 404 }'), "another user's run is a 404, not an empty 200");
}
console.log("✓ GET scopes by run id and owner");

// --- the decision route records a decision and nothing else -----------------
{
	const decision = sources.get(
		"app/api/product-finder/runs/[runId]/items/[itemId]/decision/route.ts",
	)!;
	assert.ok(decision.includes('onConflict: "item_id,user_id"'), "a decision is upserted per user");
	assert.ok(
		decision.includes('.eq("run_id", runId)'),
		"the item must be verified as belonging to the run in the path",
	);
	// Marking a row interesting is a note to oneself. A surface that silently
	// starts downstream work from one click teaches operators not to click.
	for (const downstream of ["product_selections", "research_results", "discovered_products"]) {
		assert.ok(!decision.includes(downstream), `a decision must not write ${downstream}`);
	}
}
console.log("✓ a decision records interest only and triggers nothing downstream");

// --- writes are possible at all ---------------------------------------------
// The first migration shipped SELECT policies only while the run service writes
// through the USER's client, so every run would have failed at its first
// insert. This pins the follow-up.
{
	const policies = readFileSync(
		"supabase/migrations/20260829141000_product_finder_write_policies.sql",
		"utf8",
	).toLowerCase();
	for (const needed of [
		"product_recommendation_runs_owner_insert",
		"product_recommendation_runs_owner_update",
		"product_recommendation_items_owner_insert",
		"product_recommendation_decisions_owner_insert",
		"product_recommendation_decisions_owner_update",
	]) {
		assert.ok(policies.includes(needed), `missing write policy ${needed}`);
	}
	assert.ok(!policies.includes("for delete"), "a run is an audit record; nothing grants DELETE");
	// An UPDATE that could change created_by would let a completing write hand
	// the run to another user.
	assert.ok(
		policies.includes("with check (created_by = auth.uid())"),
		"an update must not be able to reassign ownership",
	);
}
console.log("✓ owner-scoped write policies exist and cannot reassign a run");

// --- dynamic segments must not collide -------------------------------------
// Next.js refuses two different slug names at the same path position, and it
// refuses at BOOT — the whole app fails to start, not just this route. The
// plan specified `runs/[id]` and `runs/[runId]/items/...` side by side and the
// dev server would not come up. Reading file contents cannot see this; only
// the shape of the tree can.
{
	const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
	const { join } = require("node:path") as typeof import("node:path");

	const slugsByParent = new Map<string, Set<string>>();
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (!statSync(full).isDirectory()) continue;
			const slug = /^\[(?!\.{3})([^\]]+)\]$/.exec(entry)?.[1];
			if (slug) {
				const held = slugsByParent.get(dir);
				if (held) held.add(slug);
				else slugsByParent.set(dir, new Set([slug]));
			}
			walk(full);
		}
	};
	walk("app/api/product-finder");

	for (const [parent, slugs] of slugsByParent) {
		assert.equal(
			slugs.size,
			1,
			`${parent} has conflicting dynamic segments [${[...slugs].join(", ")}] — Next.js will not boot`,
		);
	}
}
console.log("✓ no two dynamic segments collide at the same path position");

console.log("PASS: product finder routes");
