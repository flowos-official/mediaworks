/**
 * Live-DB test for recoverShopChPending (self-cleaning, no network).
 *
 *   npx tsx --env-file=.env.local scripts/test-shopch-pending-recovery.ts
 *
 * Sentinel air_dates that never collide with real slots; injected whitelist +
 * stubbed fetchMeta make the assertions deterministic. Verifies:
 *   1. PAST pending + whitelist category + video now available → 'queued'
 *   2. PAST pending + whitelist category + no video           → stays 'pending'
 *   3. PAST pending + NON-whitelist category + video           → stays 'pending'  (whitelist gate)
 *   4. PAST pending + null category + video                    → stays 'pending'  (no-category gate)
 *   5. an 'archived' slot is never touched                     (status filter / CAS)
 *   6. a FUTURE-dated pending slot (has video) is NOT swept     (air-time gate)
 */
import { getServiceClient } from "../lib/supabase";
import { buildProgramId, type ShopChSlotMetadata } from "../lib/broadcasts/shopch-json";
import { recoverShopChPending } from "../lib/broadcasts/shopch-pending-recovery";

const PAST_DATE = "2020-01-01"; // strictly before today → eligible
const FUTURE_DATE = "2099-01-01"; // not yet aired → excluded by air-time gate
const CHANNEL = "shopch";
const WL = "TESTWL"; // injected-whitelist category
const NONWL = "TESTNONWL"; // deliberately absent from injected whitelist

const injectedWhitelist = new Map<string, Set<string>>([["shopch", new Set([WL])]]);

function metaWith(videoPath: string | null): ShopChSlotMetadata {
	return {
		category: null, categoryCode: null, productIds: [], products: [],
		brandName: null, brandCode: null, videoPath,
		programTitle: "TEST", thumbnailUrl: null, presenter: null,
	};
}

let failures = 0;
function assert(cond: boolean, msg: string) {
	if (cond) console.log(`  ok: ${msg}`);
	else { console.error(`  FAIL: ${msg}`); failures++; }
}

async function cleanup(sb: ReturnType<typeof getServiceClient>) {
	await sb.from("broadcasts").delete().eq("channel", CHANNEL).in("air_date", [PAST_DATE, FUTURE_DATE]);
}

async function main() {
	const sb = getServiceClient();

	const rows = [
		{ air_date: PAST_DATE, start_time: "00:00:00", category: WL, video_status: "pending", program_title: "TEST-past-wl-video" },
		{ air_date: PAST_DATE, start_time: "01:00:00", category: WL, video_status: "pending", program_title: "TEST-past-wl-novideo" },
		{ air_date: PAST_DATE, start_time: "02:00:00", category: NONWL, video_status: "pending", program_title: "TEST-past-nonwl-video" },
		{ air_date: PAST_DATE, start_time: "03:00:00", category: null, video_status: "pending", program_title: "TEST-past-nullcat-video" },
		{ air_date: PAST_DATE, start_time: "04:00:00", category: WL, video_status: "archived", program_title: "TEST-past-archived" },
		{ air_date: FUTURE_DATE, start_time: "00:00:00", category: WL, video_status: "pending", program_title: "TEST-future-wl-video" },
	];

	await cleanup(sb);
	const { error: insErr } = await sb.from("broadcasts").insert(
		rows.map((r) => ({
			channel: CHANNEL, air_date: r.air_date, start_time: r.start_time,
			category: r.category, program_title: r.program_title, video_status: r.video_status,
			source_url: `https://test.invalid/shopch-pending-recovery/${r.air_date}/${r.start_time}`,
		})),
	);
	if (insErr) { console.error("setup insert failed:", insErr.message); process.exit(1); }

	const pidWlVideo = buildProgramId(PAST_DATE, "00:00:00");
	const pidWlNoVideo = buildProgramId(PAST_DATE, "01:00:00");
	const pidNonWl = buildProgramId(PAST_DATE, "02:00:00");
	const pidNullCat = buildProgramId(PAST_DATE, "03:00:00");
	const pidFuture = buildProgramId(FUTURE_DATE, "00:00:00");

	// stub: resolve only sentinel pids. WL-no-video → null; everything else with video.
	const sentinel = new Set([pidWlVideo, pidWlNoVideo, pidNonWl, pidNullCat, pidFuture]);
	const stub = async (programIds: string[]) => {
		const m = new Map<string, ShopChSlotMetadata>();
		for (const pid of programIds) {
			if (!sentinel.has(pid)) continue;
			m.set(pid, metaWith(pid === pidWlNoVideo ? null : `m3u8/prog/${pid}/${pid}`));
		}
		return m;
	};

	const result = await recoverShopChPending({ lookbackDays: 99999, limit: 1000, fetchMeta: stub, whitelist: injectedWhitelist });
	console.log("result:", JSON.stringify(result));

	const { data: after } = await sb
		.from("broadcasts").select("air_date, start_time, video_status")
		.eq("channel", CHANNEL).in("air_date", [PAST_DATE, FUTURE_DATE]);
	const statusOf = (air: string, t: string) =>
		(after ?? []).find((r) => r.air_date === air && r.start_time === t)?.video_status;

	assert(statusOf(PAST_DATE, "00:00:00") === "queued", "past pending + whitelist + video → queued");
	assert(statusOf(PAST_DATE, "01:00:00") === "pending", "past pending + whitelist + no video → stays pending");
	assert(statusOf(PAST_DATE, "02:00:00") === "pending", "past pending + NON-whitelist + video → stays pending (whitelist gate)");
	assert(statusOf(PAST_DATE, "03:00:00") === "pending", "past pending + null category + video → stays pending (no-category gate)");
	assert(statusOf(PAST_DATE, "04:00:00") === "archived", "archived slot never touched (status filter)");
	assert(statusOf(FUTURE_DATE, "00:00:00") === "pending", "FUTURE pending (has video) NOT swept → stays pending (air-time gate)");
	assert(result.requeued >= 1, "result.requeued counts the promoted slot");
	assert(result.stillPending >= 1, "result.stillPending counts the no-video whitelist slot");
	assert(result.skippedNonWhitelist >= 2, `result.skippedNonWhitelist counts non-whitelist + null-cat (got ${result.skippedNonWhitelist})`);

	await cleanup(sb);
	console.log("cleaned up sentinel rows.");

	if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1); }
	console.log("\nall assertions passed.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
