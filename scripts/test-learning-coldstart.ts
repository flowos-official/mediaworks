import assert from "node:assert/strict";
import { getServiceClient } from "../lib/supabase";
import { computeContextLearning } from "../lib/discovery/learning";

// Guards spec §3's headline behavior change: computeContextLearning must return
// the computed category_weights EVEN on cold-start (so a lagged sourced→aired
// older than the 30d feedback window still counts). The existing integration
// test seeds home_shopping, which carries enough explicit feedback to be
// NON-cold-start, so it only exercises the non-cold branch. live_commerce is the
// structurally low-volume context, so seeding an aired cohort there exercises
// the cold-start branch when its feedback sample is still < COLD_START_THRESHOLD.

const sb = getServiceClient();
const CATEGORY = `__test_coldstart_${Date.now()}`;
const cleanup: Array<() => Promise<void>> = [];

async function seedAired(
	context: "home_shopping" | "live_commerce",
	category: string,
	owner: string,
	n: number,
): Promise<void> {
	const { data: run } = await sb
		.from("discovery_runs")
		.insert({ status: "completed", target_count: n, context })
		.select("id")
		.single();
	if (!run) throw new Error("run insert failed");
	cleanup.push(async () => {
		await sb.from("discovery_runs").delete().eq("id", run.id);
	});
	for (let i = 0; i < n; i++) {
		const { data: dp } = await sb
			.from("discovered_products")
			.insert({
				session_id: run.id,
				name: `coldstart test ${i}`,
				name_normalized: `coldstart test ${i}`,
				product_url: `https://example.com/coldstart-${Date.now()}-${i}`,
				source: "other",
				track: "exploration",
				context,
				category,
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
}

async function main() {
	const { data: profile } = await sb.from("profiles").select("id").limit(1).single();
	if (!profile) throw new Error("need at least one profiles row");
	const owner = profile.id as string;

	await seedAired("live_commerce", CATEGORY, owner, 5);
	const stats = await computeContextLearning("live_commerce", 0.47);
	const w = stats.category_weights[CATEGORY];
	console.log(
		`live_commerce is_cold_start=${stats.is_cold_start} feedback_sample_size=${stats.feedback_sample_size} category_weights[${CATEGORY}]=${w}`,
	);

	// Core invariant (holds in BOTH the cold-start and non-cold branches): the
	// aired cohort surfaces the capped weight. A regression that returns
	// `category_weights: {}` on cold-start would make `w` undefined and fail here
	// whenever live_commerce is cold (the case this test exists to protect).
	assert.equal(w, 3, "aired-heavy category must reach the weight cap regardless of cold-start");

	if (stats.is_cold_start) {
		console.log("✓ cold-start branch exercised — weights returned despite cold-start");
	} else {
		console.log(
			`ⓘ live_commerce not cold-start this run (sample=${stats.feedback_sample_size}); only the non-cold path was validated — the cold-start guard is dormant until volume drops`,
		);
	}

	console.log("PASS: learning cold-start weights");
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
