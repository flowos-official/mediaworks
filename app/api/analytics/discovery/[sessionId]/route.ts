import { NextRequest } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import type { SalesStrategy } from "@/lib/md-strategy";

// GET: Load a specific discovery session with its per-product analyses
export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ sessionId: string }> },
) {
	const { sessionId } = await params;
	const supabase = getServiceClient();

	// Parallel fetch: session data + analyses
	const [sessionResult, analysesResult] = await Promise.all([
		supabase
			.from("discovery_sessions")
			.select("*")
			.eq("id", sessionId)
			.single(),
		supabase
			.from("discovery_product_analyses")
			.select("source_url, sales_strategy")
			.eq("session_id", sessionId),
	]);

	if (sessionResult.error || !sessionResult.data) {
		return Response.json(
			{ error: sessionResult.error?.message ?? "Session not found" },
			{ status: 404 },
		);
	}

	// Build analyses map: source_url → sales_strategy
	const analyses: Record<string, SalesStrategy> = {};
	for (const row of analysesResult.data ?? []) {
		if (row.source_url && row.sales_strategy) {
			analyses[row.source_url] = row.sales_strategy as SalesStrategy;
		}
	}

	return Response.json({
		session: sessionResult.data,
		analyses,
	});
}
