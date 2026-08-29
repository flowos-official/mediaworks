import { type NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { recoverStaleAnalysis, seedAnalysisQueue } from "@/lib/broadcast-intel/queue";
import {
  analyzeOne,
  MAX_ATTEMPTS,
  type AnalyzeResult,
  type QueuedAnalysisSlot,
} from "@/lib/broadcast-intel/analyze-one";
import { createPipelineRunRepository } from "@/lib/intelligence/pipeline-run";
import { audioPipelineOutcome } from "@/lib/intelligence/pipeline-run-mapping";
import { returnAfterPipelineFailure, settlePipelineRunBestEffort, startPipelineRunBestEffort, type PipelineRunRouteReporter } from "@/lib/intelligence/pipeline-run-route";
import type { PipelineRunHandle } from "@/lib/intelligence/pipeline-run";

export const maxDuration = 300;

// This cron keeps up with newly archived slots. It is NOT the backfill path —
// at 100-200s per slot it clears 2-4 per run. Backfill runs through
// scripts/drain-broadcast-analysis.ts.
const BUDGET_MS = 240_000;
const SLOT_BUDGET_MS = 200_000;
const CONCURRENCY = Number(process.env.BROADCAST_INTEL_BATCH_CONCURRENCY) || 2;
const SEED_LIMIT = 10;
const SLICE_CATEGORY = process.env.BROADCAST_INTEL_CATEGORY || "家電";

export function broadcastAudioPipelineOutcome(
	summary: Parameters<typeof audioPipelineOutcome>[0],
	preflightFailures: number,
) {
	return audioPipelineOutcome(summary, preflightFailures);
}

export function broadcastAudioQueryFailure<T>(run: PipelineRunHandle | null, summary: string, response: T, report: PipelineRunRouteReporter) {
	return returnAfterPipelineFailure(run, "queue_query_failed", summary, response, report);
}

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
	const reportPipelineRunError = (phase: "start" | "settle", error: unknown) => {
		console.warn(`[analyze-broadcast-audio] pipeline run ${phase} failed:`, error instanceof Error ? error.message : String(error));
	};
	const pipelineRun = await startPipelineRunBestEffort(
    createPipelineRunRepository(sb),
    {
      sourceType: "broadcast_archive",
      jobType: "audio_analysis",
      externalRunId: `analyze-broadcast-audio:${crypto.randomUUID()}`,
      targetScope: { category: SLICE_CATEGORY },
    },
		reportPipelineRunError,
	);
  const summary = { recovered: 0, seeded: 0, processed: 0, done: 0, queued: 0, failed: 0, skipped: 0, batches: 0 };
  let preflightFailures = 0;

  try {
  try {
    summary.recovered = await recoverStaleAnalysis();
  } catch (err) {
    preflightFailures++;
    console.warn("[analyze-broadcast-audio] stale recovery failed:", err);
  }
  try {
    summary.seeded = await seedAnalysisQueue({ limit: SEED_LIMIT, category: SLICE_CATEGORY });
  } catch (err) {
    preflightFailures++;
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

		if (error) {
			return broadcastAudioQueryFailure(
				pipelineRun,
				error.message,
				NextResponse.json({ error: error.message, ...summary }, { status: 500 }),
				reportPipelineRunError,
			);
    }

    const queued = (slots ?? []) as QueuedAnalysisSlot[];
    if (queued.length === 0) break;

    const results: AnalyzeResult[] = await Promise.all(queued.map(analyzeOne));
    summary.batches++;
    for (const r of results) {
      summary.processed++;
      summary[r.status] += 1;
    }
  }

	const pipelineOutcome = broadcastAudioPipelineOutcome(summary, preflightFailures);
	await settlePipelineRunBestEffort(
		pipelineRun,
		async (run) => {
		if (pipelineOutcome.status === "partial") {
			await run.partial(
        pipelineOutcome.counts,
        "audio_analysis_partial",
        `${pipelineOutcome.counts.failed} failed and ${summary.queued} requeued audio analysis result(s)`,
				);
			} else {
			await run.succeed(pipelineOutcome.counts);
		}
		},
		reportPipelineRunError,
	);

  return NextResponse.json({ ok: true, ...summary, duration_ms: Date.now() - startedAt });
  } catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	await settlePipelineRunBestEffort(pipelineRun, (run) => run.fail("audio_analysis_failed", message), reportPipelineRunError);
    throw err;
  }
}
