import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(
	_req: NextRequest,
	ctx: { params: Promise<{ id: string }> },
) {
	const { id } = await ctx.params;
	const sb = getServiceClient();

	const [sessionRes, productsRes] = await Promise.all([
		sb.from("discovery_runs").select("*").eq("id", id).maybeSingle(),
		sb
			.from("discovered_products")
			.select("*")
			.eq("session_id", id)
			.order("tv_fit_score", { ascending: false }),
	]);

	if (sessionRes.error) {
		return NextResponse.json({ error: sessionRes.error.message }, { status: 500 });
	}
	if (!sessionRes.data) {
		return NextResponse.json({ error: "session not found" }, { status: 404 });
	}
	if (productsRes.error) {
		return NextResponse.json({ error: productsRes.error.message }, { status: 500 });
	}

	return NextResponse.json({
		session: sessionRes.data,
		products: productsRes.data ?? [],
	});
}
