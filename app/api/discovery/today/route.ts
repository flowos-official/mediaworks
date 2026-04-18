import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * Return the most recent completed or partial session + its products.
 * Query params:
 *   - status: filter discovered_products.user_action (sourced|interested|rejected|duplicate)
 *   - track: filter by tv_proven|exploration
 */
export async function GET(req: NextRequest) {
	const sb = getServiceClient();
	const { searchParams } = new URL(req.url);

	const contextFilter = searchParams.get("context");
	let sessQuery = sb
		.from("discovery_runs")
		.select("*")
		.in("status", ["completed", "partial"])
		.order("run_at", { ascending: false })
		.limit(1);
	if (contextFilter === "home_shopping" || contextFilter === "live_commerce") {
		sessQuery = sessQuery.eq("context", contextFilter);
	}
	const { data: session, error: sessErr } = await sessQuery.maybeSingle();

	if (sessErr) {
		return NextResponse.json({ error: sessErr.message }, { status: 500 });
	}
	if (!session) {
		return NextResponse.json({ session: null, products: [] });
	}

	let q = sb
		.from("discovered_products")
		.select("*")
		.eq("session_id", session.id)
		.order("tv_fit_score", { ascending: false });

	const statusFilter = searchParams.get("status");
	if (statusFilter) {
		if (statusFilter === "uncategorized") {
			q = q.is("user_action", null);
		} else {
			q = q.eq("user_action", statusFilter);
		}
	}

	const trackFilter = searchParams.get("track");
	if (trackFilter) {
		q = q.eq("track", trackFilter);
	}

	const { data: products, error: prodErr } = await q;
	if (prodErr) {
		return NextResponse.json({ error: prodErr.message }, { status: 500 });
	}

	return NextResponse.json({ session, products: products ?? [] });
}
