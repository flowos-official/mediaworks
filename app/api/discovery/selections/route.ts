import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
	const sb = getServiceClient();
	const { searchParams } = new URL(req.url);
	const status = searchParams.get("status");
	const context = searchParams.get("context");
	const days = Math.min(Number(searchParams.get("days") ?? 30), 365);
	const page = Math.max(Number(searchParams.get("page") ?? 0), 0);
	const limit = Math.min(Number(searchParams.get("limit") ?? 20), 100);

	const fromDate = new Date();
	fromDate.setUTCDate(fromDate.getUTCDate() - days);

	let query = sb
		.from("discovered_products")
		.select("*", { count: "exact" })
		.gte("action_at", fromDate.toISOString())
		.order("action_at", { ascending: false });

	if (status && ["sourced", "interested", "rejected", "duplicate"].includes(status)) {
		query = query.eq("user_action", status);
	} else {
		query = query.not("user_action", "is", null);
	}

	if (context === "home_shopping" || context === "live_commerce") {
		query = query.eq("context", context);
	}

	const { data, error, count } = await query.range(page * limit, page * limit + limit - 1);
	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}

	return NextResponse.json({
		products: data ?? [],
		total: count ?? 0,
		page,
		limit,
	});
}
