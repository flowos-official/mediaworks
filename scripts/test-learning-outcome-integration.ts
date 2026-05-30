import assert from "node:assert/strict";
import { getServiceClient } from "../lib/supabase";
import { computeContextLearning } from "../lib/discovery/learning";

const sb = getServiceClient();
const CATEGORY = `__test_aired_${Date.now()}`;
const cleanup: Array<() => Promise<void>> = [];

async function main() {
	const { data: profile } = await sb.from("profiles").select("id").limit(1).single();
	if (!profile) throw new Error("need at least one profiles row");
	const owner = profile.id as string;

	const { data: run } = await sb
		.from("discovery_runs")
		.insert({ status: "completed", target_count: 5, context: "home_shopping" })
		.select("id")
		.single();
	if (!run) throw new Error("run insert failed");
	cleanup.push(async () => {
		await sb.from("discovery_runs").delete().eq("id", run.id);
	});

	for (let i = 0; i < 5; i++) {
		const { data: dp } = await sb
			.from("discovered_products")
			.insert({
				session_id: run.id,
				name: `aired test ${i}`,
				name_normalized: `aired test ${i}`,
				product_url: `https://example.com/aired-${Date.now()}-${i}`,
				source: "other",
				track: "exploration",
				context: "home_shopping",
				category: CATEGORY,
				tv_fit_score: 80,
			})
			.select("id")
			.single();
		if (!dp) throw new Error("dp insert failed");
		cleanup.push(async () => {
			await sb.from("discovered_products").delete().eq("id", dp.id);
		});
		const { data: sel } = await sb
			.from("product_selections")
			.insert({ discovered_product_id: dp.id, owner_id: owner, status: "selected" })
			.select("id")
			.single();
		if (!sel) throw new Error("selection insert failed");
		cleanup.push(async () => {
			await sb.from("product_selections").delete().eq("id", sel.id);
		});
		await sb
			.from("product_selections")
			.update({ status: "closed", closed_reason: "aired", closed_at: new Date().toISOString() })
			.eq("id", sel.id);
	}

	const stats = await computeContextLearning("home_shopping", 0.47);
	const w = stats.category_weights[CATEGORY];
	console.log(`category_weights[${CATEGORY}] = ${w}`);
	// 5 aired (weight 5) / 5 shown = 5 → clamped to cap (default 3)
	assert.equal(w, 3, "aired-heavy category must reach the weight cap");

	console.log("PASS: learning outcome integration");
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
