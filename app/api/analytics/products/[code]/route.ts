import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ code: string }> },
) {
	const { code } = await params;
	const { searchParams } = new URL(request.url);
	const yearParam = searchParams.get("year") || "2025,2026";
	const years = yearParam.split(",").map(Number);

	const supabase = getServiceClient();

	const dateFilters = years.map((y) => ({
		start: `${y}-01-01`,
		end: `${y}-12-31`,
	}));

	// Use monthly_summaries for monthly data, sales_weekly only for weekly drill-down
	const [salesResult, monthlyResult, detailResult] = await Promise.all([
		supabase
			.from("sales_weekly")
			.select("week_start, week_end, order_quantity, total_revenue, gross_profit, order_cost, product_name, category")
			.eq("product_code", code)
			.or(dateFilters.map((d) => `and(week_start.gte.${d.start},week_start.lte.${d.end})`).join(","))
			.order("week_start", { ascending: true }),
		supabase
			.from("monthly_summaries")
			.select("*")
			.eq("product_code", code)
			.order("year_month", { ascending: true }),
		supabase
			.from("product_details")
			.select("*")
			.eq("product_code", code)
			.maybeSingle(),
	]);

	if (salesResult.error) {
		return NextResponse.json({ error: salesResult.error.message }, { status: 500 });
	}

	const rows = salesResult.data ?? [];

	if (rows.length === 0) {
		return NextResponse.json({ error: "Product not found" }, { status: 404 });
	}

	const detail = detailResult.data;
	const monthly = (monthlyResult.data ?? []).map((m) => ({
		month: m.year_month,
		revenue: m.revenue,
		quantity: m.quantity,
	}));

	const totalRevenue = rows.reduce((s, r) => s + (r.total_revenue ?? 0), 0);
	const totalProfit = rows.reduce((s, r) => s + (r.gross_profit ?? 0), 0);
	const totalQuantity = rows.reduce((s, r) => s + (r.order_quantity ?? 0), 0);

	return NextResponse.json({
		code,
		name: rows[0].product_name,
		category: rows[0].category,
		summary: {
			totalRevenue,
			totalProfit,
			totalQuantity,
			marginRate: totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 10000) / 100 : 0,
			weekCount: rows.length,
			avgWeeklyQuantity: Math.round(totalQuantity / rows.length),
		},
		weekly: rows.map((r) => ({
			date: r.week_start,
			dateEnd: r.week_end,
			quantity: r.order_quantity,
			revenue: r.total_revenue,
			profit: r.gross_profit,
			cost: r.order_cost,
		})),
		monthly,
		detail: detail ?? null,
	});
}
