import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { loadCategoryDistribution } from "@/lib/discovery/category-distribution";
import { getCachedDiscoveryToday } from "@/lib/discovery/cached";

export const dynamic = "force-dynamic";

/**
 * Return the most recent completed or partial session + its products.
 * Query params:
 *   - context: home_shopping | live_commerce (cached path); other/missing → uncached fallback
 *   - status: filter discovered_products.user_action (sourced|interested|rejected|duplicate)
 *   - track: filter by tv_proven|exploration
 */
export async function GET(req: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { searchParams } = new URL(req.url);
	const contextFilter = searchParams.get("context");
	const statusFilter = searchParams.get("status");
	const trackFilter = searchParams.get("track");

	if (contextFilter === "home_shopping" || contextFilter === "live_commerce") {
		try {
			const cached = await getCachedDiscoveryToday(contextFilter);
			if (!cached.session) {
				return NextResponse.json({ session: null, products: [] });
			}
			let products = cached.products;
			if (statusFilter === "uncategorized") {
				products = products.filter((p) => !(p as { user_action?: string }).user_action);
			} else if (statusFilter) {
				products = products.filter(
					(p) => (p as { user_action?: string }).user_action === statusFilter,
				);
			}
			if (trackFilter) {
				products = products.filter((p) => (p as { track?: string }).track === trackFilter);
			}
			return NextResponse.json({
				session: cached.session,
				products,
				categoryStats: cached.categoryStats,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return NextResponse.json({ error: message }, { status: 500 });
		}
	}

	// Uncached fallback: caller did not specify a known context. Preserves the
	// pre-caching behaviour for any callers that omit `context`.
	const sb = getServiceClient();
	const { data: session, error: sessErr } = await sb
		.from("discovery_runs")
		.select("*")
		.in("status", ["completed", "partial"])
		.order("run_at", { ascending: false })
		.limit(1)
		.maybeSingle();

	if (sessErr) return NextResponse.json({ error: sessErr.message }, { status: 500 });
	if (!session) return NextResponse.json({ session: null, products: [] });

	let q = sb
		.from("discovered_products")
		.select("*")
		.eq("session_id", session.id)
		.order("tv_tier", { ascending: true })
		.order("tv_fit_score", { ascending: false });

	if (statusFilter === "uncategorized") q = q.is("user_action", null);
	else if (statusFilter) q = q.eq("user_action", statusFilter);
	if (trackFilter) q = q.eq("track", trackFilter);

	const [prodResult, categoryStats] = await Promise.all([q, loadCategoryDistribution()]);
	if (prodResult.error)
		return NextResponse.json({ error: prodResult.error.message }, { status: 500 });

	return NextResponse.json({
		session,
		products: prodResult.data ?? [],
		categoryStats,
	});
}
