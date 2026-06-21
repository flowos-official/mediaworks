import { NextRequest } from "next/server";
import { getRun } from "workflow/api";
import type { ProgressEvent } from "@/lib/screenplay/types";
import { requireUser } from "@/lib/auth/require-user";

export const maxDuration = 800;

const RUN_ID_RE = /^wrun_[A-Z0-9]+$/i;

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ runId: string }> },
) {
	const { runId } = await params;

	// Validate runId shape early to avoid unhandled rejections from the SDK
	// when an unknown / malformed runId is passed.
	if (!RUN_ID_RE.test(runId)) {
		return Response.json({ error: "invalid runId" }, { status: 404 });
	}

	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { data: screenplay, error: screenplayErr } = await auth.sb
		.from("screenplays")
		.select("id")
		.eq("last_run_id", runId)
		.maybeSingle();
	if (screenplayErr) return Response.json({ error: screenplayErr.message }, { status: 500 });
	if (!screenplay) return Response.json({ error: "run not found" }, { status: 404 });

	try {
		const run = getRun(runId);
		// Probe existence before opening the stream — surfaces 404 cleanly.
		try {
			await run.status;
		} catch (probeErr) {
			const msg = probeErr instanceof Error ? probeErr.message : String(probeErr);
			return Response.json({ error: msg }, { status: 404 });
		}
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
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return Response.json({ error: msg }, { status: 500 });
	}
}
