import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * History API — returns sessions grouped by date for calendar rendering,
 * with optional context filter and date range.
 * Query params:
 *   - context: home_shopping | live_commerce (optional)
 *   - from: ISO date (default: now - 60 days)
 *   - to: ISO date (default: now)
 */
export async function GET(req: NextRequest) {
	const sb = getServiceClient();
	const { searchParams } = new URL(req.url);

	const contextFilter = searchParams.get("context");
	const toDate = searchParams.get("to") ?? new Date().toISOString();
	const fromDate =
		searchParams.get("from") ??
		new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();

	let q = sb
		.from("discovery_runs")
		.select("id, run_at, completed_at, status, target_count, produced_count, iterations, context")
		.gte("run_at", fromDate)
		.lte("run_at", toDate)
		.order("run_at", { ascending: false });

	if (contextFilter === "home_shopping" || contextFilter === "live_commerce") {
		q = q.eq("context", contextFilter);
	}

	const { data, error } = await q;
	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}

	return NextResponse.json({
		sessions: data ?? [],
		range: { from: fromDate, to: toDate },
	});
}
