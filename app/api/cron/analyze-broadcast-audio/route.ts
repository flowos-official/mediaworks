import { type NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { recoverStaleAnalysis, seedAnalysisQueue } from "@/lib/broadcast-intel/queue";
import {
  analyzeOne,
  MAX_ATTEMPTS,
  type AnalyzeResult,
  type QueuedAnalysisSlot,
} from "@/lib/broadcast-intel/analyze-one";

export const maxDuration = 300;

// This cron keeps up with newly archived slots. It is NOT the backfill path —
// at 100-200s per slot it clears 2-4 per run. Backfill runs through
// scripts/drain-broadcast-analysis.ts.
const BUDGET_MS = 240_000;
const SLOT_BUDGET_MS = 200_000;
const CONCURRENCY = Number(process.env.BROADCAST_INTEL_BATCH_CONCURRENCY) || 2;
const SEED_LIMIT = 10;
const SLICE_CATEGORY = process.env.BROADCAST_INTEL_CATEGORY || "家電";

function verifyCronAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev mode
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sb = getServiceClient();
  const startedAt = Date.now();
  const summary = { recovered: 0, seeded: 0, processed: 0, done: 0, queued: 0, failed: 0, skipped: 0, batches: 0 };

  try {
    summary.recovered = await recoverStaleAnalysis();
  } catch (err) {
    console.warn("[analyze-broadcast-audio] stale recovery failed:", err);
  }
  try {
    summary.seeded = await seedAnalysisQueue({ limit: SEED_LIMIT, category: SLICE_CATEGORY });
  } catch (err) {
    console.warn("[analyze-broadcast-audio] seed failed:", err);
  }

  // Start a batch only if a whole slot can still finish inside maxDuration.
  // Checking the budget only between batches let a batch start at 239s and get
  // killed mid-slot, stranding rows in 'running'.
  while (Date.now() - startedAt + SLOT_BUDGET_MS <= BUDGET_MS) {
    const { data: slots, error } = await sb
      .from("broadcasts")
      .select("id, channel, air_date, category, archived_video_s3, analysis_attempts")
      .eq("analysis_status", "queued")
      .lt("analysis_attempts", MAX_ATTEMPTS)
      .order("air_date", { ascending: false })
      .limit(CONCURRENCY);

    if (error) return NextResponse.json({ error: error.message, ...summary }, { status: 500 });

    const queued = (slots ?? []) as QueuedAnalysisSlot[];
    if (queued.length === 0) break;

    const results: AnalyzeResult[] = await Promise.all(queued.map(analyzeOne));
    summary.batches++;
    for (const r of results) {
      summary.processed++;
      summary[r.status] += 1;
    }
  }

  return NextResponse.json({ ok: true, ...summary, duration_ms: Date.now() - startedAt });
}
