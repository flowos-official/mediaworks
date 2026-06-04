import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { normalizeReference } from "@/lib/screenplay/compliance/reference-input";

export const maxDuration = 30;

const COLUMNS =
	"id,law,category_scope,topic,body,keywords,citation,source_url,active,created_at,updated_at";

export async function GET() {
	const auth = await requireUser(["admin"]);
	if ("error" in auth) return auth.error;
	const { data, error } = await auth.sb
		.from("compliance_references")
		.select(COLUMNS)
		.order("law", { ascending: true })
		.order("topic", { ascending: true });
	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json({ references: data ?? [] });
}

export async function POST(req: NextRequest) {
	const auth = await requireUser(["admin"]);
	if ("error" in auth) return auth.error;
	let body: unknown;
	try { body = await req.json(); }
	catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
	const norm = normalizeReference(body, false);
	if (!norm.ok) return NextResponse.json({ error: norm.error }, { status: 400 });
	const { data, error } = await auth.sb
		.from("compliance_references")
		.insert(norm.value)
		.select(COLUMNS)
		.single();
	if (error) {
		if (error.code === "23505") return NextResponse.json({ error: "duplicate (law, topic)" }, { status: 409 });
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
	return NextResponse.json({ reference: data }, { status: 201 });
}
