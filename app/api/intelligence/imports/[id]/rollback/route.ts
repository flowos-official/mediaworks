/**
 * POST /api/intelligence/imports/:id/rollback — stop using this batch.
 *
 * Revokes, never deletes. A knowledge snapshot taken while the evidence was
 * active still names those rows; deleting them would break that link and
 * quietly rewrite what a past recommendation is recorded as having read.
 *
 * A reason is required because the question "why did this number change?"
 * arrives weeks later, and a rollback with no reason cannot answer it.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import {
	createImportApplyRepository,
	ImportApplyError,
	rollbackImportBatch,
} from "@/lib/intelligence/imports/apply";

export const maxDuration = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { id } = await ctx.params;
	if (!UUID_RE.test(id)) {
		return NextResponse.json({ code: "invalid_id", message: "invalid batch id" }, { status: 404 });
	}

	const body = await req.json().catch(() => null);
	const reason =
		body && typeof body === "object" && typeof (body as Record<string, unknown>).reason === "string"
			? ((body as Record<string, unknown>).reason as string)
			: "";

	try {
		const result = await rollbackImportBatch(
			createImportApplyRepository(auth.sb, getServiceClient()),
			id,
			auth.user.id,
			reason,
		);
		return NextResponse.json(result);
	} catch (error) {
		if (error instanceof ImportApplyError) {
			return NextResponse.json({ code: error.code, message: error.message }, { status: error.status });
		}
		console.error("[imports] rollback failed:", error instanceof Error ? error.message : error);
		return NextResponse.json({ code: "rollback_failed", message: "取り消しに失敗しました" }, { status: 500 });
	}
}
