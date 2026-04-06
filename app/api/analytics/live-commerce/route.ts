import { NextRequest } from "next/server";
import { fetchLCContext, runLCOrchestrator } from "@/lib/live-commerce-strategy";
import { getServiceClient } from "@/lib/supabase";
import type { LCProgressEvent } from "@/lib/live-commerce-strategy";

export const maxDuration = 300;

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
	const userGoal: string = body.userGoal || "";
	const targetPlatforms: string[] | undefined = body.targetPlatforms;

	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			};

			const heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(`: heartbeat\n\n`));
				} catch {
					clearInterval(heartbeat);
				}
			}, 10000);

			try {
				send("progress", { skill: "data_fetch", status: "running", index: -1, total: 6 });
				const context = await fetchLCContext(userGoal || undefined, targetPlatforms);
				send("progress", { skill: "data_fetch", status: "complete", index: -1, total: 6 });

				const result = await runLCOrchestrator(context, (event: LCProgressEvent) => {
					if (event.status === "complete" && event.data) {
						send("skill_result", { skill: event.skill, index: event.index, total: event.total, data: event.data });
					} else if (event.status === "error") {
						send("skill_error", { skill: event.skill, index: event.index, total: event.total, error: event.error });
					} else {
						send("progress", event);
					}
				});

				let strategyId: string | null = null;
				try {
					const supabase = getServiceClient();
					const { data: inserted, error: insertError } = await supabase
						.from("live_commerce_strategies")
						.insert({
							user_goal: userGoal || null,
							target_platforms: targetPlatforms ?? context.parsedGoal?.target_platforms ?? null,
							market_research: result.market_research as unknown as Record<string, unknown>,
							platform_analysis: result.platform_analysis as unknown as Record<string, unknown>,
							content_strategy: result.content_strategy as unknown as Record<string, unknown>,
							execution_plan: result.execution_plan as unknown as Record<string, unknown>,
							risk_analysis: result.risk_analysis as unknown as Record<string, unknown>,
							search_sources: context.searchSources as unknown as Record<string, unknown>[],
						})
						.select("id")
						.single();

					if (insertError) {
						console.error("[live-commerce] Save failed:", insertError.message);
					} else {
						strategyId = inserted?.id ?? null;
					}
				} catch (saveErr) {
					console.error("[live-commerce] Save error:", saveErr);
				}

				send("complete", { generatedAt: new Date().toISOString(), strategyId });
			} catch (err) {
				send("error", { message: err instanceof Error ? err.message : String(err) });
			} finally {
				clearInterval(heartbeat);
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}
