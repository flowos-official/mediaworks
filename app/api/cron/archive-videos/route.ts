import { type NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { archiveOne, type QueuedSlot, type ArchiveResult } from "@/lib/broadcasts/video-archival";
import { recoverStaleDownloading } from "@/lib/broadcasts/stale-downloading-recovery";

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

  console.log("[archive-videos]", JSON.stringify(summary));

  return NextResponse.json(summary);
}
