import { NextRequest } from "next/server";
import { start } from "workflow/api";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { screenplayWorkflow } from "@/lib/workflows/screenplay.workflow";
import type { ProductBrief } from "@/lib/screenplay/types";

export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
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

	// Pre-check: read to give nice 404 vs 400 errors before attempting claim.
	const { data: sp, error: spErr } = await supabase
		.from("screenplays")
		.select("id, product_info_snapshot, current_version_id, status")
		.eq("id", id)
		.single();
	if (spErr || !sp) {
		return Response.json({ error: "screenplay not found" }, { status: 404 });
	}
	const base = baseVersionId ?? sp.current_version_id;
	if (!base) {
		return Response.json(
			{ error: "no base version to refine from" },
			{ status: 400 },
		);
	}
	// Guard: an explicitly-supplied baseVersionId must belong to THIS screenplay,
	// so the base_version_id chain (used by the diff feature) can never point at
	// another screenplay's version.
	if (baseVersionId) {
		const { data: baseRow } = await supabase
			.from("screenplay_versions")
			.select("id")
			.eq("id", baseVersionId)
			.eq("screenplay_id", id)
			.maybeSingle();
		if (!baseRow) {
			return Response.json(
				{ error: "base version does not belong to this screenplay" },
				{ status: 400 },
			);
		}
	}

	// Atomic compare-and-set: only ONE concurrent refine can flip the row from
	// non-generating → generating. The .neq("status","generating") ensures the
	// UPDATE no-ops for any racing requests; .maybeSingle() returns null in
	// that case. This closes the race the stress suite found
	// (3 parallel refines previously returned 200,200,409 because two passed
	// the read before either commit landed).
	const { data: claimed, error: claimErr } = await supabase
		.from("screenplays")
		.update({ status: "generating", last_error: null, updated_at: new Date().toISOString() })
		.eq("id", id)
		.neq("status", "generating")
		.select("id")
		.maybeSingle();
	if (claimErr) {
		console.error("[screenplays] refine claim failed:", claimErr);
		return Response.json({ error: "claim failed" }, { status: 500 });
	}
	if (!claimed) {
		return Response.json(
			{ error: "another generation is already in progress for this screenplay" },
			{ status: 409 },
		);
	}

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
			.update({
				status: "failed",
				last_error: "台本改稿ワークフローを開始できませんでした。管理者に連絡してください。",
			})
			.eq("id", id);
		const msg = err instanceof Error ? err.message : String(err);
		return Response.json({ error: msg }, { status: 500 });
	}
}
