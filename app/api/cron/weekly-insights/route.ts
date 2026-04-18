import { NextRequest, NextResponse } from "next/server";
import { aggregateWeek, generateWeeklyInsight } from "@/lib/discovery/weekly-insights";
import { getServiceClient } from "@/lib/supabase";
import type { Context } from "@/lib/discovery/types";

export const maxDuration = 120;

const CONTEXTS: Context[] = ["home_shopping", "live_commerce"];

function verifyCronAuth(req: NextRequest): boolean {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true;
	const header = req.headers.get("authorization");
	return header === `Bearer ${secret}`;
}

function getLastWeekRange(): { start: Date; end: Date } {
	const now = new Date();
	const day = now.getUTCDay();
	const daysToLastSunday = day === 0 ? 7 : day;
	const lastSunday = new Date(now);
	lastSunday.setUTCDate(now.getUTCDate() - daysToLastSunday);
	lastSunday.setUTCHours(23, 59, 59, 999);
	const lastMonday = new Date(lastSunday);
	lastMonday.setUTCDate(lastSunday.getUTCDate() - 6);
	lastMonday.setUTCHours(0, 0, 0, 0);
	return { start: lastMonday, end: lastSunday };
}

export async function GET(req: NextRequest) {
	if (!verifyCronAuth(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const sb = getServiceClient();
	const { start, end } = getLastWeekRange();
	const results: Array<{ context: Context; ok: boolean; error?: string }> = [];

	for (const context of CONTEXTS) {
		try {
			const input = await aggregateWeek(context, start, end);
			const summary = await generateWeeklyInsight(input);

			const { error } = await sb.from("learning_insights").upsert(
				{
					context,
					week_start: start.toISOString().slice(0, 10),
					sourced_count: input.sourcedCount,
					rejected_count: input.rejectedCount,
					top_rejection_reasons: input.topRejectionReasons,
					sourced_product_patterns: summary.sourced_product_patterns,
					exploration_wins: summary.exploration_wins,
					next_week_suggestions: summary.next_week_suggestions,
				},
				{ onConflict: "week_start,context" },
			);

			if (error) throw new Error(error.message);
			results.push({ context, ok: true });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[weekly-insights] ${context} failed:`, msg);
			results.push({ context, ok: false, error: msg });
		}
	}

	return NextResponse.json({ results });
}
