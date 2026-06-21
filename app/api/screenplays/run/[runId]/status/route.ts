import { NextRequest } from "next/server";
import { getRun } from "workflow/api";
import { requireUser } from "@/lib/auth/require-user";

export const maxDuration = 30;

const RUN_ID_RE = /^wrun_[A-Z0-9]+$/i;

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ runId: string }> },
) {
	const { runId } = await params;
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
		const status = await run.status;
		if (status === "completed") {
			const returnValue = (await run.returnValue) as
				| { screenplayId?: string; versionId?: string; versionNumber?: number }
				| undefined;
			return Response.json({ status, returnValue });
		}
		return Response.json({ status });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ status: "unknown", error: message }, { status: 404 });
	}
}
