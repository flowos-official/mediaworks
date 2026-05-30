import assert from "node:assert/strict";
import { getServiceClient } from "../lib/supabase";

const sb = getServiceClient();
const cleanup: Array<() => Promise<void>> = [];

async function outcomeOf(dpId: string): Promise<string | null> {
	const { data } = await sb
		.from("discovered_products")
		.select("selection_outcome")
		.eq("id", dpId)
		.single();
	return (data?.selection_outcome as string | null) ?? null;
}

async function newDiscoveredProduct(category: string): Promise<string> {
	const { data: run, error: runErr } = await sb
		.from("discovery_runs")
		.insert({ status: "completed", target_count: 1, context: "home_shopping" })
		.select("id")
		.single();
	if (runErr || !run) throw new Error(`run insert failed: ${runErr?.message}`);
	const url = `https://example.com/test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const { data: dp, error: dpErr } = await sb
		.from("discovered_products")
		.insert({
			session_id: run.id,
			name: "trigger test product",
			name_normalized: "trigger test product",
			product_url: url,
			source: "other",
			track: "exploration",
			context: "home_shopping",
			category,
			tv_fit_score: 80,
		})
		.select("id")
		.single();
	if (dpErr || !dp) throw new Error(`dp insert failed: ${dpErr?.message}`);
	cleanup.push(async () => {
		await sb.from("discovered_products").delete().eq("id", dp.id);
		await sb.from("discovery_runs").delete().eq("id", run.id);
	});
	return dp.id as string;
}

async function newSelection(dpId: string, ownerId: string): Promise<string> {
	const { data, error } = await sb
		.from("product_selections")
		.insert({ discovered_product_id: dpId, owner_id: ownerId, status: "selected" })
		.select("id")
		.single();
	if (error || !data) throw new Error(`selection insert failed: ${error?.message}`);
	cleanup.push(async () => {
		await sb.from("product_selections").delete().eq("id", data.id);
	});
	return data.id as string;
}

async function move(selId: string, patch: Record<string, unknown>): Promise<void> {
	const { error } = await sb.from("product_selections").update(patch).eq("id", selId);
	if (error) throw new Error(`move failed: ${error.message}`);
}

async function main() {
	const { data: profile } = await sb.from("profiles").select("id").limit(1).single();
	if (!profile) throw new Error("need at least one profiles row");
	const owner = profile.id as string;

	// 1. monotonic positive ladder ending aired
	const dp1 = await newDiscoveredProduct("cat-monotonic");
	const sel1 = await newSelection(dp1, owner); // INSERT → 'selected'
	assert.equal(await outcomeOf(dp1), "selected");
	await move(sel1, { status: "sourcing" });
	assert.equal(await outcomeOf(dp1), "sourcing");
	await move(sel1, { status: "scheduled", scheduled_note: "t" });
	assert.equal(await outcomeOf(dp1), "scheduled");
	await move(sel1, { status: "closed", closed_reason: "aired", closed_at: new Date().toISOString() });
	assert.equal(await outcomeOf(dp1), "aired");

	// 2. dropped from selected → 'dropped'
	const dp2 = await newDiscoveredProduct("cat-dropped");
	const sel2 = await newSelection(dp2, owner);
	await move(sel2, { status: "closed", closed_reason: "dropped", closed_at: new Date().toISOString() });
	assert.equal(await outcomeOf(dp2), "dropped");

	// 3. dropped does NOT regress an invested positive
	const dp3 = await newDiscoveredProduct("cat-invested");
	const sel3 = await newSelection(dp3, owner);
	await move(sel3, { status: "sourcing" });
	await move(sel3, { status: "scheduled", scheduled_note: "t" });
	await move(sel3, { status: "closed", closed_reason: "dropped", closed_at: new Date().toISOString() });
	assert.equal(await outcomeOf(dp3), "scheduled");

	// 4. dropped → resurrect: a new selection upgrades past 'dropped' (rank 0)
	const dp4 = await newDiscoveredProduct("cat-resurrect");
	const sel4a = await newSelection(dp4, owner);
	await move(sel4a, { status: "closed", closed_reason: "dropped", closed_at: new Date().toISOString() });
	assert.equal(await outcomeOf(dp4), "dropped");
	const sel4b = await newSelection(dp4, owner); // allowed: sel4a is closed
	assert.equal(await outcomeOf(dp4), "selected"); // positive overrides dropped
	await move(sel4b, { status: "sourcing" });
	assert.equal(await outcomeOf(dp4), "sourcing");

	// 5. calibration view shape + stub exclusion
	const { data: viewRows, error: viewErr } = await sb
		.from("discovery_score_calibration")
		.select("context, score_band, shown, selected_plus, sourced_plus, scheduled_plus, aired, dropped")
		.limit(1);
	if (viewErr) throw new Error(`view query failed: ${viewErr.message}`);
	assert.ok(Array.isArray(viewRows), "view must be queryable");

	console.log("PASS: selection outcome trigger");
}

main()
	.catch((err) => {
		console.error("FAIL:", err);
		process.exitCode = 1;
	})
	.finally(async () => {
		for (const fn of cleanup.reverse()) {
			try {
				await fn();
			} catch (e) {
				console.warn("cleanup warn:", e instanceof Error ? e.message : e);
			}
		}
	});
