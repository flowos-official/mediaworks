import { requireUser } from "@/lib/auth/require-user";
import { NextRequest } from "next/server";
import { start } from "workflow/api";
import { mdStrategyWorkflow } from "@/lib/workflows/md-strategy.workflow";
import { getCachedStrategyList } from "@/lib/analytics/cached";

export const maxDuration = 60;

// GET: List saved strategies (lightweight — no skill results)
export async function GET() {
	// auth: requireUser
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	try {
		const data = await getCachedStrategyList();
		return Response.json(data);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}

// POST: Start a durable workflow run. Returns runId immediately;
// the client connects to /run/[runId]/stream for progress updates.
export async function POST(request: NextRequest) {
	// auth: requireUser
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const body = await request.json().catch(() => ({}));
	const input = {
		userGoal: typeof body.userGoal === "string" ? body.userGoal : "",
		category: typeof body.category === "string" ? body.category : undefined,
		targetMarket: typeof body.targetMarket === "string" ? body.targetMarket : undefined,
		priceRange: typeof body.priceRange === "string" ? body.priceRange : undefined,
		seedProductId: typeof body.seedProductId === "string" ? body.seedProductId : undefined,
		seedProductIds: Array.isArray(body.seedProductIds)
			? body.seedProductIds.filter((s: unknown): s is string => typeof s === "string")
			: undefined,
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
