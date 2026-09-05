/**
 * GET /api/intelligence/imports/:id — one batch, its rows, and its errors.
 *
 * Scoped by created_by as well as id. RLS already restricts this, and the
 * explicit filter is the second lock: it also turns someone else's batch into
 * a 404 rather than an empty 200 that reads like "no rows".
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";

export const maxDuration = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS = 500;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { id } = await ctx.params;
	if (!UUID_RE.test(id)) {
		return NextResponse.json({ code: "invalid_id", message: "invalid batch id" }, { status: 404 });
	}

	const { data: batch, error } = await auth.sb
		.from("import_batches")
		.select("id, file_name, file_sha256, status, column_mapping, row_counts, created_at, updated_at")
		.eq("id", id)
		.eq("created_by", auth.user.id)
		.maybeSingle();
	if (error) return NextResponse.json({ code: "read_failed", message: error.message }, { status: 500 });
	if (!batch) return NextResponse.json({ code: "not_found", message: "not found" }, { status: 404 });

	const { data: rows } = await auth.sb
		.from("import_rows")
		.select("row_number, raw_json, normalized_json, validation_errors, canonical_product_id, applied_at")
		.eq("import_batch_id", id)
		.order("row_number", { ascending: true })
		.limit(MAX_ROWS);

	return NextResponse.json({ batch, rows: rows ?? [] });
}
