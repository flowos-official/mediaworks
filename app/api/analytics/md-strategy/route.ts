import { NextRequest } from "next/server";
import { fetchStrategyContext, runStrategyOrchestrator } from "@/lib/md-strategy";
import type { ProgressEvent } from "@/lib/md-strategy";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
	const body = await request.json().catch(() => ({}));
	const userGoal: string = body.userGoal || "";

	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			};

			try {
				// Phase 1: Data fetch
				send("progress", { skill: "data_fetch", status: "running", index: -1, total: 6 });
				const context = await fetchStrategyContext(userGoal || undefined);
				send("progress", { skill: "data_fetch", status: "complete", index: -1, total: 6 });

				// Phase 2: Skill pipeline
				await runStrategyOrchestrator(context, (event: ProgressEvent) => {
					if (event.status === "complete") {
						send("skill_result", { skill: event.skill, index: event.index, total: event.total, data: event.data });
					} else if (event.status === "error") {
						send("skill_error", { skill: event.skill, index: event.index, total: event.total, error: event.error });
					} else {
						send("progress", event);
					}
				});

				send("complete", { generatedAt: new Date().toISOString() });
			} catch (err) {
				send("error", { message: err instanceof Error ? err.message : String(err) });
			} finally {
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}
