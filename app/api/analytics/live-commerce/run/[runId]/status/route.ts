import { NextRequest } from "next/server";
import { getRun } from "workflow/api";

export const maxDuration = 30;

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ runId: string }> },
) {
	const { runId } = await params;
	try {
		const run = getRun(runId);
		const status = await run.status;
		if (status === "completed") {
			const returnValue = (await run.returnValue) as { strategyId?: string; generatedAt?: string } | undefined;
			return Response.json({ status, returnValue });
		}
		return Response.json({ status });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ status: "unknown", error: message }, { status: 404 });
	}
}
