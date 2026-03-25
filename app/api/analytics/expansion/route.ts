import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { analyzeExpansionStrategy } from "@/lib/gemini";

export const maxDuration = 120;

export async function POST(request: NextRequest) {
	const body = await request.json().catch(() => ({}));
	const userGoal: string = body.userGoal || "";

	const supabase = getServiceClient();

	// Fetch from pre-computed summary tables (no raw sales_weekly scan)
	const [productResult, categoryResult, annualResult] = await Promise.all([
		supabase
			.from("product_summaries")
			.select("*")
			.in("year", [2025, 2026])
			.order("total_revenue", { ascending: false }),
		supabase
			.from("category_summaries")
			.select("*")
			.in("year", [2025, 2026]),
		supabase
			.from("annual_summaries")
			.select("*")
			.in("year", [2025, 2026]),
	]);

	if (productResult.error || categoryResult.error || annualResult.error) {
		return NextResponse.json(
			{ error: productResult.error?.message || categoryResult.error?.message || annualResult.error?.message },
			{ status: 500 },
		);
	}

	// Merge product summaries across years and pick top 15
	const productMap: Record<string, {
		code: string; name: string; category: string | null;
		totalRevenue: number; totalProfit: number; totalQuantity: number;
		weekCount: number;
	}> = {};

	for (const row of productResult.data ?? []) {
		const key = row.product_code;
		if (!productMap[key]) {
			productMap[key] = {
				code: row.product_code,
				name: row.product_name,
				category: row.category,
				totalRevenue: 0, totalProfit: 0, totalQuantity: 0, weekCount: 0,
			};
		}
		productMap[key].totalRevenue += row.total_revenue ?? 0;
		productMap[key].totalProfit += row.total_profit ?? 0;
		productMap[key].totalQuantity += row.total_quantity ?? 0;
		productMap[key].weekCount += row.week_count ?? 0;
	}

	const topProducts = Object.values(productMap)
		.map((p) => ({
			...p,
			marginRate: p.totalRevenue > 0 ? Math.round((p.totalProfit / p.totalRevenue) * 10000) / 100 : 0,
			avgWeeklyQty: p.weekCount > 0 ? Math.round(p.totalQuantity / p.weekCount) : 0,
		}))
		.sort((a, b) => b.totalRevenue - a.totalRevenue)
		.slice(0, 15);

	// Merge category summaries across years
	const categorySummary: Record<string, { revenue: number; quantity: number }> = {};
	for (const c of categoryResult.data ?? []) {
		const cat = c.category;
		if (!categorySummary[cat]) categorySummary[cat] = { revenue: 0, quantity: 0 };
		categorySummary[cat].revenue += c.total_revenue ?? 0;
		categorySummary[cat].quantity += c.total_quantity ?? 0;
	}

	// Annual totals
	const annuals = annualResult.data ?? [];
	const totalRevenue = annuals.reduce((s, a) => s + (a.total_revenue ?? 0), 0);
	const totalProfit = annuals.reduce((s, a) => s + (a.total_profit ?? 0), 0);
	const weekCount = annuals.reduce((s, a) => s + (a.week_count ?? 0), 0);

	try {
		const analysis = await analyzeExpansionStrategy({
			topProducts,
			categorySummary,
			overallRevenue: totalRevenue,
			overallProfit: totalProfit,
			overallMarginRate: totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 10000) / 100 : 0,
			weekCount,
			userGoal: userGoal || undefined,
		});

		return NextResponse.json({
			analysis,
			topProducts,
			categorySummary,
			generatedAt: new Date().toISOString(),
		});
	} catch (err) {
		return NextResponse.json(
			{ error: err instanceof Error ? err.message : "AI analysis failed" },
			{ status: 500 },
		);
	}
}
