/**
 * Self-heal for ShopCh slots stranded in video_status='pending'.
 *
 * Why they strand: a ShopCh slot is only promoted 'pending' → 'queued'/'deferred'
 * by the broadcast-products enrichment, which runs ONLY on whitelist-matching
 * slots. But ShopCh categories are attached asynchronously by a Gemini batch
 * classifier — a slot whose category was still null when enrichment ran is
 * skipped, and once the classifier later tags it into the whitelist there is no
 * path back: the daily enrich only revisits "yesterday", QVC's recoverQvcPending
 * is QVC-only, and shopch-deferred-recovery only touches 'deferred'. The slot
 * sits in 'pending' forever and the archive cron (which selects only 'queued')
 * never sees its — perfectly downloadable — video.
 *
 * This sweep mirrors `recoverQvcPending` / `recoverShopChDeferred`: for recent
 * PAST (already-aired) 'pending' ShopCh slots whose category is now in the
 * whitelist, it re-fetches the slot JSON and flips any whose `pgmMovie` is
 * present to 'queued' (CAS-guarded). Non-whitelist / uncategorised slots are left
 * untouched. Video-only rescue: it does NOT create the broadcast_products
 * snapshot (the slot missed enrichment) — the goal is to stop losing the video.
 *
 * The PAST gate (air_date < today JST) is critical: ShopCh's per-program m3u8
 * publishes only AFTER airing, so queuing a future slot would 403 the archiver.
 *
 * Safe to run on every archive-videos cron tick: once the backlog drains,
 * scanned→~0. CAS-guarded so a concurrent claim is never clobbered.
 */
import { getServiceClient } from "@/lib/supabase";
import { loadWhitelist, isAllowed } from "./category-filter";
import {
	buildProgramId,
	fetchShopChSlotMetadataBatch,
	type ShopChSlotMetadata,
} from "./shopch-json";

export interface ShopChPendingRecoveryResult {
	/** pending shopch slots fetched inside the (past) lookback window */
	scanned: number;
	/** flipped pending → queued (whitelist + video now available) */
	requeued: number;
	/** whitelist slot still genuinely without a video (pgmMovie null) — left pending */
	stillPending: number;
	/** slot JSON fetch failed / busy-page — left pending, retried next run */
	fetchFailed: number;
	/** non-whitelist or uncategorised slot — intentionally left pending */
	skippedNonWhitelist: number;
}

const DEFAULT_LOOKBACK_DAYS = 7;
/** Cap slots probed per run so a large initial backlog can't blow the cron's
 *  maxDuration; the remainder drains on the next tick (CAS makes it idempotent). */
const DEFAULT_LIMIT = 80;

type FetchMetaFn = (
	programIds: string[],
) => Promise<Map<string, ShopChSlotMetadata>>;

export async function recoverShopChPending(opts?: {
	lookbackDays?: number;
	limit?: number;
	/** Injectable for tests; defaults to the live ShopCh JSON batch fetch. */
	fetchMeta?: FetchMetaFn;
	/** Injectable for tests; defaults to the live channel_categories whitelist. */
	whitelist?: Map<string, Set<string>>;
}): Promise<ShopChPendingRecoveryResult> {
	const lookbackDays =
		opts?.lookbackDays ??
		(Number(process.env.SHOPCH_PENDING_LOOKBACK_DAYS) || DEFAULT_LOOKBACK_DAYS);
	const limit = opts?.limit ?? DEFAULT_LIMIT;
	const fetchMeta = opts?.fetchMeta ?? fetchShopChSlotMetadataBatch;
	const whitelist = opts?.whitelist ?? (await loadWhitelist());

	const sb = getServiceClient();
	const result: ShopChPendingRecoveryResult = {
		scanned: 0,
		requeued: 0,
		stillPending: 0,
		fetchFailed: 0,
		skippedNonWhitelist: 0,
	};

	// Window: [today - lookbackDays, today) in JST. The upper bound (strictly
	// before today) guarantees every swept slot has already aired — see header.
	const jstDate = (offsetDays: number) =>
		new Date(Date.now() + 9 * 3_600_000 + offsetDays * 86_400_000)
			.toISOString()
			.slice(0, 10);
	const cutoff = jstDate(-lookbackDays);
	const today = jstDate(0);

	const { data, error } = await sb
		.from("broadcasts")
		.select("id, air_date, start_time, category")
		.eq("channel", "shopch")
		.eq("video_status", "pending")
		.gte("air_date", cutoff)
		.lt("air_date", today)
		.order("air_date", { ascending: true })
		.limit(limit);

	if (error) {
		throw new Error(`[shopch-pending-recover] select failed: ${error.message}`);
	}

	const slots = (data ?? []) as Array<{
		id: string;
		air_date: string;
		start_time: string;
		category: string | null;
	}>;
	result.scanned = slots.length;
	if (slots.length === 0) return result;

	// Whitelist gate: pending slots may be non-whitelist (or still uncategorised);
	// only those tagged into the whitelist should ever be archived.
	const eligible = slots.filter((s) => isAllowed(whitelist, "shopch", s.category));
	result.skippedNonWhitelist = slots.length - eligible.length;
	if (eligible.length === 0) return result;

	// Map programId → slot id. start_time may carry sub-minute precision; the
	// JSON key is YYYYMMDDHHMMSS so buildProgramId handles the normalization.
	const idByProgramId = new Map<string, string>();
	const programIds: string[] = [];
	for (const s of eligible) {
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
			// Fetch failed or busy-page — leave pending, retry next run.
			result.fetchFailed++;
			continue;
		}
		if (!m.videoPath) {
			// Genuinely no recording yet (or non-video program) — stays pending.
			result.stillPending++;
			continue;
		}

		// Video is available now → promote. CAS-guarded so a concurrent claim
		// (archive cron / re-scrape) is never clobbered.
		const { error: upErr, count } = await sb
			.from("broadcasts")
			.update({ video_status: "queued", video_error: null }, { count: "exact" })
			.eq("id", slotId)
			.eq("video_status", "pending");

		if (upErr) {
			console.warn(
				`[shopch-pending-recover] requeue failed for ${slotId}:`,
				upErr.message,
			);
			result.stillPending++;
			continue;
		}
		if (count && count > 0) result.requeued++;
		else result.stillPending++; // status changed under us — leave it
	}

	return result;
}
