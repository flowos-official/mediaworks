/**
 * Safety net for video-archive slots orphaned in `video_status='downloading'`.
 *
 * `archiveOne` claims a slot by flipping queued→downloading before streaming it
 * to S3. If the worker dies mid-flight (Vercel function timeout, deploy, crash,
 * killed local drain), the row is left stuck in 'downloading' forever — the
 * archive queue only ever re-selects 'queued', so the slot never retries.
 *
 * This helper requeues any 'downloading' row whose claim is older than
 * `staleMinutes` (default 30). The broadcasts table has a BEFORE-UPDATE trigger
 * that advances `updated_at` on every write, so a row's `updated_at` reflects
 * when it was claimed — a fresh claim from a concurrent worker is never touched.
 *
 * Each recovery counts as a consumed attempt (video_download_attempts += 1) so a
 * slot that repeatedly hangs past the function timeout is bounded: once attempts
 * reach MAX_ATTEMPTS it is moved to 'abandoned' instead of looping forever.
 *
 * Mirrors `recoverQvcPending` — called at the start of the archive-videos cron
 * and the local drain so orphans self-heal on the next run.
 */
import { getServiceClient } from "@/lib/supabase";

/** Must match MAX_ATTEMPTS in video-archival.ts. */
const MAX_ATTEMPTS = 5;
const DEFAULT_STALE_MINUTES = 30;
const PAGE = 500;

export interface StaleRecoveryResult {
	scanned: number;
	requeued: number;
	abandoned: number;
}

/** Pure decision: where a stale-downloading slot goes next. Exported for tests. */
export function decideStaleRecovery(
	currentAttempts: number,
	maxAttempts = MAX_ATTEMPTS,
): { nextStatus: "queued" | "abandoned"; nextAttempts: number } {
	const nextAttempts = (currentAttempts ?? 0) + 1;
	return {
		nextStatus: nextAttempts >= maxAttempts ? "abandoned" : "queued",
		nextAttempts,
	};
}

export async function recoverStaleDownloading(
	staleMinutes = DEFAULT_STALE_MINUTES,
	signal?: AbortSignal,
): Promise<StaleRecoveryResult> {
	const sb = getServiceClient();
	const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();

	let scanned = 0;
	let requeued = 0;
	let abandoned = 0;

	// Page through stale rows. Recovered rows leave 'downloading', so each pass
	// shrinks the set; re-query from offset 0 every loop to avoid skipping.
	for (;;) {
		signal?.throwIfAborted();
		let fetchQuery = sb
			.from("broadcasts")
			.select("id, video_download_attempts")
			.eq("video_status", "downloading")
			.lt("updated_at", cutoff)
			.limit(PAGE);
		if (signal) fetchQuery = fetchQuery.abortSignal(signal);
		const { data, error } = await fetchQuery;

		if (error) {
			throw new Error(`recoverStaleDownloading fetch failed: ${error.message}`);
		}
		const rows = (data ?? []) as Array<{
			id: string;
			video_download_attempts: number | null;
		}>;
		if (rows.length === 0) break;

		scanned += rows.length;

		for (const r of rows) {
			signal?.throwIfAborted();
			const { nextStatus, nextAttempts } = decideStaleRecovery(
				r.video_download_attempts ?? 0,
			);
			// CAS: only act if the row is still the same stale claim. Guards against
			// a concurrent worker that re-claimed (updated_at moves forward) or
			// finished (status changes) between the SELECT and this UPDATE.
			let updateQuery = sb
				.from("broadcasts")
				.update({
					video_status: nextStatus,
					video_download_attempts: nextAttempts,
					video_error: "recovered from stale downloading",
				})
				.eq("id", r.id)
				.eq("video_status", "downloading")
				.lt("updated_at", cutoff)
				.select("id");
			if (signal) updateQuery = updateQuery.abortSignal(signal);
			const { data: upd, error: updErr } = await updateQuery;
			if (updErr) {
				console.warn(
					`[stale-recover] update ${r.id} failed:`,
					updErr.message,
				);
				continue;
			}
			if (!upd || upd.length === 0) continue; // lost the CAS race — fine
			if (nextStatus === "abandoned") abandoned += 1;
			else requeued += 1;
		}

		if (rows.length < PAGE) break;
	}

	return { scanned, requeued, abandoned };
}
