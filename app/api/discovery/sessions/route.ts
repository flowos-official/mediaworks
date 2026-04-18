import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 30;

/**
 * List recent sessions for navigation.
 * Query params:
 *   - limit (default 30, max 100)
 *   - offset (default 0)
 */
export async function GET(req: NextRequest) {
	const sb = getServiceClient();
	const { searchParams } = new URL(req.url);

	const limit = Math.min(
		Number(searchParams.get("limit") ?? DEFAULT_LIMIT),
		100,
	);
	const offset = Number(searchParams.get("offset") ?? 0);

	let q = sb
		.from("discovery_runs")
		.select("id, run_at, completed_at, status, target_count, produced_count, iterations, context")
		.order("run_at", { ascending: false });

	const contextFilter = searchParams.get("context");
	if (contextFilter === "home_shopping" || contextFilter === "live_commerce") {
		q = q.eq("context", contextFilter);
	}

	const { data, error } = await q.range(offset, offset + limit - 1);

	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
	return NextResponse.json({ sessions: data ?? [] });
}
