import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { normalizeRule, validateRegexPattern } from "@/lib/screenplay/compliance/rule-input";

export const maxDuration = 30;

const COLUMNS =
	"id,law,category_scope,pattern,is_regex,allowed,severity,reason,safe_rewrite,citation,active,created_at,updated_at";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	const auth = await requireUser(["admin"]);
	if ("error" in auth) return auth.error;

	const { id } = await ctx.params;
	if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

	let body: unknown;
	try { body = await req.json(); }
	catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

	const norm = normalizeRule(body, true);
	if (!norm.ok) return NextResponse.json({ error: norm.error }, { status: 400 });
	if (Object.keys(norm.value).length === 0) {
		return NextResponse.json({ error: "no fields to update" }, { status: 400 });
	}

	// Validate the EFFECTIVE (is_regex, pattern) — a toggle of is_regex alone must
	// be checked against the stored pattern, and vice versa.
	const { data: current, error: getErr } = await auth.sb
		.from("compliance_rules")
		.select("pattern, is_regex")
		.eq("id", id)
		.maybeSingle();
	if (getErr) return NextResponse.json({ error: getErr.message }, { status: 500 });
	if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

	const effRegex = "is_regex" in norm.value ? (norm.value.is_regex as boolean) : current.is_regex;
	const effPattern = "pattern" in norm.value ? (norm.value.pattern as string) : current.pattern;
	if (effRegex && typeof effPattern === "string") {
		const regexErr = validateRegexPattern(effPattern);
		if (regexErr) return NextResponse.json({ error: regexErr }, { status: 400 });
	}

	norm.value.updated_at = new Date().toISOString();

	const { data, error } = await auth.sb
		.from("compliance_rules")
		.update(norm.value)
		.eq("id", id)
		.select(COLUMNS)
		.maybeSingle();

	if (error) {
		if (error.code === "23505") return NextResponse.json({ error: "duplicate (law, pattern)" }, { status: 409 });
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
	if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
	return NextResponse.json({ rule: data });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	const auth = await requireUser(["admin"]);
	if ("error" in auth) return auth.error;

	const { id } = await ctx.params;
	if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

	const { error } = await auth.sb.from("compliance_rules").delete().eq("id", id);
	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json({ ok: true });
}
