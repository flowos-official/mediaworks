import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { loadCategoryDistribution } from "@/lib/discovery/category-distribution";
import { getCachedDiscoveryToday } from "@/lib/discovery/cached";
import { hasExcludedChannel } from "@/lib/discovery/tv-channels";

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

			// Merge active_selection onto each product (non-cached query — always fresh)
			const productIds = products.map((p) => (p as { id: string }).id).filter(Boolean);
			if (productIds.length > 0) {
				const sb = getServiceClient();
				const { data: selections } = await sb
					.from("product_selections")
					.select("id, status, discovered_product_id")
					.neq("status", "closed")
					.in("discovered_product_id", productIds);
				if (selections && selections.length > 0) {
					const selMap = new Map<string, { id: string; status: string }>();
					for (const sel of selections) {
						if (sel.discovered_product_id) {
							selMap.set(sel.discovered_product_id, { id: sel.id, status: sel.status });
						}
					}
					products = products.map((p) => {
						const pid = (p as { id: string }).id;
						const sel = selMap.get(pid);
						return sel ? { ...p, active_selection: sel } : p;
					});
				}
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

	let products: Array<Record<string, unknown>> = (prodResult.data ?? []) as Array<Record<string, unknown>>;

	// Excluded-channel (txd) suppression — mirror the cached path so this
	// fallback never surfaces テレ東マート products either.
	products = products.filter(
		(p) => !hasExcludedChannel((p as { tv_channel_source?: string | null }).tv_channel_source ?? null),
	);

	// Merge active_selection onto each product
	const productIds = products.map((p) => p.id as string).filter(Boolean);
	if (productIds.length > 0) {
		const { data: selections } = await sb
			.from("product_selections")
			.select("id, status, discovered_product_id")
			.neq("status", "closed")
			.in("discovered_product_id", productIds);
		if (selections && selections.length > 0) {
			const selMap = new Map<string, { id: string; status: string }>();
			for (const sel of selections) {
				if (sel.discovered_product_id) {
					selMap.set(sel.discovered_product_id, { id: sel.id, status: sel.status });
				}
			}
			products = products.map((p) => {
				const sel = selMap.get(p.id as string);
				return sel ? { ...p, active_selection: sel } : p;
			});
		}
	}

	return NextResponse.json({
		session,
		products,
		categoryStats,
	});
}
