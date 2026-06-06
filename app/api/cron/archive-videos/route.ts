import { type NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { archiveOne, type QueuedSlot, type ArchiveResult } from "@/lib/broadcasts/video-archival";
import { recoverStaleDownloading } from "@/lib/broadcasts/stale-downloading-recovery";
import { recoverQvcPending } from "@/lib/broadcasts/qvc-pending-recovery";
import { recoverShopChPending } from "@/lib/broadcasts/shopch-pending-recovery";
import { reconcileArchiveCoverage } from "@/lib/broadcasts/archive-reconciliation";

export const maxDuration = 300;

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

  const sb = getServiceClient();

  // Primary healer (consolidation Phase 1): outcome-driven reconciliation in heal
  // mode requeues any stuck whitelist slot whose video exists — superset of the
  // qvc/shopch pending/deferred sweeps below, which now run as fallback (their
  // counts should drop to ~0). Heal mode skips coverage/record/alert (the daily
  // archive-reconciliation cron owns those). The probe overlap with the fallback
  // sweeps below is temporary by design (Phase 1) — Phase 2 removes the sweeps. Non-fatal.
  let reconcileHeal:
    | Awaited<ReturnType<typeof reconcileArchiveCoverage>>
    | { error: string } = {
    window_from: "", window_to: "", expected_total: 0, archived_total: 0,
    coverage_pct: 0, healed: 0, unhealable: 0, no_source: 0, probed: 0,
    coverage_by_day: [], gaps: [], alerted: false, alert_error: null, duration_ms: 0,
  };
  try {
    reconcileHeal = await reconcileArchiveCoverage({
      mode: "heal",
      lookbackDays: Number(process.env.RECONCILE_HEAL_LOOKBACK_DAYS) || 7,
    });
  } catch (err) {
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
    staleRecovery = await recoverStaleDownloading();
  } catch (err) {
    console.warn(
      "[archive-videos] stale-downloading recovery failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Close the residual archive lag: a QVC whitelist slot only becomes 'queued'
  // once recoverQvcPending sees its category, but the category is attached
  // progressively by product enrichment. The daily recover passes (16:00 +
  // 17:00 UTC) miss slots categorised in between, so they waited up to ~24h for
  // the next pass. Running it here (every 2h) flips them within the same tick so
  // the drain loop below archives them immediately. CAS-guarded + idempotent.
  let qvcRecovery: Awaited<ReturnType<typeof recoverQvcPending>> | { error: string } = {
    scanned: 0,
    queued: 0,
    deferred: 0,
    skippedOutOfWhitelist: 0,
    skippedNoProduct: 0,
  };
  try {
    qvcRecovery = await recoverQvcPending();
  } catch (err) {
    qvcRecovery = { error: err instanceof Error ? err.message : String(err) };
    console.warn("[archive-videos] recoverQvcPending failed:", qvcRecovery);
  }

  // Symmetric ShopCh path: flip whitelist-matching, already-aired slots stranded
  // in 'pending' (category classified after enrichment ran) → 'queued', so the
  // drain below archives their video the same tick. Without this, ~1 ShopCh slot
  // per day was lost permanently (no pending→queued sweep existed for ShopCh).
  let shopchPendingRecovery:
    | Awaited<ReturnType<typeof recoverShopChPending>>
    | { error: string } = {
    scanned: 0,
    requeued: 0,
    stillPending: 0,
    fetchFailed: 0,
    skippedNonWhitelist: 0,
  };
  try {
    shopchPendingRecovery = await recoverShopChPending();
  } catch (err) {
    shopchPendingRecovery = { error: err instanceof Error ? err.message : String(err) };
    console.warn("[archive-videos] recoverShopChPending failed:", shopchPendingRecovery);
  }

  // Drain the queue until it is empty or we approach the function timeout.
  // A fixed per-run cap (previously 8) could not keep up with daily influx and,
  // because slots are processed newest-first, permanently starved older
  // air_dates. Looping within a time budget adapts to load and clears backlog.
  // maxDuration=300s → a 240s budget leaves margin for the last in-flight batch
  // plus the response.
  const BUDGET_MS = 240_000;
  const BATCH_SIZE = 8;
  const MAX_BATCHES = 100; // safety backstop against a pathological loop
  const startedAt = Date.now();
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
    if (Date.now() - startedAt >= BUDGET_MS) break;

    const { data: slots, error } = await sb
      .from("broadcasts")
      .select("id, channel, air_date, start_time, product_ids, video_download_attempts")
      .eq("video_status", "queued")
      .lt("video_download_attempts", 5)
      .lte("air_date", todayJst)
      .order("air_date", { ascending: false })
      .limit(BATCH_SIZE);

    if (error) {
      return NextResponse.json({ error: error.message, ...summary }, { status: 500 });
    }

    const queued = (slots ?? []) as QueuedSlot[];
    if (queued.length === 0) break;

    const results: ArchiveResult[] = await pBoundedAll(queued, 4, (slot) =>
      archiveOne(slot),
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

  const result = { ...summary, reconcileHeal, qvcRecovery, shopchPendingRecovery };
  console.log("[archive-videos]", JSON.stringify(result));

  return NextResponse.json(result);
}
