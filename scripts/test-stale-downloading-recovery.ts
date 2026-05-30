/**
 * Tests for recoverStaleDownloading (video-archive orphan self-heal).
 *
 *  - Unit: decideStaleRecovery branch logic (pure, no DB).
 *  - Integration (live DB): synthetic 'downloading' rows are requeued when
 *    stale, abandoned at the attempt cap, and left alone when fresh (CAS guard).
 *
 * Run: npm run test:stale-downloading   (requires .env.local)
 *
 * Uses a far-future air_date (2099-…) so it never collides with real data;
 * every row it creates is deleted in a finally block.
 */
import { strict as assert } from "node:assert";
import {
	decideStaleRecovery,
	recoverStaleDownloading,
} from "../lib/broadcasts/stale-downloading-recovery";
import { getServiceClient } from "../lib/supabase";

const TEST_DATE = "2099-01-01";
const HOUR_AGO = new Date(Date.now() - 60 * 60_000).toISOString();
const MAX_ATTEMPTS = 5;

function unitTests() {
	console.log("=== unit: decideStaleRecovery ===");
	const fresh = decideStaleRecovery(0);
	assert.deepEqual(fresh, { nextStatus: "queued", nextAttempts: 1 }, "0 → queued/1");

	const mid = decideStaleRecovery(3);
	assert.deepEqual(mid, { nextStatus: "queued", nextAttempts: 4 }, "3 → queued/4");

	const atCap = decideStaleRecovery(MAX_ATTEMPTS - 1);
	assert.deepEqual(
		atCap,
		{ nextStatus: "abandoned", nextAttempts: MAX_ATTEMPTS },
		"4 → abandoned/5",
	);

	const overCap = decideStaleRecovery(MAX_ATTEMPTS);
	assert.equal(overCap.nextStatus, "abandoned", "5 → abandoned");

	const nullSafe = decideStaleRecovery(null as unknown as number);
	assert.deepEqual(nullSafe, { nextStatus: "queued", nextAttempts: 1 }, "null → queued/1");
	console.log("  ✓ all branch assertions passed");
}

interface SeedRow {
	start_time: string;
	updated_at: string;
	video_download_attempts: number;
	desc: string;
}

async function integrationTests() {
	const sb = getServiceClient();
	console.log("\n=== integration: recoverStaleDownloading (live DB) ===");

	const seeds: SeedRow[] = [
		{ start_time: "00:00:00", updated_at: HOUR_AGO, video_download_attempts: 0, desc: "stale, attempts 0 → requeue" },
		{ start_time: "01:00:00", updated_at: HOUR_AGO, video_download_attempts: MAX_ATTEMPTS - 1, desc: "stale, attempts 4 → abandon" },
		{ start_time: "02:00:00", updated_at: new Date().toISOString(), video_download_attempts: 0, desc: "fresh claim → untouched (CAS)" },
	];

	// IMPORTANT: set updated_at on INSERT, not UPDATE. The broadcasts table has a
	// BEFORE-UPDATE trigger (broadcasts_set_updated_at) that forces
	// updated_at=now() on every UPDATE — so a past updated_at can ONLY be
	// established at INSERT time, and we must delete-then-insert (an upsert that
	// hits the conflict path would UPDATE and let the trigger stomp updated_at).
	const rows = seeds.map((s) => ({
		channel: "qvc" as const,
		air_date: TEST_DATE,
		start_time: s.start_time,
		program_title: `__stale-recovery-test__ ${s.desc}`,
		source_url: "https://example.test/stale-recovery",
		video_status: "downloading",
		video_download_attempts: s.video_download_attempts,
		updated_at: s.updated_at,
	}));

	const ids: string[] = [];
	try {
		// Clear any leftovers from a previously-failed run, then INSERT fresh so
		// the explicit past updated_at survives (see note above).
		await sb.from("broadcasts").delete().eq("air_date", TEST_DATE);
		const { data: inserted, error: insErr } = await sb
			.from("broadcasts")
			.insert(rows)
			.select("id, start_time");
		assert.ok(!insErr, `seed insert failed: ${insErr?.message}`);
		assert.equal(inserted?.length, 3, "seeded 3 rows");
		for (const r of inserted as Array<{ id: string }>) ids.push(r.id);

		const result = await recoverStaleDownloading(30);
		console.log(`  recovery result: ${JSON.stringify(result)}`);
		assert.ok(result.requeued >= 1, "at least the attempts-0 row requeued");
		assert.ok(result.abandoned >= 1, "at least the attempts-4 row abandoned");

		// Verify each seeded row landed in its expected status.
		const { data: after } = await sb
			.from("broadcasts")
			.select("start_time, video_status, video_download_attempts")
			.eq("air_date", TEST_DATE)
			.in("start_time", ["00:00:00", "01:00:00", "02:00:00"]);
		const byTime = new Map(
			(after ?? []).map((r) => [
				(r as { start_time: string }).start_time,
				r as { video_status: string; video_download_attempts: number },
			]),
		);

		const requeued = byTime.get("00:00:00");
		assert.equal(requeued?.video_status, "queued", "stale/0 → queued");
		assert.equal(requeued?.video_download_attempts, 1, "stale/0 attempts incremented to 1");

		const abandoned = byTime.get("01:00:00");
		assert.equal(abandoned?.video_status, "abandoned", "stale/4 → abandoned");
		assert.equal(abandoned?.video_download_attempts, MAX_ATTEMPTS, "stale/4 attempts → 5");

		const fresh = byTime.get("02:00:00");
		assert.equal(fresh?.video_status, "downloading", "fresh claim left untouched");
		assert.equal(fresh?.video_download_attempts, 0, "fresh claim attempts unchanged");

		console.log("  ✓ requeue / abandon / CAS-guard all verified");
	} finally {
		if (ids.length > 0) {
			await sb.from("broadcasts").delete().in("id", ids);
			console.log(`  cleaned up ${ids.length} test rows`);
		} else {
			// belt-and-suspenders: clean by natural key if select failed
			await sb.from("broadcasts").delete().eq("air_date", TEST_DATE);
		}
	}
}

async function main() {
	unitTests();
	await integrationTests();
	console.log("\n✅ All stale-downloading-recovery tests passed");
}

main().then(
	() => process.exit(0),
	(e) => {
		console.error("\n❌ test failed:", e instanceof Error ? e.message : e);
		process.exit(1);
	},
);
