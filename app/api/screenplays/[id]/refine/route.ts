import { NextRequest } from "next/server";
import { start } from "workflow/api";
import { getServiceClient } from "@/lib/supabase";
import { screenplayWorkflow } from "@/lib/workflows/screenplay.workflow";
import type { ProductBrief } from "@/lib/screenplay/types";

export const maxDuration = 60;

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const body = await request.json().catch(() => ({}));
	const feedback: string =
		typeof body.feedback === "string" ? body.feedback.trim() : "";
	if (!feedback) {
		return Response.json(
			{ error: "feedback (non-empty) required" },
			{ status: 400 },
		);
	}
	const baseVersionId: string | undefined =
		typeof body.baseVersionId === "string" ? body.baseVersionId : undefined;

	const supabase = getServiceClient();
	const { data: sp, error: spErr } = await supabase
		.from("screenplays")
		.select("id, product_info_snapshot, current_version_id, status")
		.eq("id", id)
		.single();
	if (spErr || !sp) {
		return Response.json(
			{ error: spErr?.message ?? "Not found" },
			{ status: 404 },
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
