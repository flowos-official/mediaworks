import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export async function GET(request: NextRequest) {
	const { searchParams } = new URL(request.url);
	const yearParam = searchParams.get("year") || "2025,2026";
	const years = yearParam.split(",").map(Number);

	if (years.length === 0 || years.some((y) => isNaN(y) || y < 2000 || y > 2100)) {
		return NextResponse.json({ error: "Invalid year parameter" }, { status: 400 });
	}

	const supabase = getServiceClient();

	const [annualResult, categoryResult] = await Promise.all([
		supabase
			.from("annual_summaries")
			.select("*")
			.in("year", years),
		supabase
			.from("category_summaries")
			.select("*")
			.in("year", years),
	]);

	if (annualResult.error || categoryResult.error) {
		return NextResponse.json(
			{ error: annualResult.error?.message || categoryResult.error?.message },
			{ status: 500 },
		);
	}

	const annuals = annualResult.data ?? [];
	const categories = categoryResult.data ?? [];

	// Aggregate across years
	const totalRevenue = annuals.reduce((s, a) => s + (a.total_revenue ?? 0), 0);
	const totalCost = annuals.reduce((s, a) => s + (a.total_cost ?? 0), 0);
	const totalProfit = annuals.reduce((s, a) => s + (a.total_profit ?? 0), 0);
	const totalQuantity = annuals.reduce((s, a) => s + (a.total_quantity ?? 0), 0);
	const weekCount = annuals.reduce((s, a) => s + (a.week_count ?? 0), 0);
	const marginRate = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

	// Unique products across years
	const uniqueProducts = new Set(annuals.map((a) => a.product_count)).size > 0
		? Math.max(...annuals.map((a) => a.product_count ?? 0))
		: 0;

	// Category breakdown (merge across years)
	const catMap: Record<string, { revenue: number; quantity: number; profit: number }> = {};
	for (const c of categories) {
		const cat = c.category;
		if (!catMap[cat]) catMap[cat] = { revenue: 0, quantity: 0, profit: 0 };
		catMap[cat].revenue += c.total_revenue ?? 0;
		catMap[cat].quantity += c.total_quantity ?? 0;
		catMap[cat].profit += c.total_profit ?? 0;
	}

	const categoryBreakdown = Object.entries(catMap)
		.map(([category, data]) => ({ category, ...data }))
		.sort((a, b) => b.revenue - a.revenue);

	// Year-over-year KPIs
	const yearlyKpis: Record<number, { revenue: number; profit: number; quantity: number }> = {};
	for (const a of annuals) {
		yearlyKpis[a.year] = {
			revenue: a.total_revenue ?? 0,
			profit: a.total_profit ?? 0,
			quantity: a.total_quantity ?? 0,
		};
	}

	return NextResponse.json({
		totalRevenue,
		totalCost,
		totalProfit,
		totalQuantity,
		marginRate: Math.round(marginRate * 100) / 100,
		uniqueProducts,
		weekCount,
		categoryBreakdown,
		yearlyKpis,
		years,
	});
}
