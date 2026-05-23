import { NextRequest, NextResponse } from "next/server";
import { applyBroadcastBoost, tagBroadcastEvidence } from "@/lib/discovery/broadcast";
import { applyRecentBroadcastPenalty } from "@/lib/discovery/recent-broadcast-penalty";
import { applyCompetitorTrendBoost } from "@/lib/discovery/competitor-trend-boost";
import { applyEvidenceBonus, computeTvEvidence } from "@/lib/discovery/tv-evidence";
import { runStage1 } from "@/lib/discovery/orchestrator";
import { runOptionalStage } from "@/lib/discovery/cron-budget";
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
	const sessionId = await createSession({
		targetCount: TARGET_COUNT,
		explorationRatio: learning.exploration_ratio,
		context: CONTEXT,
	});

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
		});
		const broadcastMap = new Map(broadcasts.map((b) => [b.productUrl, b]));

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

		return NextResponse.json({
			ok: true,
			context: CONTEXT,
			sessionId,
			producedCount: savedCount,
			iterations: orchestrated.iterations,
			poolSize: orchestrated.poolSize,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[cron ${CONTEXT}] failed:`, msg);
		await finalizeSession({
			sessionId,
			status: "failed",
			producedCount: 0,
			iterations: 0,
			error: msg.slice(0, 500),
		});
		return NextResponse.json(
			{ ok: false, context: CONTEXT, sessionId, error: msg },
			{ status: 500 },
		);
	}
}
