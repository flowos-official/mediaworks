import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export async function GET(request: NextRequest) {
	const { searchParams } = new URL(request.url);
	const yearParam = searchParams.get("year") || "2025,2026";
	const period = searchParams.get("period") || "weekly"; // weekly | monthly
	const years = yearParam.split(",").map(Number);

	if (years.length === 0 || years.some((y) => isNaN(y) || y < 2000 || y > 2100)) {
		return NextResponse.json({ error: "Invalid year parameter" }, { status: 400 });
	}

	const supabase = getServiceClient();

	const dateFilters = years.map((y) => ({
		start: `${y}-01-01`,
		end: `${y}-12-31`,
	}));

	const { data, error } = await supabase
		.from("sales_weekly_totals")
		.select("*")
		.or(dateFilters.map((d) => `and(week_start.gte.${d.start},week_start.lte.${d.end})`).join(","))
		.order("week_start", { ascending: true });

	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}

	const rows = data ?? [];

	if (period === "monthly") {
		// Aggregate by month
		const monthMap: Record<string, { revenue: number; profit: number; quantity: number; cost: number; weeks: number }> = {};
		for (const row of rows) {
			const month = row.week_start.slice(0, 7); // YYYY-MM
			if (!monthMap[month]) monthMap[month] = { revenue: 0, profit: 0, quantity: 0, cost: 0, weeks: 0 };
			monthMap[month].revenue += row.total_revenue ?? 0;
			monthMap[month].profit += row.total_gross_profit ?? 0;
			monthMap[month].quantity += row.total_quantity ?? 0;
			monthMap[month].cost += row.total_cost ?? 0;
			monthMap[month].weeks += 1;
		}

		const trends = Object.entries(monthMap)
			.map(([month, d]) => ({
				date: month,
				revenue: d.revenue,
				profit: d.profit,
				quantity: d.quantity,
				cost: d.cost,
				marginRate: d.revenue > 0 ? Math.round((d.profit / d.revenue) * 10000) / 100 : 0,
			}))
			.sort((a, b) => a.date.localeCompare(b.date));

		return NextResponse.json({ period: "monthly", trends });
	}

	// Weekly
	const trends = rows.map((row) => ({
		date: row.week_start,
		dateEnd: row.week_end,
		revenue: row.total_revenue,
		profit: row.total_gross_profit,
		quantity: row.total_quantity,
		cost: row.total_cost,
		marginRate: row.total_revenue > 0
			? Math.round((row.total_gross_profit / row.total_revenue) * 10000) / 100
			: 0,
	}));

	return NextResponse.json({ period: "weekly", trends });
}
