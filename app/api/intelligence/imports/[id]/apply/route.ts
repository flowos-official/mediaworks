/**
 * POST /api/intelligence/imports/:id/apply — write the batch into the ledger.
 *
 * The first moment anything from a spreadsheet becomes evidence. It requires a
 * `validated` batch, so a mapping has been confirmed by a person, and it is
 * reversible: every row it writes carries the batch id, and rollback revokes
 * them.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import {
	applyImportBatch,
	createImportApplyRepository,
	ImportApplyError,
} from "@/lib/intelligence/imports/apply";

export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { id } = await ctx.params;
	if (!UUID_RE.test(id)) {
		return NextResponse.json({ code: "invalid_id", message: "invalid batch id" }, { status: 404 });
	}

	try {
		const result = await applyImportBatch(
			createImportApplyRepository(auth.sb, getServiceClient()),
			id,
			auth.user.id,
		);
		return NextResponse.json(result);
	} catch (error) {
		if (error instanceof ImportApplyError) {
			return NextResponse.json({ code: error.code, message: error.message }, { status: error.status });
		}
		console.error("[imports] apply failed:", error instanceof Error ? error.message : error);
		return NextResponse.json({ code: "apply_failed", message: "適用に失敗しました" }, { status: 500 });
	}
}
