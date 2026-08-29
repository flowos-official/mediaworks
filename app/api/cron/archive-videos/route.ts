import { type NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { canStartArchiveBatch, createArchiveDeadline } from "@/lib/broadcasts/archive-deadline";
import { archiveOne, type QueuedSlot, type ArchiveResult } from "@/lib/broadcasts/video-archival";
import { recoverStaleDownloading } from "@/lib/broadcasts/stale-downloading-recovery";
import { reconcileArchiveCoverage } from "@/lib/broadcasts/archive-reconciliation";
import { createPipelineRunRepository } from "@/lib/intelligence/pipeline-run";
import { archivePipelineOutcome } from "@/lib/intelligence/pipeline-run-mapping";
import { returnAfterPipelineFailure, settlePipelineRunBestEffort, startPipelineRunBestEffort, throwAfterPipelineFailure, type PipelineRunRouteReporter } from "@/lib/intelligence/pipeline-run-route";
import type { PipelineRunHandle } from "@/lib/intelligence/pipeline-run";

export const maxDuration = 300;

const BUDGET_MS = 240_000;
const CLEANUP_BUDGET_MS = 285_000;
const SLOT_BUDGET_MS = 200_000;
const CONCURRENCY = 4;
const BATCH_SIZE = CONCURRENCY;

export function archiveVideosPipelineOutcome(
	summary: Parameters<typeof archivePipelineOutcome>[0],
	preflightFailures: number,
) {
	return archivePipelineOutcome(summary, preflightFailures);
}

export function archiveVideosQueryFailure<T>(run: PipelineRunHandle | null, summary: string, response: T, report: PipelineRunRouteReporter) {
	return returnAfterPipelineFailure(run, "queue_query_failed", summary, response, report);
}

export function archiveVideosThrownFailure(run: PipelineRunHandle | null, primaryError: unknown, report: PipelineRunRouteReporter) {
	const summary = primaryError instanceof Error ? primaryError.message : String(primaryError);
	return throwAfterPipelineFailure(run, "video_archive_failed", summary, primaryError, report);
}

function verifyCronAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev mode
  const header = req.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

/** Run up to `concurrency` workers over `items` and return results in order. */
async function pBoundedAll<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function runWorker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const pool = Array.from({ length: Math.min(concurrency, items.length) }, runWorker);
  await Promise.all(pool);
  return results;
}

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // The budget covers the whole route, including recovery/reconciliation.
  // Starting it after those steps let a slow preamble consume time outside the
  // 240s ceiling and could still push the function past Vercel's 300s limit.
  const startedAt = Date.now();
	const reportPipelineRunError = (phase: "start" | "settle", error: unknown) => {
		console.warn(`[archive-videos] pipeline run ${phase} failed:`, error instanceof Error ? error.message : String(error));
	};
	const pipelineRun = await startPipelineRunBestEffort(
    createPipelineRunRepository(getServiceClient()),
    {
      sourceType: "qvc_shopch",
      jobType: "video_archive",
      externalRunId: `archive-videos:${crypto.randomUUID()}`,
      targetScope: { invokedAt: new Date(startedAt).toISOString() },
    },
		reportPipelineRunError,
	);
  const deadlineMs = startedAt + BUDGET_MS;
  const workDeadline = createArchiveDeadline(deadlineMs);
  const cleanupDeadline = createArchiveDeadline(
    startedAt + CLEANUP_BUDGET_MS,
    "archive cleanup deadline exceeded",
  );

  try {
    const sb = getServiceClient();

    // Primary healer: outcome-driven reconciliation in heal mode requeues any
    // stuck whitelist slot whose video exists. Heal mode skips coverage/record/alert
    // (the daily archive-reconciliation cron owns those). Non-fatal.
    let reconcileHeal:
      | Awaited<ReturnType<typeof reconcileArchiveCoverage>>
      | { error: string } = {
        window_from: "", window_to: "", expected_total: 0, archived_total: 0,
        coverage_pct: 0, healed: 0, unhealable: 0, no_source: 0, probed: 0,
        coverage_by_day: [], gaps: [], alerted: false, alert_error: null, duration_ms: 0,
      };
    let preflightFailures = 0;
    try {
      reconcileHeal = await reconcileArchiveCoverage({
        mode: "heal",
        lookbackDays: Number(process.env.RECONCILE_HEAL_LOOKBACK_DAYS) || 7,
        signal: workDeadline.signal,
      });
    } catch (err) {
      preflightFailures++;
      reconcileHeal = { error: err instanceof Error ? err.message : String(err) };
      console.warn("[archive-videos] reconcileArchiveCoverage(heal) failed:", reconcileHeal);
    }

    // Self-heal: requeue slots orphaned in 'downloading' by a prior run that died
    // mid-stream (function timeout / deploy / crash). Without this they never
    // retry, since the queue below only selects 'queued'. Non-fatal.
    let staleRecovery: Awaited<ReturnType<typeof recoverStaleDownloading>> = {
      scanned: 0,
      requeued: 0,
      abandoned: 0,
    };
    try {
      staleRecovery = await recoverStaleDownloading(undefined, workDeadline.signal);
    } catch (err) {
      preflightFailures++;
      console.warn(
        "[archive-videos] stale-downloading recovery failed:",
        err instanceof Error ? err.message : String(err),
      );
    }

    // Drain the queue until it is empty or we approach the function timeout.
    // A fixed per-run cap (previously 8) could not keep up with daily influx and,
    // because slots are processed newest-first, permanently starved older
    // air_dates. Looping within a time budget adapts to load and clears backlog.
    // maxDuration=300s → a 240s budget leaves margin for the last in-flight batch
    // plus the response.
    const MAX_BATCHES = 100; // safety backstop against a pathological loop
    const todayJst = new Date(Date.now() + 9 * 60 * 60_000)
      .toISOString()
      .slice(0, 10);

    const summary = {
      processed: 0,
      archived: 0,
      queued: 0,
      abandoned: 0,
      deferred: 0,
      failed_unsupported: 0,
      total_bytes: 0,
      batches: 0,
      stale_requeued: staleRecovery.requeued,
      stale_abandoned: staleRecovery.abandoned,
    };

    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      if (!canStartArchiveBatch({
        startedAtMs: startedAt,
        nowMs: Date.now(),
        budgetMs: BUDGET_MS,
        slotBudgetMs: SLOT_BUDGET_MS,
      })) break;

      const { data: slots, error } = await sb
        .from("broadcasts")
        .select("id, channel, air_date, start_time, product_ids, video_download_attempts")
        .eq("video_status", "queued")
        .lt("video_download_attempts", 5)
        .lte("air_date", todayJst)
        .order("air_date", { ascending: false })
        .limit(BATCH_SIZE)
        .abortSignal(workDeadline.signal);

		if (error) {
			return archiveVideosQueryFailure(
				pipelineRun,
				error.message,
				NextResponse.json({ error: error.message, ...summary }, { status: 500 }),
				reportPipelineRunError,
			);
      }

      const queued = (slots ?? []) as QueuedSlot[];
      if (queued.length === 0) break;

      const results: ArchiveResult[] = await pBoundedAll(queued, CONCURRENCY, (slot) =>
        archiveOne(slot, {
          deadlineMs,
          signal: workDeadline.signal,
          cleanupSignal: cleanupDeadline.signal,
        }),
      );
      summary.batches++;

      for (const r of results) {
        summary.processed++;
        if (r.status in summary) {
          summary[r.status as keyof typeof summary] =
            (summary[r.status as keyof typeof summary] as number) + 1;
        }
        if (r.bytes) summary.total_bytes += r.bytes;
      }
    }

    const result = { ...summary, reconcileHeal };
    console.log("[archive-videos]", JSON.stringify(result));

		const pipelineOutcome = archiveVideosPipelineOutcome(summary, preflightFailures);
		await settlePipelineRunBestEffort(
			pipelineRun,
			async (run) => {
			if (pipelineOutcome.status === "partial") {
				await run.partial(
          pipelineOutcome.counts,
          "archive_partial",
          `${pipelineOutcome.counts.failed} failed, ${summary.queued} requeued, and ${summary.deferred} deferred archive result(s)`,
					);
			} else {
				await run.succeed(pipelineOutcome.counts);
			}
			},
			reportPipelineRunError,
		);

    return NextResponse.json(result);
  } catch (err) {
		return await archiveVideosThrownFailure(pipelineRun, err, reportPipelineRunError);
  } finally {
    workDeadline.dispose();
    cleanupDeadline.dispose();
  }
}
