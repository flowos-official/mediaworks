import { NextRequest } from "next/server";
import { start } from "workflow/api";
import { getServiceClient } from "@/lib/supabase";
import { screenplayWorkflow } from "@/lib/workflows/screenplay.workflow";
import type { ProductBrief } from "@/lib/screenplay/types";

export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	if (!UUID_RE.test(id)) {
		return Response.json({ error: "invalid id" }, { status: 404 });
	}

	const body = await request.json().catch(() => ({}));
	const feedback: string =
		typeof body.feedback === "string" ? body.feedback.trim() : "";
	if (!feedback) {
		return Response.json(
			{ error: "feedback (non-empty) required" },
			{ status: 400 },
		);
	}
	if (feedback.length > 4000) {
		return Response.json(
			{ error: "feedback too long (max 4000 chars)" },
			{ status: 400 },
		);
	}
	const baseVersionId: string | undefined =
		typeof body.baseVersionId === "string" && UUID_RE.test(body.baseVersionId)
			? body.baseVersionId
			: undefined;

	const supabase = getServiceClient();
	const { data: sp, error: spErr } = await supabase
		.from("screenplays")
		.select("id, product_info_snapshot, current_version_id, status")
		.eq("id", id)
		.single();
	if (spErr || !sp) {
		return Response.json({ error: "screenplay not found" }, { status: 404 });
	}

	// Block concurrent refines on the same screenplay.
	if (sp.status === "generating") {
		return Response.json(
			{ error: "another generation is already in progress for this screenplay" },
			{ status: 409 },
		);
	}

	const base = baseVersionId ?? sp.current_version_id;
	if (!base) {
		return Response.json(
			{ error: "no base version to refine from" },
			{ status: 400 },
		);
	}

	await supabase
		.from("screenplays")
		.update({ status: "generating" })
		.eq("id", id);

	try {
		const run = await start(screenplayWorkflow, [
			{
				screenplayId: id,
				mode: "refine",
				productBrief: sp.product_info_snapshot as ProductBrief,
				feedback,
				baseVersionId: base,
			},
		]);
		await supabase
			.from("screenplays")
			.update({ last_run_id: run.runId })
			.eq("id", id);
		return Response.json({ runId: run.runId });
	} catch (err) {
		await supabase
			.from("screenplays")
			.update({ status: "failed" })
			.eq("id", id);
		const msg = err instanceof Error ? err.message : String(err);
		return Response.json({ error: msg }, { status: 500 });
	}
}
