import { NextRequest, NextResponse } from "next/server";
import { tagBroadcastEvidence } from "@/lib/discovery/broadcast";
import { runStage1 } from "@/lib/discovery/orchestrator";
import {
	attachPlanToSession,
	createSession,
	finalizeSession,
	saveDiscoveredProducts,
} from "@/lib/discovery/save";
import { getServiceClient } from "@/lib/supabase";
import { DEFAULT_LEARNING_STATE, type LearningState } from "@/lib/discovery/types";

export const maxDuration = 300;

const TARGET_COUNT = Number(process.env.DISCOVERY_TARGET_COUNT ?? 30);

async function loadLearningState(): Promise<LearningState> {
	try {
		const sb = getServiceClient();
		const { data, error } = await sb
			.from("learning_state")
			.select("*")
			.eq("id", 1)
			.single();
		if (error || !data) return DEFAULT_LEARNING_STATE;
		return {
			exploration_ratio: data.exploration_ratio,
			category_weights: data.category_weights ?? {},
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
	// Vercel Cron auto-injects Authorization: Bearer <CRON_SECRET>
	const secret = process.env.CRON_SECRET;
	if (!secret) return true; // dev mode — allow
	const header = req.headers.get("authorization");
	return header === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
	if (!verifyCronAuth(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const learning = await loadLearningState();
	const sessionId = await createSession({
		targetCount: TARGET_COUNT,
		explorationRatio: learning.exploration_ratio,
	});

	try {
		// Stage 1 pipeline
		const orchestrated = await runStage1(learning, TARGET_COUNT);
		await attachPlanToSession(sessionId, orchestrated.plan);

		// Stage 1 단계 7: broadcast tagging
		const broadcasts = await tagBroadcastEvidence(orchestrated.candidates);
		const broadcastMap = new Map(broadcasts.map((b) => [b.productUrl, b]));

		// Stage 1 단계 8: save
		const batch = orchestrated.candidates.map((c) => {
			const bc = broadcastMap.get(c.productUrl);
			return {
				candidate: c,
				broadcastTag: bc?.tag ?? ("unknown" as const),
				broadcastSources: bc?.sources ?? [],
			};
		});
		const savedCount = await saveDiscoveredProducts(sessionId, batch);

		const partial = savedCount < TARGET_COUNT;
		await finalizeSession({
			sessionId,
			status: partial ? "partial" : "completed",
			producedCount: savedCount,
			iterations: orchestrated.iterations,
		});

		return NextResponse.json({
			ok: true,
			sessionId,
			producedCount: savedCount,
			iterations: orchestrated.iterations,
			poolSize: orchestrated.poolSize,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("[cron daily-discovery] failed:", msg);
		await finalizeSession({
			sessionId,
			status: "failed",
			producedCount: 0,
			iterations: 0,
			error: msg.slice(0, 500),
		});
		return NextResponse.json(
			{ ok: false, sessionId, error: msg },
			{ status: 500 },
		);
	}
}
