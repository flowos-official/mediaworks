/**
 * Self-heal for ShopCh slots stranded in video_status='deferred'.
 *
 * ShopCh's per-program recording (`pgmMovie`) only becomes available AFTER the
 * program airs. A slot enriched while it was still a future slot (manual
 * backfill, or any enrich pass before the VOD was published) gets marked
 * 'deferred'. The daily enrich's CAS guard then only promotes 'pending'/'deferred'
 * → 'queued', but a date is scraped exactly once (the day after it airs), so a
 * slot deferred on an earlier pass would otherwise never be revisited — leaving a
 * downloadable video permanently stranded (the archive cron only picks 'queued').
 *
 * This sweep re-fetches the slot JSON for recent 'deferred' ShopCh slots and
 * flips any whose `pgmMovie` is now present back to 'queued' (CAS-guarded), so
 * the archive cron picks them up. Mirrors `recoverQvcPending` /
 * `recoverStaleDownloading`. Safe to run on every daily cron tick: once the
 * backlog drains, scanned→~0.
 */
import { getServiceClient } from "@/lib/supabase";
import {
	buildProgramId,
	fetchShopChSlotMetadataBatch,
	type ShopChSlotMetadata,
} from "./shopch-json";

export interface ShopChDeferredRecoveryResult {
	/** deferred shopch slots inside the lookback window */
	scanned: number;
	/** flipped deferred → queued (video now available) */
	requeued: number;
	/** still genuinely without a video (pgmMovie null) — left deferred */
	stillDeferred: number;
	/** slot JSON fetch failed / busy-page — left deferred, retried next run */
	fetchFailed: number;
}

const DEFAULT_LOOKBACK_DAYS = 7;
/** Cap slots probed per run so a large initial backlog can't blow the cron's
 *  maxDuration; the remainder drains on the next tick (CAS makes it idempotent). */
const DEFAULT_LIMIT = 80;

type FetchMetaFn = (
	programIds: string[],
) => Promise<Map<string, ShopChSlotMetadata>>;

export async function recoverShopChDeferred(opts?: {
	lookbackDays?: number;
	limit?: number;
	/** Injectable for tests; defaults to the live ShopCh JSON batch fetch. */
	fetchMeta?: FetchMetaFn;
}): Promise<ShopChDeferredRecoveryResult> {
	const lookbackDays =
		opts?.lookbackDays ??
		(Number(process.env.SHOPCH_DEFERRED_LOOKBACK_DAYS) || DEFAULT_LOOKBACK_DAYS);
	const limit = opts?.limit ?? DEFAULT_LIMIT;
	const fetchMeta = opts?.fetchMeta ?? fetchShopChSlotMetadataBatch;

	const sb = getServiceClient();
	const result: ShopChDeferredRecoveryResult = {
		scanned: 0,
		requeued: 0,
		stillDeferred: 0,
		fetchFailed: 0,
	};

	// Window: [today - lookbackDays, today) in JST. The UPPER bound (strictly
	// before today) is critical — ShopCh's per-program m3u8 publishes only AFTER
	// the program airs, but the JSON `pgmMovie` path is pre-populated for future
	// slots. Queueing a not-yet-aired slot makes the archiver hit a 403 on the
	// missing m3u8 object and burn its retry budget. Restricting to strictly-past
	// air_dates guarantees every swept slot has already aired (its video exists),
	// mirroring the once-per-day enrich which only ever runs on fully-aired
	// "yesterday" slots.
	const jstDate = (offsetDays: number) =>
		new Date(Date.now() + 9 * 3_600_000 + offsetDays * 86_400_000)
			.toISOString()
			.slice(0, 10);
	const cutoff = jstDate(-lookbackDays);
	const today = jstDate(0);

	const { data, error } = await sb
		.from("broadcasts")
		.select("id, air_date, start_time")
		.eq("channel", "shopch")
		.eq("video_status", "deferred")
		.gte("air_date", cutoff)
		.lt("air_date", today)
		.order("air_date", { ascending: true })
		.limit(limit);

	if (error) {
		throw new Error(`[shopch-deferred-recover] select failed: ${error.message}`);
	}

	const slots = (data ?? []) as Array<{
		id: string;
		air_date: string;
		start_time: string;
	}>;
	result.scanned = slots.length;
	if (slots.length === 0) return result;

	// Map programId → slot id. start_time may carry sub-minute precision; the
	// JSON key is YYYYMMDDHHMMSS so buildProgramId handles the normalization.
	const idByProgramId = new Map<string, string>();
	const programIds: string[] = [];
	for (const s of slots) {
		const pid = buildProgramId(s.air_date, s.start_time);
		idByProgramId.set(pid, s.id);
		programIds.push(pid);
	}

	const meta = await fetchMeta(programIds);

	for (const pid of programIds) {
		const slotId = idByProgramId.get(pid);
		if (!slotId) continue;
		const m = meta.get(pid);
		if (!m) {
			// Fetch failed or busy-page — leave deferred, retry next run.
			result.fetchFailed++;
			continue;
		}
		if (!m.videoPath) {
			// Genuinely no recording yet (or non-video program) — stays deferred.
			result.stillDeferred++;
			continue;
		}

		// Video is available now → promote. CAS-guarded so a concurrent claim
		// (archive cron / re-scrape) is never clobbered.
		const { error: upErr, count } = await sb
			.from("broadcasts")
			.update({ video_status: "queued" }, { count: "exact" })
			.eq("id", slotId)
			.eq("video_status", "deferred");

		if (upErr) {
			console.warn(
				`[shopch-deferred-recover] requeue failed for ${slotId}:`,
				upErr.message,
			);
			result.stillDeferred++;
			continue;
		}
		if (count && count > 0) result.requeued++;
		else result.stillDeferred++; // status changed under us — leave it
	}

	return result;
}
