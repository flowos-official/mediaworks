/**
 * Compute summary tables from sales_weekly raw data.
 * Run after import-sales.ts or independently.
 *
 * Usage: npx tsx scripts/compute-summaries.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

function loadEnv() {
	const candidates = [".env.local", ".env"];
	const envPath = candidates
		.map((f) => path.resolve(process.cwd(), f))
		.find((p) => fs.existsSync(p));
	if (!envPath) {
		console.error("ERROR: No .env found.");
		process.exit(1);
	}
	const content = fs.readFileSync(envPath, "utf-8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		const val = trimmed.slice(eqIdx + 1).trim();
		if (!process.env[key]) process.env[key] = val;
	}
}

loadEnv();

const supabase = createClient(
	process.env.NEXT_PUBLIC_SUPABASE_URL!,
	process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
	console.log("=== Compute Summaries ===\n");

	// Step 1: Fetch all sales_weekly data (one-time full scan)
	console.log("Fetching sales_weekly...");
	const allRows: Array<Record<string, unknown>> = [];
	let offset = 0;
	const PAGE = 1000;

	while (true) {
		const { data, error } = await supabase
			.from("sales_weekly")
			.select("product_code, product_name, category, order_quantity, total_revenue, order_cost, gross_profit, week_start")
			.range(offset, offset + PAGE - 1);

		if (error) {
			console.error("Fetch error:", error.message);
			process.exit(1);
		}
		if (!data || data.length === 0) break;
		allRows.push(...data);
		offset += PAGE;
		if (data.length < PAGE) break;
	}

	console.log(`  Fetched ${allRows.length} rows`);

	// Fetch totals for week_count per year
	const { data: totalsData } = await supabase
		.from("sales_weekly_totals")
		.select("week_start, total_revenue, total_cost, total_gross_profit, total_quantity");

	const weeklyTotals = totalsData ?? [];

	// Step 2: Compute all 4 summaries in memory

	// --- product_summaries ---
	const productMap: Record<string, {
		code: string; name: string; category: string | null; year: number;
		qty: number; rev: number; cost: number; profit: number; weeks: number;
	}> = {};

	// --- category_summaries ---
	const categoryMap: Record<string, {
		category: string; year: number;
		qty: number; rev: number; profit: number; products: Set<string>;
	}> = {};

	// --- monthly_summaries ---
	const monthlyMap: Record<string, {
		code: string; yearMonth: string; qty: number; rev: number; profit: number;
	}> = {};

	// --- annual_summaries ---
	const annualMap: Record<number, {
		qty: number; rev: number; cost: number; profit: number;
		weeks: number; products: Set<string>;
	}> = {};

	for (const row of allRows) {
		const code = row.product_code as string;
		const name = row.product_name as string;
		const cat = (row.category as string) || "その他";
		const year = new Date(row.week_start as string).getFullYear();
		const yearMonth = (row.week_start as string).slice(0, 7);
		const qty = (row.order_quantity as number) ?? 0;
		const rev = (row.total_revenue as number) ?? 0;
		const cost = (row.order_cost as number) ?? 0;
		const profit = (row.gross_profit as number) ?? 0;

		// Product summary
		const pKey = `${code}:${year}`;
		if (!productMap[pKey]) {
			productMap[pKey] = { code, name, category: cat, year, qty: 0, rev: 0, cost: 0, profit: 0, weeks: 0 };
		}
		productMap[pKey].qty += qty;
		productMap[pKey].rev += rev;
		productMap[pKey].cost += cost;
		productMap[pKey].profit += profit;
		productMap[pKey].weeks += 1;

		// Category summary
		const cKey = `${cat}:${year}`;
		if (!categoryMap[cKey]) {
			categoryMap[cKey] = { category: cat, year, qty: 0, rev: 0, profit: 0, products: new Set() };
		}
		categoryMap[cKey].qty += qty;
		categoryMap[cKey].rev += rev;
		categoryMap[cKey].profit += profit;
		categoryMap[cKey].products.add(code);

		// Monthly summary
		const mKey = `${code}:${yearMonth}`;
		if (!monthlyMap[mKey]) {
			monthlyMap[mKey] = { code, yearMonth, qty: 0, rev: 0, profit: 0 };
		}
		monthlyMap[mKey].qty += qty;
		monthlyMap[mKey].rev += rev;
		monthlyMap[mKey].profit += profit;

		// Annual (from raw rows for product count)
		if (!annualMap[year]) {
			annualMap[year] = { qty: 0, rev: 0, cost: 0, profit: 0, weeks: 0, products: new Set() };
		}
		annualMap[year].products.add(code);
	}

	// Build annual from weekly totals
	for (const t of weeklyTotals) {
		const year = new Date(t.week_start as string).getFullYear();
		if (!annualMap[year]) {
			annualMap[year] = { qty: 0, rev: 0, cost: 0, profit: 0, weeks: 0, products: new Set() };
		}
		annualMap[year].qty += (t.total_quantity as number) ?? 0;
		annualMap[year].rev += (t.total_revenue as number) ?? 0;
		annualMap[year].cost += (t.total_cost as number) ?? 0;
		annualMap[year].profit += (t.total_gross_profit as number) ?? 0;
		annualMap[year].weeks += 1;
	}

	// Step 3: Upsert all summaries

	// product_summaries
	const productRows = Object.values(productMap).map((p) => ({
		product_code: p.code,
		product_name: p.name,
		category: p.category,
		year: p.year,
		total_quantity: p.qty,
		total_revenue: Math.round(p.rev),
		total_cost: Math.round(p.cost),
		total_profit: Math.round(p.profit),
		week_count: p.weeks,
		avg_weekly_qty: p.weeks > 0 ? Math.round(p.qty / p.weeks) : 0,
		margin_rate: p.rev > 0 ? Math.round((p.profit / p.rev) * 10000) / 100 : 0,
	}));

	console.log(`\nUpserting product_summaries (${productRows.length} rows)...`);
	for (let i = 0; i < productRows.length; i += 100) {
		const { error } = await supabase
			.from("product_summaries")
			.upsert(productRows.slice(i, i + 100), { onConflict: "product_code,year" });
		if (error) console.error("  product_summaries error:", error.message);
	}

	// category_summaries
	const categoryRows = Object.values(categoryMap).map((c) => ({
		category: c.category,
		year: c.year,
		total_quantity: c.qty,
		total_revenue: Math.round(c.rev),
		total_profit: Math.round(c.profit),
		product_count: c.products.size,
		margin_rate: c.rev > 0 ? Math.round((c.profit / c.rev) * 10000) / 100 : 0,
	}));

	console.log(`Upserting category_summaries (${categoryRows.length} rows)...`);
	const { error: catErr } = await supabase
		.from("category_summaries")
		.upsert(categoryRows, { onConflict: "category,year" });
	if (catErr) console.error("  category_summaries error:", catErr.message);

	// monthly_summaries
	const monthlyRows = Object.values(monthlyMap).map((m) => ({
		product_code: m.code,
		year_month: m.yearMonth,
		quantity: m.qty,
		revenue: Math.round(m.rev),
		profit: Math.round(m.profit),
	}));

	console.log(`Upserting monthly_summaries (${monthlyRows.length} rows)...`);
	for (let i = 0; i < monthlyRows.length; i += 100) {
		const { error } = await supabase
			.from("monthly_summaries")
			.upsert(monthlyRows.slice(i, i + 100), { onConflict: "product_code,year_month" });
		if (error) console.error("  monthly_summaries error:", error.message);
	}

	// annual_summaries
	const annualRows = Object.entries(annualMap).map(([yearStr, a]) => ({
		year: parseInt(yearStr),
		total_quantity: a.qty,
		total_revenue: Math.round(a.rev),
		total_cost: Math.round(a.cost),
		total_profit: Math.round(a.profit),
		week_count: a.weeks,
		product_count: a.products.size,
		margin_rate: a.rev > 0 ? Math.round((a.profit / a.rev) * 10000) / 100 : 0,
	}));

	console.log(`Upserting annual_summaries (${annualRows.length} rows)...`);
	const { error: annErr } = await supabase
		.from("annual_summaries")
		.upsert(annualRows, { onConflict: "year" });
	if (annErr) console.error("  annual_summaries error:", annErr.message);

	console.log("\n=== Summary ===");
	console.log(`  product_summaries: ${productRows.length} rows`);
	console.log(`  category_summaries: ${categoryRows.length} rows`);
	console.log(`  monthly_summaries: ${monthlyRows.length} rows`);
	console.log(`  annual_summaries: ${annualRows.length} rows`);
	console.log("\nDone!");
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
