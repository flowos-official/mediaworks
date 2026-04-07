import { NextRequest } from "next/server";
import { start } from "workflow/api";
import { mdStrategyWorkflow } from "@/lib/workflows/md-strategy.workflow";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 60;

// GET: List saved strategies (lightweight — no skill results)
export async function GET() {
	const supabase = getServiceClient();
	const { data, error } = await supabase
		.from("md_strategies")
		.select("id, user_goal, category, target_market, price_range, created_at")
		.order("created_at", { ascending: false })
		.limit(20);

	if (error) {
		return Response.json({ error: error.message }, { status: 500 });
	}
	return Response.json({ strategies: data ?? [] });
}

// POST: Start a durable workflow run. Returns runId immediately;
// the client connects to /run/[runId]/stream for progress updates.
export async function POST(request: NextRequest) {
	const body = await request.json().catch(() => ({}));
	const input = {
		userGoal: typeof body.userGoal === "string" ? body.userGoal : "",
		category: typeof body.category === "string" ? body.category : undefined,
		targetMarket: typeof body.targetMarket === "string" ? body.targetMarket : undefined,
		priceRange: typeof body.priceRange === "string" ? body.priceRange : undefined,
	};
	try {
		const run = await start(mdStrategyWorkflow, [input]);
		return Response.json({ runId: run.runId });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("[md-strategy] failed to start workflow:", message);
		return Response.json({ error: message }, { status: 500 });
	}
}
