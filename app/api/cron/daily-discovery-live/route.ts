import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { applyRakutenRoomBoost } from "@/lib/discovery/rakuten-room-boost";
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

		// Live-commerce post-processing is intentionally lean compared to
		// home_shopping: TV-broadcast evidence/penalty/competitor-trend layers
		// are skipped entirely because they reflect QVC/ShopCh signals that
		// don't apply to live commerce. The pool itself already sourced from
		// live-commerce platforms (Rakuten Live, ROOM, mercari_shops, 17.live,
		// pinkoi) via the context-aware buildPool branch.
		//
		// What we DO apply: a small ROOM-mention boost — Rakuten ROOM is the
		// closest analogue to "creator-curated commerce" we can query at
		// runtime.
		await runOptionalStage({
			label: `${CONTEXT}:rakuten-room-boost`,
			startedAtMs: startedAt,
			deadlineMs: SAVE_FINALIZE_DEADLINE_MS,
			minSaveBudgetMs: OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS,
			fallback: null,
			task: async () => {
				await applyRakutenRoomBoost(orchestrated.candidates);
				return null;
			},
		});

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
