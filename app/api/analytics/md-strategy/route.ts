import { NextRequest } from "next/server";
import { fetchStrategyContext, runStrategyOrchestrator } from "@/lib/md-strategy";
import { getServiceClient } from "@/lib/supabase";
import type { ProgressEvent, FullStrategyResult } from "@/lib/md-strategy";

export const maxDuration = 300;

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

export async function POST(request: NextRequest) {
	const body = await request.json().catch(() => ({}));
	const userGoal: string = body.userGoal || "";
	const category: string | undefined = body.category || undefined;
	const targetMarket: string | undefined = body.targetMarket || undefined;
	const priceRange: string | undefined = body.priceRange || undefined;

	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			};

			// Send heartbeat every 10s to prevent Vercel idle timeout
			const heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(`: heartbeat\n\n`));
				} catch {
					clearInterval(heartbeat);
				}
			}, 10000);

			try {
				// Phase 1: Data fetch
				send("progress", { skill: "data_fetch", status: "running", index: -1, total: 7 });
				const recommend = category && targetMarket ? { category, targetMarket, priceRange } : undefined;
				const context = await fetchStrategyContext(userGoal || undefined, recommend);
				send("progress", { skill: "data_fetch", status: "complete", index: -1, total: 7 });

				// Phase 2: Skill pipeline
				const result = await runStrategyOrchestrator(context, (event: ProgressEvent) => {
					if (event.status === "complete") {
						send("skill_result", { skill: event.skill, index: event.index, total: event.total, data: event.data });
					} else if (event.status === "error") {
						send("skill_error", { skill: event.skill, index: event.index, total: event.total, error: event.error });
					} else {
						send("progress", event);
					}
				});

				// Phase 3: Save to Supabase
				let strategyId: string | null = null;
				try {
					const supabase = getServiceClient();
					const { data: inserted, error: insertError } = await supabase
						.from("md_strategies")
						.insert({
							user_goal: userGoal || null,
							category: category || null,
							target_market: targetMarket || null,
							price_range: priceRange || null,
							product_selection: result.product_selection as unknown as Record<string, unknown>,
							channel_strategy: result.channel_strategy as unknown as Record<string, unknown>,
							pricing_margin: result.pricing_margin as unknown as Record<string, unknown>,
							marketing_execution: result.marketing_execution as unknown as Record<string, unknown>,
							financial_projection: result.financial_projection as unknown as Record<string, unknown>,
							risk_contingency: result.risk_contingency as unknown as Record<string, unknown>,
						})
						.select("id")
						.single();

					if (insertError) {
						console.error("[md-strategy] Save failed:", insertError.message);
					} else {
						strategyId = inserted?.id ?? null;
					}
				} catch (saveErr) {
					console.error("[md-strategy] Save error:", saveErr);
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
