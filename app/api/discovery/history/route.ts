import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * History API — returns sessions grouped by date for calendar rendering,
 * with optional context filter and date range.
 *
 * Reads from the `discovery_run_feedback_stats` view, which pre-aggregates
 * per-session product_count and feedback_count on the database side. This
 * keeps API cost flat regardless of how many discovered_products rows exist.
 *
 * Query params:
 *   - context: home_shopping | live_commerce (optional)
 *   - from: ISO date (default: now - 60 days)
 *   - to: ISO date (default: now)
 */
export async function GET(req: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const sb = getServiceClient();
	const { searchParams } = new URL(req.url);

	const contextFilter = searchParams.get("context");
	const toDate = searchParams.get("to") ?? new Date().toISOString();
	const fromDate =
		searchParams.get("from") ??
		new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();

	let q = sb
		.from("discovery_run_feedback_stats")
		.select(
			"id, run_at, completed_at, status, target_count, produced_count, iterations, context, product_count, feedback_count",
		)
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

	const sessions = (data ?? []).map((row) => ({
		id: row.id,
		run_at: row.run_at,
		completed_at: row.completed_at,
		status: row.status,
		target_count: row.target_count,
		produced_count: row.produced_count,
		iterations: row.iterations,
		context: row.context,
		feedback_total: row.product_count ?? 0,
		feedback_count: row.feedback_count ?? 0,
	}));

	return NextResponse.json({
		sessions,
		range: { from: fromDate, to: toDate },
	});
}
