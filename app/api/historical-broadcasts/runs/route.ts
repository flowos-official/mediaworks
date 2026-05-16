import { requireUser } from "@/lib/auth/require-user";
import { type NextRequest, NextResponse } from "next/server";
import { loadBaseline } from "@/lib/historical-crawl/runs";

const INT_PARAM = /^\d+$/;

export async function GET(req: NextRequest) {
	// Admin-only — operational telemetry.
	const auth = await requireUser(["admin"]);
	if ("error" in auth) return auth.error;

	const { searchParams } = new URL(req.url);
	const limitRaw = searchParams.get("limit");
	if (limitRaw !== null && !INT_PARAM.test(limitRaw)) {
		return NextResponse.json({ error: "invalid limit" }, { status: 400 });
	}
	const limit = Math.min(limitRaw === null ? 30 : parseInt(limitRaw, 10), 100);

	const { data: runs, error } = await auth.sb
		.from("historical_crawl_runs")
		.select(
			"id,run_at,completed_at,jst_date,status,total_rows,upserted,skipped_dup,channels,duration_ms,error",
		)
		.order("run_at", { ascending: false })
		.limit(limit);
	if (error) {
		console.error("[historical-broadcasts/runs] list error", error);
		return NextResponse.json({ error: "db error" }, { status: 500 });
	}

	// Reuse the same RLS-respecting client for the baseline query.
	const baseline = await loadBaseline(7, auth.sb);

	return NextResponse.json(
		{ runs: runs ?? [], baseline },
		{
			headers: {
				"Cache-Control": "private, max-age=60, stale-while-revalidate=300",
			},
		},
	);
}
