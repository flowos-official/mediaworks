import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export async function GET(request: NextRequest) {
	const { searchParams } = new URL(request.url);
	const yearParam = searchParams.get("year") || "2025,2026";
	const sortBy = searchParams.get("sort") || "revenue";
	const limitParam = parseInt(searchParams.get("limit") || "20");
	const categoryFilter = searchParams.get("category");
	const years = yearParam.split(",").map(Number);

	if (years.length === 0 || years.some((y) => isNaN(y) || y < 2000 || y > 2100)) {
		return NextResponse.json({ error: "Invalid year parameter" }, { status: 400 });
	}

	const supabase = getServiceClient();

	let query = supabase
		.from("product_summaries")
		.select("*")
		.in("year", years);

	if (categoryFilter) {
		query = query.eq("category", categoryFilter);
	}

	// Fetch date ranges in parallel
	const dateFilters = years.map((y) => ({
		start: `${y}-01-01`,
		end: `${y}-12-31`,
	}));

	const [summaryResult, dateResult] = await Promise.all([
		query,
		supabase
			.from("sales_weekly")
			.select("product_code, week_start")
			.or(dateFilters.map((d) => `and(week_start.gte.${d.start},week_start.lte.${d.end})`).join(","))
			.order("week_start", { ascending: true }),
	]);

	const { data, error } = summaryResult;

	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}

	// Build date range map per product
	const dateMap: Record<string, { firstDate: string; lastDate: string }> = {};
	for (const row of dateResult.data ?? []) {
		const code = row.product_code;
		const d = row.week_start;
		if (!dateMap[code]) {
			dateMap[code] = { firstDate: d, lastDate: d };
		} else {
			if (d < dateMap[code].firstDate) dateMap[code].firstDate = d;
			if (d > dateMap[code].lastDate) dateMap[code].lastDate = d;
		}
	}

	// Merge across years for same product
	const productMap: Record<string, {
		code: string; name: string; category: string | null;
		totalRevenue: number; totalCost: number; totalProfit: number;
		totalQuantity: number; weekCount: number;
	}> = {};

	for (const row of data ?? []) {
		const key = row.product_code;
		if (!productMap[key]) {
			productMap[key] = {
				code: row.product_code,
				name: row.product_name,
				category: row.category,
				totalRevenue: 0, totalCost: 0, totalProfit: 0,
				totalQuantity: 0, weekCount: 0,
			};
		}
		productMap[key].totalRevenue += row.total_revenue ?? 0;
		productMap[key].totalCost += row.total_cost ?? 0;
		productMap[key].totalProfit += row.total_profit ?? 0;
		productMap[key].totalQuantity += row.total_quantity ?? 0;
		productMap[key].weekCount += row.week_count ?? 0;
	}

	let products = Object.values(productMap).map((p) => ({
		...p,
		marginRate: p.totalRevenue > 0
			? Math.round((p.totalProfit / p.totalRevenue) * 10000) / 100
			: 0,
		avgWeeklyQuantity: p.weekCount > 0 ? Math.round(p.totalQuantity / p.weekCount) : 0,
		avgWeeklyRevenue: p.weekCount > 0 ? Math.round(p.totalRevenue / p.weekCount) : 0,
		firstDate: dateMap[p.code]?.firstDate ?? null,
		lastDate: dateMap[p.code]?.lastDate ?? null,
	}));

	switch (sortBy) {
		case "quantity":
			products.sort((a, b) => b.totalQuantity - a.totalQuantity);
			break;
		case "margin":
			products.sort((a, b) => b.marginRate - a.marginRate);
			break;
		default:
			products.sort((a, b) => b.totalRevenue - a.totalRevenue);
	}

	products = products.slice(0, limitParam);

	return NextResponse.json({ products, total: Object.keys(productMap).length });
}
