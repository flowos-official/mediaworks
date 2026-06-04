import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { normalizeReference } from "@/lib/screenplay/compliance/reference-input";

export const maxDuration = 30;

const COLUMNS =
	"id,law,category_scope,topic,body,keywords,citation,source_url,active,created_at,updated_at";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	const auth = await requireUser(["admin"]);
	if ("error" in auth) return auth.error;
	const { id } = await ctx.params;
	if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
	let body: unknown;
	try { body = await req.json(); }
	catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
	const norm = normalizeReference(body, true);
	if (!norm.ok) return NextResponse.json({ error: norm.error }, { status: 400 });
	if (Object.keys(norm.value).length === 0) return NextResponse.json({ error: "no fields to update" }, { status: 400 });
	norm.value.updated_at = new Date().toISOString();
	const { data, error } = await auth.sb
		.from("compliance_references")
		.update(norm.value)
		.eq("id", id)
		.select(COLUMNS)
		.maybeSingle();
	if (error) {
		if (error.code === "23505") return NextResponse.json({ error: "duplicate (law, topic)" }, { status: 409 });
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
	if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
	return NextResponse.json({ reference: data });
}

// NOTE (Codex #3): no DELETE handler. References are evidence for past compliance
// results, so deletion would make those results irreproducible. Deactivation is
// soft via PATCH { active: false }. Physical purge, if ever needed, is a
// privileged migration/script — never exposed through this API.
