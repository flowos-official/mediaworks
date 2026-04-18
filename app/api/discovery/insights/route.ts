import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
	const sb = getServiceClient();
	const { searchParams } = new URL(req.url);
	const contextFilter = searchParams.get("context");
	const weeks = Math.min(Number(searchParams.get("weeks") ?? 12), 52);

	const weeksAgo = new Date();
	weeksAgo.setUTCDate(weeksAgo.getUTCDate() - weeks * 7);

	const now = new Date();
	const monday = new Date(now);
	const day = monday.getUTCDay();
	const daysFromMonday = day === 0 ? 6 : day - 1;
	monday.setUTCDate(now.getUTCDate() - daysFromMonday);
	monday.setUTCHours(0, 0, 0, 0);

	let kpiQuery = sb
		.from("discovered_products")
		.select("user_action")
		.gte("created_at", monday.toISOString());
	if (contextFilter === "home_shopping" || contextFilter === "live_commerce") {
		kpiQuery = kpiQuery.eq("context", contextFilter);
	}
	const { data: thisWeek } = await kpiQuery;
	const thisWeekRows = (thisWeek ?? []) as Array<{ user_action: string | null }>;
	const thisWeekSourced = thisWeekRows.filter((r) => r.user_action === "sourced").length;
	const thisWeekRejected = thisWeekRows.filter((r) => r.user_action === "rejected").length;

	let stateQuery = sb.from("learning_state").select("*");
	if (contextFilter === "home_shopping" || contextFilter === "live_commerce") {
		stateQuery = stateQuery.eq("context", contextFilter);
	}
	const { data: states } = await stateQuery;
	const stateRows = (states ?? []) as Array<{
		exploration_ratio: number;
		feedback_sample_size: number;
		category_weights: Record<string, number> | null;
	}>;
	const explorationRatio =
		stateRows.reduce((sum, s) => sum + Number(s.exploration_ratio ?? 0), 0) /
		(stateRows.length || 1);
	const totalSamples = stateRows.reduce(
		(sum, s) => sum + Number(s.feedback_sample_size ?? 0),
		0,
	);

	let insightsQuery = sb
		.from("learning_insights")
		.select("*")
		.gte("week_start", weeksAgo.toISOString().slice(0, 10))
		.order("week_start", { ascending: false });
	if (contextFilter === "home_shopping" || contextFilter === "live_commerce") {
		insightsQuery = insightsQuery.eq("context", contextFilter);
	}
	const { data: weeklyInsights } = await insightsQuery;

	const thirtyDaysAgo = new Date();
	thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
	let dailyQuery = sb
		.from("discovered_products")
		.select("action_at, user_action, action_reason, context")
		.not("user_action", "is", null)
		.gte("action_at", thirtyDaysAgo.toISOString());
	if (contextFilter === "home_shopping" || contextFilter === "live_commerce") {
		dailyQuery = dailyQuery.eq("context", contextFilter);
	}
	const { data: dailyRows } = await dailyQuery;
	const dailyItems = (dailyRows ?? []) as Array<{
		action_at: string;
		user_action: string | null;
		action_reason: string | null;
	}>;

	const dailyMap = new Map<
		string,
		{ sourced: number; interested: number; rejected: number; duplicate: number }
	>();
	for (const r of dailyItems) {
		if (!r.action_at) continue;
		const date = r.action_at.slice(0, 10);
		const entry =
			dailyMap.get(date) ?? { sourced: 0, interested: 0, rejected: 0, duplicate: 0 };
		if (r.user_action === "sourced") entry.sourced += 1;
		else if (r.user_action === "interested") entry.interested += 1;
		else if (r.user_action === "rejected") entry.rejected += 1;
		else if (r.user_action === "duplicate") entry.duplicate += 1;
		dailyMap.set(date, entry);
	}
	const dailyFeedback = [...dailyMap.entries()]
		.map(([date, counts]) => ({ date, ...counts }))
		.sort((a, b) => a.date.localeCompare(b.date));

	const reasonMap = new Map<string, number>();
	for (const r of dailyItems) {
		if (r.user_action === "rejected") {
			const reason = r.action_reason ?? "不明";
			reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
		}
	}

	const categoryWeights: Record<string, number> = {};
	for (const s of stateRows) {
		const weights = s.category_weights ?? null;
		if (weights) {
			for (const [cat, weight] of Object.entries(weights)) {
				categoryWeights[cat] = Math.max(categoryWeights[cat] ?? 0, weight);
			}
		}
	}

	const insightRows = (weeklyInsights ?? []) as Array<{
		week_start: string;
		context: "home_shopping" | "live_commerce";
	}>;
	const trendMap = new Map<string, { home: number; live: number }>();
	for (const w of insightRows.slice(0, 24)) {
		const entry = trendMap.get(w.week_start) ?? { home: 0, live: 0 };
		trendMap.set(w.week_start, entry);
	}
	const explorationTrend = [...trendMap.entries()]
		.map(([week, v]) => ({ week, ...v }))
		.sort((a, b) => a.week.localeCompare(b.week));

	return NextResponse.json({
		kpi: {
			thisWeekSourced,
			thisWeekRejected,
			explorationRatio,
			totalSamples,
		},
		weeklyInsights: weeklyInsights ?? [],
		categoryWeights,
		explorationTrend,
		rejectionReasons: [...reasonMap.entries()].map(([reason, count]) => ({ reason, count })),
		dailyFeedback,
	});
}
