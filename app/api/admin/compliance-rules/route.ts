import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { normalizeRule } from "@/lib/screenplay/compliance/rule-input";

export const maxDuration = 30;

const COLUMNS =
	"id,law,category_scope,pattern,is_regex,allowed,severity,reason,safe_rewrite,citation,active,created_at,updated_at";

export async function GET() {
	const auth = await requireUser(["admin"]);
	if ("error" in auth) return auth.error;

	const { data, error } = await auth.sb
		.from("compliance_rules")
		.select(COLUMNS)
		.order("law", { ascending: true })
		.order("allowed", { ascending: true })
		.order("created_at", { ascending: true });

	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json({ rules: data ?? [] });
}

export async function POST(req: NextRequest) {
	const auth = await requireUser(["admin"]);
	if ("error" in auth) return auth.error;

	let body: unknown;
	try { body = await req.json(); }
	catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

	const norm = normalizeRule(body, false);
	if (!norm.ok) return NextResponse.json({ error: norm.error }, { status: 400 });

	const { data, error } = await auth.sb
		.from("compliance_rules")
		.insert(norm.value)
		.select(COLUMNS)
		.single();

	if (error) {
		// 23505 = unique_violation on (law, pattern)
		if (error.code === "23505") return NextResponse.json({ error: "duplicate (law, pattern)" }, { status: 409 });
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
	return NextResponse.json({ rule: data }, { status: 201 });
}
