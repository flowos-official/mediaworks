import { NextRequest } from "next/server";
import { getRun } from "workflow/api";
import type { ProgressEvent } from "@/lib/screenplay/types";

export const maxDuration = 800;

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ runId: string }> },
) {
	const { runId } = await params;
	const run = getRun(runId);
	const source = run.getReadable<ProgressEvent>({ namespace: "progress" });
	const encoder = new TextEncoder();
	const ndjson = source.pipeThrough(
		new TransformStream<ProgressEvent, Uint8Array>({
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
