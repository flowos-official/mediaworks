/**
 * Dry-run for the live-commerce post-curation boost layers + clamp.
 * Sectioned so each layer can be exercised independently.
 *
 * Usage: npx tsx scripts/test-live-boost-layers.ts
 */
import { clampLiveBoosts } from "@/lib/discovery/live-boost-clamp";
import type { Candidate } from "@/lib/discovery/types";

function makeCandidate(url: string, score: number): Candidate {
	return {
		name: `test ${url}`,
		productUrl: url,
		source: "rakuten",
		seedKeyword: "test",
		track: "tv_proven",
		tvFitScore: score,
		tvFitReason: "baseline",
		isTvApplicable: true,
		isLiveApplicable: true,
		scoreBreakdown: {
			review_signal: 0,
			tv_category_match: 0,
			trend_signal: 0,
			price_fit: 0,
			purchase_signal: 0,
			total: score,
		},
		context: "live_commerce",
	};
}

function assert(cond: boolean, msg: string): void {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
	console.log(`ok: ${msg}`);
}

function testClamp() {
	console.log("\n## clampLiveBoosts");
	// candidate A: delta within cap (no clamp)
	// candidate B: delta exceeds cap (clamp applied)
	// candidate C: not in baseline map (skipped)
	const a = makeCandidate("https://example.com/a", 70); // delta 10 (baseline 60)
	const b = makeCandidate("https://example.com/b", 85); // delta 25 (baseline 60), exceeds +15
	const c = makeCandidate("https://example.com/c", 90); // not in baseline

	const baseline = new Map<string, number>([
		["https://example.com/a", 60],
		["https://example.com/b", 60],
	]);

	const clamped = clampLiveBoosts([a, b, c], baseline, 15);

	assert(clamped === 1, "exactly one candidate clamped");
	assert(a.tvFitScore === 70, "A score unchanged (delta within cap)");
	assert(!a.tvFitReason.includes("合算cap"), "A annotation unchanged");
	assert(b.tvFitScore === 75, "B clamped to baseline+cap (60+15)");
	assert(b.tvFitReason.includes("[合算cap+15]"), "B annotated with clamp");
	assert(c.tvFitScore === 90, "C unaffected (no baseline entry)");
}

testClamp();
console.log("\nall passed");
