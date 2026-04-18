import { NextRequest } from "next/server";
import { start } from "workflow/api";
import { liveCommerceWorkflow } from "@/lib/workflows/live-commerce.workflow";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 60;

export async function GET() {
	const supabase = getServiceClient();
	const { data, error } = await supabase
		.from("live_commerce_strategies")
		.select("id, user_goal, target_platforms, created_at")
		.order("created_at", { ascending: false })
		.limit(20);

	if (error) {
		return Response.json({ error: error.message }, { status: 500 });
	}
	return Response.json({ strategies: data ?? [] });
}

export async function POST(request: NextRequest) {
	const body = await request.json().catch(() => ({}));
	const input = {
		userGoal: typeof body.userGoal === "string" ? body.userGoal : "",
		targetPlatforms: Array.isArray(body.targetPlatforms) ? (body.targetPlatforms as string[]) : undefined,
		seedProductId: typeof body.seedProductId === "string" ? body.seedProductId : undefined,
	};
	try {
		const run = await start(liveCommerceWorkflow, [input]);
		return Response.json({ runId: run.runId });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("[live-commerce] failed to start workflow:", message);
		return Response.json({ error: message }, { status: 500 });
	}
}
