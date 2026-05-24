/**
 * Dry-run for the live-commerce post-curation boost layers + clamp.
 * Sectioned so each layer can be exercised independently.
 *
 * Usage: npx tsx scripts/test-live-boost-layers.ts
 */
import { clampLiveBoosts } from "@/lib/discovery/live-boost-clamp";
import { applyRakutenRoomBoost } from "@/lib/discovery/rakuten-room-boost";
import { applyRakutenLiveArchiveBoost } from "@/lib/discovery/rakuten-live-archive-boost";
import { applyCreatorContentBoost } from "@/lib/discovery/creator-content-boost";
import { applyHashtagMentionBoost } from "@/lib/discovery/hashtag-mention-boost";
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

function testClampEdgeCase() {
	console.log("\n## clampLiveBoosts (edge case: baseline + cap > 100)");
	// Edge case: baseline 95, cap 15, score 111 (delta 16, exceeds cap)
	// → should clamp to 100 via Math.min, not 110 (baseline + cap)
	const d = makeCandidate("https://example.com/d", 111); // delta 16 (baseline 95), exceeds +15

	const baseline = new Map<string, number>([["https://example.com/d", 95]]);

	clampLiveBoosts([d], baseline, 15);

	assert(d.tvFitScore === 100, "D clamped to 100 via Math.min (not 110)");
	assert(d.tvFitReason.includes("[合算cap+15]"), "D annotated with clamp");
}

async function testBoostSmoke() {
	console.log("\n## boost smoke (calls Brave — outputs are observational)");

	// Two candidates: one well-known (likely to trigger several boosts),
	// one obscure (likely to trigger none). Adjust names if Brave quota
	// is exhausted or you want to retarget.
	const seeded: Candidate[] = [
		{
			...makeCandidate("https://item.rakuten.co.jp/lululun/lululun01/", 70),
			name: "ルルルン プレシャス フェイスマスク",
			rakutenItemCode: "lululun:lululun01",
		},
		{
			...makeCandidate("https://item.rakuten.co.jp/none/zzz_obscure_test_item_xyz/", 70),
			name: "Z_obscure_test_item_xyz_あ",
			rakutenItemCode: "none:zzz_obscure_test_item_xyz",
		},
	];

	const print = (label: string) => {
		for (const c of seeded) {
			console.log(`  ${label}: "${c.name}" → ${c.tvFitScore} | ${c.tvFitReason}`);
		}
	};

	print("baseline");
	await applyRakutenRoomBoost(seeded);
	print("after L1");
	await applyRakutenLiveArchiveBoost(seeded);
	print("after L2");
	await applyCreatorContentBoost(seeded);
	print("after L3");
	await applyHashtagMentionBoost(seeded);
	print("after L4");
}

testClamp();
testClampEdgeCase();
void testBoostSmoke().then(() => console.log("\nall passed"));
