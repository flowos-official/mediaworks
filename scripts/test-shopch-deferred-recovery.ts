/**
 * Live-DB test for recoverShopChDeferred (self-cleaning, no network).
 *
 *   npx tsx --env-file=.env.local scripts/test-shopch-deferred-recovery.ts
 *
 * Uses sentinel air_dates that never collide with real slots, and a stubbed
 * fetchMeta so the assertion is deterministic (no shopch.jp dependency).
 * Verifies:
 *   1. PAST deferred slot whose video is now available → flipped to 'queued'
 *   2. PAST deferred slot still without a video          → left 'deferred'
 *   3. an 'archived' slot is never touched (CAS guard)
 *   4. a FUTURE-dated deferred slot is NOT swept (air-time gate) — even with a
 *      video, it stays 'deferred' because its m3u8 won't exist until it airs.
 */
import { getServiceClient } from "../lib/supabase";
import { buildProgramId, type ShopChSlotMetadata } from "../lib/broadcasts/shopch-json";
import { recoverShopChDeferred } from "../lib/broadcasts/shopch-deferred-recovery";

const PAST_DATE = "2020-01-01"; // strictly before today → eligible for recovery
const FUTURE_DATE = "2099-01-01"; // not yet aired → excluded by the air-time gate
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

async function cleanup(sb: ReturnType<typeof getServiceClient>) {
	await sb.from("broadcasts").delete().eq("channel", CHANNEL).in("air_date", [PAST_DATE, FUTURE_DATE]);
}

async function main() {
	const sb = getServiceClient();

	// --- setup: delete-then-insert sentinel slots ---
	const rows = [
		{ air_date: PAST_DATE, start_time: "00:00:00", program_title: "TEST-past-has-video", video_status: "deferred" },
		{ air_date: PAST_DATE, start_time: "01:00:00", program_title: "TEST-past-no-video", video_status: "deferred" },
		{ air_date: PAST_DATE, start_time: "02:00:00", program_title: "TEST-past-archived", video_status: "archived" },
		{ air_date: FUTURE_DATE, start_time: "00:00:00", program_title: "TEST-future-has-video", video_status: "deferred" },
	];

	await cleanup(sb);
	const { error: insErr } = await sb.from("broadcasts").insert(
		rows.map((r) => ({
			channel: CHANNEL,
			air_date: r.air_date,
			start_time: r.start_time,
			program_title: r.program_title,
			source_url: `https://test.invalid/shopch-deferred-recovery/${r.air_date}/${r.start_time}`,
			video_status: r.video_status,
		})),
	);
	if (insErr) {
		console.error("setup insert failed:", insErr.message);
		process.exit(1);
	}

	const pidPastHasVideo = buildProgramId(PAST_DATE, "00:00:00");
	const pidPastNoVideo = buildProgramId(PAST_DATE, "01:00:00");
	const pidPastArchived = buildProgramId(PAST_DATE, "02:00:00");
	const pidFuture = buildProgramId(FUTURE_DATE, "00:00:00");

	// stub fetchMeta: resolve ONLY our sentinel programIds. Real deferred slots
	// in the lookback window are deliberately absent → counted as fetchFailed and
	// left untouched, so the test never mutates production data. The future slot
	// gets a videoPath too, to prove it stays deferred via the air-time GATE
	// (not merely because it lacks a video).
	const sentinelPids = new Set([pidPastHasVideo, pidPastNoVideo, pidPastArchived, pidFuture]);
	const stub = async (programIds: string[]) => {
		const m = new Map<string, ShopChSlotMetadata>();
		for (const pid of programIds) {
			if (!sentinelPids.has(pid)) continue;
			if (pid === pidPastNoVideo) m.set(pid, metaWith(null));
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
		.select("air_date, start_time, video_status")
		.eq("channel", CHANNEL)
		.in("air_date", [PAST_DATE, FUTURE_DATE]);
	const statusOf = (air: string, t: string) =>
		(after ?? []).find((r) => r.air_date === air && r.start_time === t)?.video_status;

	assert(statusOf(PAST_DATE, "00:00:00") === "queued", "past deferred slot WITH video → queued");
	assert(statusOf(PAST_DATE, "01:00:00") === "deferred", "past deferred slot WITHOUT video → stays deferred");
	assert(statusOf(PAST_DATE, "02:00:00") === "archived", "archived slot is never touched (CAS guard)");
	assert(statusOf(FUTURE_DATE, "00:00:00") === "deferred", "FUTURE deferred slot (has video) is NOT swept → stays deferred (air-time gate)");
	assert(result.requeued >= 1, "result.requeued counts the promoted past slot");
	assert(result.stillDeferred >= 1, "result.stillDeferred counts the no-video past slot");
	// scanned includes the 2 PAST sentinel deferred slots (the future one is
	// excluded by the air-time gate, the archived one by the status filter);
	// real deferred slots may also be scanned but are left untouched.
	assert(result.scanned >= 2, `scanned includes the 2 past sentinel deferred slots (got ${result.scanned})`);

	// --- cleanup ---
	await cleanup(sb);
	console.log("cleaned up sentinel rows.");

	if (failures > 0) {
		console.error(`\n${failures} assertion(s) failed.`);
		process.exit(1);
	}
	console.log("\nall assertions passed.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
