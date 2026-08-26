import { NextRequest, NextResponse } from "next/server";
import { isDuplicateInvocation, invocationOrigin, isDuplicateRunError, waitForBlockingRun } from "@/lib/cron/duplicate-guard";
import { revalidateTag } from "next/cache";
import { applyBroadcastBoost, tagBroadcastEvidence } from "@/lib/discovery/broadcast";
import { applyRecentBroadcastPenalty } from "@/lib/discovery/recent-broadcast-penalty";
import { applyCompetitorTrendBoost } from "@/lib/discovery/competitor-trend-boost";
import { applyEvidenceBonus, computeTvEvidence } from "@/lib/discovery/tv-evidence";
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
const CONTEXT = "home_shopping" as const;
const SAVE_FINALIZE_DEADLINE_MS = Number(
	process.env.DISCOVERY_SAVE_FINALIZE_DEADLINE_MS ?? 270_000,
);
const TV_EVIDENCE_MIN_BUDGET_MS = Number(
	process.env.DISCOVERY_TV_EVIDENCE_MIN_BUDGET_MS ?? 45_000,
);
const CATEGORY_ENRICH_MIN_BUDGET_MS = Number(
	process.env.DISCOVERY_CATEGORY_ENRICH_MIN_BUDGET_MS ?? 10_000,
);
const OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS = Number(
	process.env.DISCOVERY_OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS ?? 20_000,
);

async function loadLearningState(): Promise<LearningState> {
	try {
		const sb = getServiceClient();
		const { data, error } = await sb
			.from("learning_state")
			.select("*")
			.eq("context", "home_shopping")
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

		const broadcasts = await runOptionalStage({
			label: `${CONTEXT}:broadcast-evidence`,
			startedAtMs: startedAt,
			deadlineMs: SAVE_FINALIZE_DEADLINE_MS,
			minSaveBudgetMs: OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS,
			fallback: [] as Awaited<ReturnType<typeof tagBroadcastEvidence>>,
			task: () => tagBroadcastEvidence(orchestrated.candidates),
			onOutcome: stages.record,
		});
		const broadcastMap = new Map(broadcasts.map((b) => [b.productUrl, b]));

		// Apply broadcast-evidence boost to tvFitScore before saving so the
		// persisted score reflects competitor-signal reweighting.
		applyBroadcastBoost(
			orchestrated.candidates,
			new Map(broadcasts.map((b) => [b.productUrl, b.tag])),
		);

		// Soft penalty for products MediaWorks just aired on QVC. Only
		// candidates whose productUrl is a qvc.jp/product.{id}.html page
		// are considered; others are unaffected.
		await runOptionalStage({
			label: `${CONTEXT}:recent-broadcast-penalty`,
			startedAtMs: startedAt,
			deadlineMs: SAVE_FINALIZE_DEADLINE_MS,
			minSaveBudgetMs: OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS,
			fallback: null,
			task: async () => {
				await applyRecentBroadcastPenalty(orchestrated.candidates);
				return null;
			},
			onOutcome: stages.record,
		});

		// Phase 3-C: small boost when the candidate aligns with categories
		// that are hot on competitor channels (QVC + ShopCh, last 30 days).
		await runOptionalStage({
			label: `${CONTEXT}:competitor-trend-boost`,
			startedAtMs: startedAt,
			deadlineMs: SAVE_FINALIZE_DEADLINE_MS,
			minSaveBudgetMs: OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS,
			fallback: null,
			task: async () => {
				await applyCompetitorTrendBoost(orchestrated.candidates);
				return null;
			},
			onOutcome: stages.record,
		});

		// TV evidence: per-candidate broadcast-history aggregate.
		// Spec: docs/superpowers/specs/2026-05-17-tv-evidence-mining-design.md
		const sb = getServiceClient();
		const fallbackEvidenceEntries = orchestrated.candidates.map(
			(c) => [c.productUrl, null] as const,
		);
		const evidenceEntries = await runOptionalStage({
			label: `${CONTEXT}:tv-evidence`,
			startedAtMs: startedAt,
			deadlineMs: SAVE_FINALIZE_DEADLINE_MS,
			minSaveBudgetMs: Math.max(
				OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS,
				TV_EVIDENCE_MIN_BUDGET_MS,
			),
			fallback: fallbackEvidenceEntries,
			onOutcome: stages.record,
			task: async () =>
				Promise.all(
					orchestrated.candidates.map(async (c) => {
						const tvChannels = c.tvChannelMatches?.length
							? c.tvChannelMatches
							: c.tvChannel
								? [c.tvChannel]
								: undefined;
						const ev = await computeTvEvidence(sb, {
							name: c.name,
							category: c.category ?? null,
							price_jpy: c.priceJpy ?? null,
							tv_channels: tvChannels,
						}).catch((err) => {
							console.warn(`[tv-evidence] compute failed for ${c.productUrl}:`, err?.message ?? err);
							return null;
						});
						return [c.productUrl, ev] as const;
					}),
				),
		});
		const evidenceMap = new Map(evidenceEntries);
		applyEvidenceBonus(orchestrated.candidates, evidenceMap);

		const batch = orchestrated.candidates.map((c) => {
			const bc = broadcastMap.get(c.productUrl);
			return {
				candidate: c,
				broadcastTag: bc?.tag ?? ("unknown" as const),
				broadcastSources: bc?.sources ?? [],
				tvEvidence: evidenceMap.get(c.productUrl) ?? null,
			};
		});
		const savedCount = await saveDiscoveredProducts(sessionId, batch, {
			categoryEnrichmentDeadlineMs:
				startedAt + SAVE_FINALIZE_DEADLINE_MS,
			minCategoryEnrichmentBudgetMs: CATEGORY_ENRICH_MIN_BUDGET_MS,
		});

		const partial = savedCount < TARGET_COUNT;
		await finalizeSession({
			sessionId,
			status: partial ? "partial" : "completed",
			producedCount: savedCount,
			iterations: orchestrated.iterations,
		});

		try {
			revalidateTag("discovery:home_shopping", "max");
			revalidateTag("discovery:history", "max");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn("[cache] revalidateTag failed", {
				route: "daily-discovery-home",
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
			// Optional scoring stages (penalty/boost/tv-evidence) that did not run
			// this execution (budget exhausted / timeout / error). Empty = all applied.
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
