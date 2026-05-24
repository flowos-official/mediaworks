import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getCachedSalesProducts } from "@/lib/analytics/cached";

export async function GET(request: NextRequest) {
	const auth = await requireUser(["admin", "member", "viewer"]);
	if ("error" in auth) return auth.error;

	const { searchParams } = new URL(request.url);
	const yearParam = searchParams.get("year") || "2025,2026";
	const sortBy = searchParams.get("sort") || "revenue";
	const limitParam = parseInt(searchParams.get("limit") || "20");
	const categoryFilter = searchParams.get("category");
	const years = yearParam.split(",").map(Number);

	if (years.length === 0 || years.some((y) => isNaN(y) || y < 2000 || y > 2100)) {
		return NextResponse.json({ error: "Invalid year parameter" }, { status: 400 });
	}

	const isViewer = auth.role === "viewer";
	// For viewer, "margin" sort would be incoherent (they can't see margin).
	// Fall back to "revenue" before hitting the cache so we share its entry.
	const effectiveSort = isViewer && sortBy === "margin" ? "revenue" : sortBy;

	try {
		const { products: rawProducts, total } = await getCachedSalesProducts(
			years,
			effectiveSort,
			limitParam,
			categoryFilter,
		);

		const products = isViewer
			? rawProducts.map((p) => ({
					...p,
					totalCost: null as unknown as number,
					totalProfit: null as unknown as number,
					marginRate: null as unknown as number,
				}))
			: rawProducts;

		return NextResponse.json({ products, total, viewer: isViewer });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
