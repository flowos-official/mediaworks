import "server-only";
import {
	unstable_cacheLife as cacheLife,
	unstable_cacheTag as cacheTag,
} from "next/cache";
import { getServiceClient } from "@/lib/supabase";

const ONE_DAY = 60 * 60 * 24;
const SEVEN_DAYS = ONE_DAY * 7;

const SALES_LIFE = { revalidate: ONE_DAY, expire: SEVEN_DAYS };

export interface CachedSalesOverview {
	totalRevenue: number;
	totalCost: number;
	totalProfit: number;
	totalQuantity: number;
	marginRate: number;
	uniqueProducts: number;
	weekCount: number;
	categoryBreakdown: Array<{
		category: string;
		revenue: number;
		quantity: number;
		profit: number;
	}>;
	yearlyKpis: Record<number, { revenue: number; profit: number; quantity: number }>;
	years: number[];
}

export async function getCachedSalesOverview(
	years: number[],
): Promise<CachedSalesOverview> {
	"use cache";
	cacheTag("analytics:sales");
	cacheLife(SALES_LIFE);

	const supabase = getServiceClient();

	const [annualResult, categoryResult] = await Promise.all([
		supabase.from("annual_summaries").select("*").in("year", years),
		supabase.from("category_summaries").select("*").in("year", years),
	]);

	const annuals = annualResult.data ?? [];
	const categories = categoryResult.data ?? [];

	const totalRevenue = annuals.reduce((s, a) => s + (a.total_revenue ?? 0), 0);
	const totalCost = annuals.reduce((s, a) => s + (a.total_cost ?? 0), 0);
	const totalProfit = annuals.reduce((s, a) => s + (a.total_profit ?? 0), 0);
	const totalQuantity = annuals.reduce((s, a) => s + (a.total_quantity ?? 0), 0);
	const weekCount = annuals.reduce((s, a) => s + (a.week_count ?? 0), 0);
	const marginRate = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

	const uniqueProducts =
		new Set(annuals.map((a) => a.product_count)).size > 0
			? Math.max(...annuals.map((a) => a.product_count ?? 0))
			: 0;

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

	const yearlyKpis: Record<number, { revenue: number; profit: number; quantity: number }> = {};
	for (const a of annuals) {
		yearlyKpis[a.year] = {
			revenue: a.total_revenue ?? 0,
			profit: a.total_profit ?? 0,
			quantity: a.total_quantity ?? 0,
		};
	}

	return {
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
	};
}

export interface CachedSalesTrends {
	period: "weekly" | "monthly";
	trends: Array<Record<string, unknown>>;
}

export async function getCachedSalesTrends(
	years: number[],
	period: "weekly" | "monthly",
): Promise<CachedSalesTrends> {
	"use cache";
	cacheTag("analytics:sales");
	cacheLife(SALES_LIFE);

	const supabase = getServiceClient();

	const dateFilters = years.map((y) => ({
		start: `${y}-01-01`,
		end: `${y}-12-31`,
	}));

	const { data } = await supabase
		.from("sales_weekly_totals")
		.select("*")
		.or(dateFilters.map((d) => `and(week_start.gte.${d.start},week_start.lte.${d.end})`).join(","))
		.order("week_start", { ascending: true });

	const rows = data ?? [];

	if (period === "monthly") {
		const monthMap: Record<
			string,
			{ revenue: number; profit: number; quantity: number; cost: number; weeks: number }
		> = {};
		for (const row of rows) {
			const month = row.week_start.slice(0, 7);
			if (!monthMap[month])
				monthMap[month] = { revenue: 0, profit: 0, quantity: 0, cost: 0, weeks: 0 };
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
				marginRate:
					d.revenue > 0 ? Math.round((d.profit / d.revenue) * 10000) / 100 : 0,
			}))
			.sort((a, b) => (a.date as string).localeCompare(b.date as string));
		return { period: "monthly", trends };
	}

	const trends = rows.map((row) => ({
		date: row.week_start,
		dateEnd: row.week_end,
		revenue: row.total_revenue,
		profit: row.total_gross_profit,
		quantity: row.total_quantity,
		cost: row.total_cost,
		marginRate:
			row.total_revenue > 0
				? Math.round((row.total_gross_profit / row.total_revenue) * 10000) / 100
				: 0,
	}));

	return { period: "weekly", trends };
}

export interface CachedSalesProduct {
	code: string;
	name: string;
	category: string | null;
	totalRevenue: number;
	totalCost: number;
	totalProfit: number;
	totalQuantity: number;
	weekCount: number;
	marginRate: number;
	avgWeeklyQuantity: number;
	avgWeeklyRevenue: number;
	firstDate: string | null;
	lastDate: string | null;
}

export interface CachedSalesProducts {
	products: CachedSalesProduct[];
	total: number;
}

/**
 * Returns the UNMASKED product list. The caller (route handler) is responsible
 * for masking cost/profit/marginRate to null when auth.role === 'viewer'.
 */
export async function getCachedSalesProducts(
	years: number[],
	sort: string,
	limit: number,
	category: string | null,
): Promise<CachedSalesProducts> {
	"use cache";
	cacheTag("analytics:sales");
	cacheLife(SALES_LIFE);

	const supabase = getServiceClient();

	let query = supabase.from("product_summaries").select("*").in("year", years);
	if (category) query = query.eq("category", category);

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

	const productMap: Record<
		string,
		{
			code: string;
			name: string;
			category: string | null;
			totalRevenue: number;
			totalCost: number;
			totalProfit: number;
			totalQuantity: number;
			weekCount: number;
		}
	> = {};

	for (const row of summaryResult.data ?? []) {
		const key = row.product_code;
		if (!productMap[key]) {
			productMap[key] = {
				code: row.product_code,
				name: row.product_name,
				category: row.category,
				totalRevenue: 0,
				totalCost: 0,
				totalProfit: 0,
				totalQuantity: 0,
				weekCount: 0,
			};
		}
		productMap[key].totalRevenue += row.total_revenue ?? 0;
		productMap[key].totalCost += row.total_cost ?? 0;
		productMap[key].totalProfit += row.total_profit ?? 0;
		productMap[key].totalQuantity += row.total_quantity ?? 0;
		productMap[key].weekCount += row.week_count ?? 0;
	}

	let products: CachedSalesProduct[] = Object.values(productMap).map((p) => ({
		...p,
		marginRate:
			p.totalRevenue > 0 ? Math.round((p.totalProfit / p.totalRevenue) * 10000) / 100 : 0,
		avgWeeklyQuantity: p.weekCount > 0 ? Math.round(p.totalQuantity / p.weekCount) : 0,
		avgWeeklyRevenue: p.weekCount > 0 ? Math.round(p.totalRevenue / p.weekCount) : 0,
		firstDate: dateMap[p.code]?.firstDate ?? null,
		lastDate: dateMap[p.code]?.lastDate ?? null,
	}));

	switch (sort) {
		case "quantity":
			products.sort((a, b) => b.totalQuantity - a.totalQuantity);
			break;
		case "margin":
			products.sort((a, b) => b.marginRate - a.marginRate);
			break;
		default:
			products.sort((a, b) => b.totalRevenue - a.totalRevenue);
	}

	products = products.slice(0, limit);

	return { products, total: Object.keys(productMap).length };
}
