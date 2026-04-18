import { NextRequest, NextResponse } from "next/server";
import { computeContextLearning } from "@/lib/discovery/learning";
import { getServiceClient } from "@/lib/supabase";
import type { Context } from "@/lib/discovery/types";

export const maxDuration = 60;

const CONTEXTS: Context[] = ["home_shopping", "live_commerce"];

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

	const sb = getServiceClient();
	const results: Array<{ context: Context; ok: boolean; error?: string }> = [];

	for (const context of CONTEXTS) {
		try {
			const { data: current } = await sb
				.from("learning_state")
				.select("exploration_ratio")
				.eq("context", context)
				.single();

			const currentRatio = Number(current?.exploration_ratio ?? 0.47);

			const stats = await computeContextLearning(context, currentRatio);

			const { error: upsertErr } = await sb.from("learning_state").upsert(
				{
					context,
					exploration_ratio: stats.exploration_ratio,
					category_weights: stats.category_weights,
					rejected_seeds: stats.rejected_seeds,
					recent_rejection_reasons: stats.recent_rejection_reasons,
					feedback_sample_size: stats.feedback_sample_size,
					is_cold_start: stats.is_cold_start,
					updated_at: new Date().toISOString(),
				},
				{ onConflict: "context" },
			);

			if (upsertErr) {
				throw new Error(upsertErr.message);
			}
			results.push({ context, ok: true });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[daily-learning] ${context} failed:`, msg);
			results.push({ context, ok: false, error: msg });
		}
	}

	return NextResponse.json({ results });
}
