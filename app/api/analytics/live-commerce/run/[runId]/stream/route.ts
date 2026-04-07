import { NextRequest } from "next/server";
import { getRun } from "workflow/api";
import type { LCProgressEvent } from "@/lib/live-commerce-strategy";

export const maxDuration = 300;

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ runId: string }> },
) {
	const { runId } = await params;
	const run = getRun(runId);
	const source = run.getReadable<LCProgressEvent>({ namespace: "progress" });

	const encoder = new TextEncoder();
	const ndjson = source.pipeThrough(
		new TransformStream<LCProgressEvent, Uint8Array>({
			transform(event, controller) {
				controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
			},
		}),
	);

	return new Response(ndjson, {
		headers: {
			"Content-Type": "application/x-ndjson; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
