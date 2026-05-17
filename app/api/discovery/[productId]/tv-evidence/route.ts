import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";

export async function GET(
	_request: Request,
	context: { params: Promise<{ productId: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { productId } = await context.params;
	if (!productId) {
		return NextResponse.json({ error: "missing productId" }, { status: 400 });
	}

	const { data, error } = await auth.sb
		.from("discovered_products")
		.select("id, tv_evidence, tv_evidence_at")
		.eq("id", productId)
		.maybeSingle();

	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
	if (!data) {
		return NextResponse.json({ error: "not found" }, { status: 404 });
	}
	return NextResponse.json({
		id: data.id,
		tv_evidence: data.tv_evidence,
		tv_evidence_at: data.tv_evidence_at,
	});
}
