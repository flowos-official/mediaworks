/**
 * Live-DB test for recoverShopChDeferred (self-cleaning, no network).
 *
 *   npx tsx --env-file=.env.local scripts/test-shopch-deferred-recovery.ts
 *
 * Uses a sentinel air_date (2020-01-01) so it never touches real slots, and a
 * stubbed fetchMeta so the assertion is deterministic (no shopch.jp dependency).
 * Verifies:
 *   1. deferred slot whose video is now available  → flipped to 'queued'
 *   2. deferred slot still without a video          → left 'deferred'
 *   3. an 'archived' slot is never touched (CAS guard holds)
 */
import { getServiceClient } from "../lib/supabase";
import { buildProgramId, type ShopChSlotMetadata } from "../lib/broadcasts/shopch-json";
import { recoverShopChDeferred } from "../lib/broadcasts/shopch-deferred-recovery";

const SENTINEL_DATE = "2020-01-01";
const CHANNEL = "shopch";

function metaWith(videoPath: string | null): ShopChSlotMetadata {
	return {
		category: null,
		categoryCode: null,
		productIds: [],
		products: [],
		brandName: null,
		brandCode: null,
		videoPath,
		programTitle: "TEST",
		thumbnailUrl: null,
		presenter: null,
	};
}

let failures = 0;
function assert(cond: boolean, msg: string) {
	if (cond) {
		console.log(`  ok: ${msg}`);
	} else {
		console.error(`  FAIL: ${msg}`);
		failures++;
	}
}

async function main() {
	const sb = getServiceClient();

	// --- setup: delete-then-insert three sentinel slots ---
	const slots = [
		{ start_time: "00:00:00", program_title: "TEST-has-video", video_status: "deferred" },
		{ start_time: "01:00:00", program_title: "TEST-no-video", video_status: "deferred" },
		{ start_time: "02:00:00", program_title: "TEST-archived", video_status: "archived" },
	];

	await sb.from("broadcasts").delete().eq("channel", CHANNEL).eq("air_date", SENTINEL_DATE);

	const { error: insErr } = await sb.from("broadcasts").insert(
		slots.map((s) => ({
			channel: CHANNEL,
			air_date: SENTINEL_DATE,
			start_time: s.start_time,
			program_title: s.program_title,
			source_url: `https://test.invalid/shopch-deferred-recovery/${s.start_time}`,
			video_status: s.video_status,
		})),
	);
	if (insErr) {
		console.error("setup insert failed:", insErr.message);
		process.exit(1);
	}

	const pidHasVideo = buildProgramId(SENTINEL_DATE, "00:00:00");
	const pidNoVideo = buildProgramId(SENTINEL_DATE, "01:00:00");
	const pidArchived = buildProgramId(SENTINEL_DATE, "02:00:00");

	// stub fetchMeta: resolve ONLY our sentinel programIds. Real deferred slots
	// that fall in the lookback window are deliberately absent from the map →
	// the recovery counts them as fetchFailed and leaves them untouched, so the
	// test never mutates production data. has-video resolves with a videoPath,
	// no-video resolves with null.
	const sentinelPids = new Set([pidHasVideo, pidNoVideo, pidArchived]);
	const stub = async (programIds: string[]) => {
		const m = new Map<string, ShopChSlotMetadata>();
		for (const pid of programIds) {
			if (!sentinelPids.has(pid)) continue;
			if (pid === pidNoVideo) m.set(pid, metaWith(null));
			else m.set(pid, metaWith(`m3u8/prog/${pid}/${pid}`));
		}
		return m;
	};

	// --- run ---
	const result = await recoverShopChDeferred({ lookbackDays: 99999, limit: 500, fetchMeta: stub });
	console.log("result:", JSON.stringify(result));

	// --- assertions ---
	const { data: after } = await sb
		.from("broadcasts")
		.select("start_time, video_status")
		.eq("channel", CHANNEL)
		.eq("air_date", SENTINEL_DATE);
	const byTime = new Map((after ?? []).map((r) => [r.start_time as string, r.video_status as string]));

	assert(byTime.get("00:00:00") === "queued", "deferred slot WITH video → queued");
	assert(byTime.get("01:00:00") === "deferred", "deferred slot WITHOUT video → stays deferred");
	assert(byTime.get("02:00:00") === "archived", "archived slot is never touched (CAS guard)");
	assert(result.requeued >= 1, "result.requeued counts the promoted slot");
	assert(result.stillDeferred >= 1, "result.stillDeferred counts the no-video slot");
	// The archived slot is excluded by the video_status='deferred' SELECT filter.
	// scanned includes our 2 sentinels (and possibly real deferred slots, which
	// the stub omits → left untouched), so assert the lower bound.
	assert(result.scanned >= 2, `scanned includes the 2 sentinel deferred slots (got ${result.scanned})`);

	// --- cleanup ---
	await sb.from("broadcasts").delete().eq("channel", CHANNEL).eq("air_date", SENTINEL_DATE);
	console.log("cleaned up sentinel rows.");

	if (failures > 0) {
		console.error(`\n${failures} assertion(s) failed.`);
		process.exit(1);
	}
	console.log("\nall assertions passed.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
