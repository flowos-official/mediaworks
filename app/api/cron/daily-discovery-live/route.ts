import { NextRequest, NextResponse } from "next/server";
import { isDuplicateInvocation, invocationOrigin, isDuplicateRunError, waitForBlockingRun } from "@/lib/cron/duplicate-guard";
import { revalidateTag } from "next/cache";
import { applyRakutenRoomBoost } from "@/lib/discovery/rakuten-room-boost";
import { applyRakutenLiveArchiveBoost } from "@/lib/discovery/rakuten-live-archive-boost";
import { applyCreatorContentBoost } from "@/lib/discovery/creator-content-boost";
import { applyHashtagMentionBoost } from "@/lib/discovery/hashtag-mention-boost";
import { clampLiveBoosts } from "@/lib/discovery/live-boost-clamp";
import { runStage1 } from "@/lib/discovery/orchestrator";
import { OptionalStageTracker, runOptionalStage } from "@/lib/discovery/cron-budget";
import {
	attachPlanToSession,
	createSession,
	finalizeSession,
	reconcileStaleDiscoveryRuns,
	saveDiscoveredProducts,
} from "@/lib/discovery/save";
import { getServiceClient } from "@/lib/supabase";
import { DEFAULT_LEARNING_STATE, type LearningState } from "@/lib/discovery/types";



export const maxDuration = 300;

const TARGET_COUNT = Number(process.env.DISCOVERY_TARGET_COUNT ?? 30);
const CONTEXT = "live_commerce" as const;
const SAVE_FINALIZE_DEADLINE_MS = Number(
	process.env.DISCOVERY_SAVE_FINALIZE_DEADLINE_MS ?? 270_000,
);
const OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS = Number(
	process.env.DISCOVERY_OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS ?? 20_000,
);
const LIVE_BOOST_TOTAL_CAP = Number(process.env.LIVE_BOOST_TOTAL_CAP ?? 15);

async function loadLearningState(): Promise<LearningState> {
	try {
		const sb = getServiceClient();
		const { data, error } = await sb
			.from("learning_state")
			.select("*")
			.eq("context", "live_commerce")
			.single();
		if (error || !data) return DEFAULT_LEARNING_STATE;
		return {
			exploration_ratio: data.exploration_ratio,
			category_weights: data.category_weights ?? {},
			category_seasonal_weights: data.category_seasonal_weights ?? {},
			rejected_seeds: data.rejected_seeds ?? {
				urls: [],
				brands: [],
				terms: [],
			},
			recent_rejection_reasons: data.recent_rejection_reasons ?? [],
			feedback_sample_size: data.feedback_sample_size ?? 0,
			is_cold_start: data.is_cold_start ?? true,
		};
	} catch {
		return DEFAULT_LEARNING_STATE;
	}
}

function verifyCronAuth(req: NextRequest): boolean {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true;
	const header = req.headers.get("authorization");
	return header === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
	if (!verifyCronAuth(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	// This path is invoked twice per night, the second arriving 26-47s after the
	// first and sometimes on an older build. One trigger, one run.
	const readLatestRun = async () => {
		const { data } = await getServiceClient()
			.from("discovery_runs")
			.select("run_at, status")
			.eq("context", CONTEXT)
			.order("run_at", { ascending: false })
			.limit(1)
			.maybeSingle();
		return (data as { run_at: string; status: string } | null) ?? null;
	};
	const lastRun = await readLatestRun();
	// A failed run does not hold the slot. The stale build that wins this race
	// on some nights fails ~80s in, and treating first-one-wins as final handed
	// it the whole night's discovery.
	if (lastRun?.status !== "failed" && isDuplicateInvocation(lastRun?.run_at)) {
		console.warn(
			`[cron ${CONTEXT}] duplicate invocation from ${invocationOrigin()} — last run ${lastRun?.run_at}`,
		);
		return NextResponse.json({ ok: true, context: CONTEXT, skipped: "duplicate-invocation", lastRunAt: lastRun?.run_at });
	}

	const startedAt = Date.now();
	await reconcileStaleDiscoveryRuns({ context: CONTEXT })
		.then((res) => {
			if (res.reconciled > 0) {
				console.warn(`[cron ${CONTEXT}] reconciled stale sessions`, res);
			}
		})
		.catch((err) => {
			console.warn(
				`[cron ${CONTEXT}] stale-session reconciliation failed:`,
				err instanceof Error ? err.message : String(err),
			);
		});

	const learning = await loadLearningState();
	const openSession = () =>
		createSession({
			targetCount: TARGET_COUNT,
			explorationRatio: learning.exploration_ratio,
			context: CONTEXT,
		});

	// The trigger refuses a second cron-shaped run inside the window. If the run
	// holding the slot then fails, this one takes over rather than letting the
	// night go to a build that could not finish it.
	let sessionId: string;
	try {
		sessionId = await openSession();
	} catch (err) {
		if (!isDuplicateRunError(err)) throw err;
		console.warn(`[cron ${CONTEXT}] slot held by another run — waiting (${invocationOrigin()})`);
		const outcome = await waitForBlockingRun(readLatestRun);
		if (outcome !== "failed") {
			return NextResponse.json({
				ok: true,
				context: CONTEXT,
				skipped: "duplicate-invocation",
				blockingRun: outcome,
			});
		}
		console.warn(`[cron ${CONTEXT}] blocking run failed — taking over`);
		sessionId = await openSession();
	}

	const stages = new OptionalStageTracker();

	try {
		const orchestrated = await runStage1(learning, TARGET_COUNT, CONTEXT);
		await attachPlanToSession(sessionId, orchestrated.plan);

		// Snapshot the post-curate score for every candidate. The four boost
		// layers each add up to +5; clampLiveBoosts enforces that the total
		// delta from this baseline stays <= LIVE_BOOST_TOTAL_CAP.
		const baselineByUrl = new Map<string, number>(
			orchestrated.candidates.map((c) => [c.productUrl, c.tvFitScore]),
		);

		// L1-L4 are independent (each only adds to tvFitScore on a single
		// candidate at a time, no cross-candidate state). Running them in
		// parallel is safe under JS single-threaded execution + the final
		// clamp.
		await Promise.all([
			runOptionalStage({
				label: `${CONTEXT}:L1-room-mention`,
				startedAtMs: startedAt,
				deadlineMs: SAVE_FINALIZE_DEADLINE_MS,
				minSaveBudgetMs: OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS,
				fallback: null,
				task: async () => {
					await applyRakutenRoomBoost(orchestrated.candidates);
					return null;
				},
				onOutcome: stages.record,
			}),
			runOptionalStage({
				label: `${CONTEXT}:L2-rakuten-live-archive`,
				startedAtMs: startedAt,
				deadlineMs: SAVE_FINALIZE_DEADLINE_MS,
				minSaveBudgetMs: OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS,
				fallback: null,
				task: async () => {
					await applyRakutenLiveArchiveBoost(orchestrated.candidates);
					return null;
				},
				onOutcome: stages.record,
			}),
			runOptionalStage({
				label: `${CONTEXT}:L3-creator-content`,
				startedAtMs: startedAt,
				deadlineMs: SAVE_FINALIZE_DEADLINE_MS,
				minSaveBudgetMs: OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS,
				fallback: null,
				task: async () => {
					await applyCreatorContentBoost(orchestrated.candidates);
					return null;
				},
				onOutcome: stages.record,
			}),
			runOptionalStage({
				label: `${CONTEXT}:L4-hashtag-mention`,
				startedAtMs: startedAt,
				deadlineMs: SAVE_FINALIZE_DEADLINE_MS,
				minSaveBudgetMs: OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS,
				fallback: null,
				task: async () => {
					await applyHashtagMentionBoost(orchestrated.candidates);
					return null;
				},
				onOutcome: stages.record,
			}),
		]);

		clampLiveBoosts(orchestrated.candidates, baselineByUrl, LIVE_BOOST_TOTAL_CAP);
		orchestrated.candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);

		const batch = orchestrated.candidates.map((c) => ({
			candidate: c,
			broadcastTag: "unknown" as const,
			broadcastSources: [],
			tvEvidence: null,
		}));
		const savedCount = await saveDiscoveredProducts(sessionId, batch, {
			categoryEnrichmentDeadlineMs: startedAt + SAVE_FINALIZE_DEADLINE_MS,
		});

		const partial = savedCount < TARGET_COUNT;
		await finalizeSession({
			sessionId,
			status: partial ? "partial" : "completed",
			producedCount: savedCount,
			iterations: orchestrated.iterations,
		});

		try {
			revalidateTag("discovery:live_commerce", "max");
			revalidateTag("discovery:history", "max");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn("[cache] revalidateTag failed", {
				route: "daily-discovery-live",
				error: msg,
			});
		}

		return NextResponse.json({
			ok: true,
			context: CONTEXT,
			sessionId,
			producedCount: savedCount,
			iterations: orchestrated.iterations,
			poolSize: orchestrated.poolSize,
			// Optional boost stages (L1-L4) that did not run this execution
			// (budget exhausted / timeout / error). Empty = all applied.
			skippedStages: stages.skipped(),
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[cron ${CONTEXT}] failed:`, msg);
		await finalizeSession({
			sessionId,
			status: "failed",
			producedCount: 0,
			iterations: 0,
			error: `[${invocationOrigin()}] ${msg}`.slice(0, 500),
		});
		return NextResponse.json(
			{ ok: false, context: CONTEXT, sessionId, error: msg },
			{ status: 500 },
		);
	}
}
