import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeCategoriesBatch } from "@/lib/discovery/category-normalize";

export interface HistoricalProductNameCount {
	product_name: string | null;
	row_count?: number | null;
}

export interface HistoricalCategoryAssignment {
	productName: string;
	category: string;
	rowCount: number;
	alternatives: string[];
}

export interface HistoricalCategoryBackfillSummary {
	distinctProductNames: number;
	assignableProductNames: number;
	skippedProductNames: number;
	plannedRows: number;
	updatedRows: number;
	apply: boolean;
}

export interface HistoricalCategoryBackfillResult {
	summary: HistoricalCategoryBackfillSummary;
	assignments: HistoricalCategoryAssignment[];
}

function cleanProductName(value: string | null | undefined): string {
	return typeof value === "string" ? value.trim() : "";
}

export function buildHistoricalCategoryAssignments(
	rows: HistoricalProductNameCount[],
	normalized: Map<string, string[]>,
): HistoricalCategoryAssignment[] {
	const out: HistoricalCategoryAssignment[] = [];
	for (const row of rows) {
		const productName = cleanProductName(row.product_name);
		if (!productName) continue;
		const categories = normalized.get(productName) ?? [];
		const category = categories[0]?.trim();
		if (!category) continue;
		out.push({
			productName,
			category,
			rowCount: Math.max(0, Number(row.row_count ?? 1)),
			alternatives: categories.slice(1),
		});
	}
	return out;
}

export function replaceHistoricalAssignmentRowCounts(
	assignments: HistoricalCategoryAssignment[],
	counts: Map<string, number>,
): HistoricalCategoryAssignment[] {
	return assignments.map((assignment) => ({
		...assignment,
		rowCount: Math.max(0, counts.get(assignment.productName) ?? assignment.rowCount),
	}));
}

export function summarizeHistoricalCategoryBackfill(input: {
	distinctProductNames: number;
	assignments: HistoricalCategoryAssignment[];
	updatedRows: number;
	apply: boolean;
}): HistoricalCategoryBackfillSummary {
	const plannedRows = input.assignments.reduce(
		(sum, assignment) => sum + assignment.rowCount,
		0,
	);
	return {
		distinctProductNames: input.distinctProductNames,
		assignableProductNames: input.assignments.length,
		skippedProductNames: Math.max(
			0,
			input.distinctProductNames - input.assignments.length,
		),
		plannedRows,
		updatedRows: input.updatedRows,
		apply: input.apply,
	};
}

export async function loadHistoricalProductNameCounts(
	sb: SupabaseClient,
	rowLimit: number,
): Promise<HistoricalProductNameCount[]> {
	const { data, error } = await sb
		.from("historical_broadcasts")
		.select("product_name")
		.is("category", null)
		.order("air_date", { ascending: false })
		.limit(rowLimit);
	if (error) throw new Error(`historical_broadcasts lookup failed: ${error.message}`);

	const counts = new Map<string, number>();
	for (const row of (data ?? []) as Array<{ product_name: string | null }>) {
		const productName = cleanProductName(row.product_name);
		if (!productName) continue;
		counts.set(productName, (counts.get(productName) ?? 0) + 1);
	}

	return [...counts.entries()].map(([product_name, row_count]) => ({
		product_name,
		row_count,
	}));
}

async function loadExactHistoricalProductNameCounts(
	sb: SupabaseClient,
	productNames: string[],
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	for (const productName of productNames) {
		const { count, error } = await sb
			.from("historical_broadcasts")
			.select("id", { count: "exact", head: true })
			.eq("product_name", productName)
			.is("category", null);
		if (error) {
			throw new Error(
				`historical_broadcasts count failed for ${productName}: ${error.message}`,
			);
		}
		counts.set(productName, count ?? 0);
	}
	return counts;
}

async function applyHistoricalCategoryAssignments(
	sb: SupabaseClient,
	assignments: HistoricalCategoryAssignment[],
): Promise<number> {
	let updatedRows = 0;
	for (const assignment of assignments) {
		const { count, error } = await sb
			.from("historical_broadcasts")
			.update(
				{ category: assignment.category },
				{ count: "exact" },
			)
			.eq("product_name", assignment.productName)
			.is("category", null);
		if (error) {
			throw new Error(
				`historical_broadcasts update failed for ${assignment.productName}: ${error.message}`,
			);
		}
		updatedRows += count ?? 0;
	}
	return updatedRows;
}

export async function backfillHistoricalBroadcastCategories(input: {
	sb: SupabaseClient;
	rowLimit: number;
	maxProductNames: number;
	apply: boolean;
}): Promise<HistoricalCategoryBackfillResult> {
	const rows = (await loadHistoricalProductNameCounts(input.sb, input.rowLimit))
		.sort((a, b) => Number(b.row_count ?? 0) - Number(a.row_count ?? 0))
		.slice(0, input.maxProductNames);
	const productNames = rows
		.map((row) => cleanProductName(row.product_name))
		.filter(Boolean);
	const normalized = await normalizeCategoriesBatch(input.sb, productNames);
	const assignments = buildHistoricalCategoryAssignments(rows, normalized);
	const exactCounts = await loadExactHistoricalProductNameCounts(
		input.sb,
		assignments.map((assignment) => assignment.productName),
	);
	const assignmentsWithExactCounts = replaceHistoricalAssignmentRowCounts(
		assignments,
		exactCounts,
	);
	const updatedRows = input.apply
		? await applyHistoricalCategoryAssignments(input.sb, assignmentsWithExactCounts)
		: 0;

	return {
		assignments: assignmentsWithExactCounts,
		summary: summarizeHistoricalCategoryBackfill({
			distinctProductNames: rows.length,
			assignments: assignmentsWithExactCounts,
			updatedRows,
			apply: input.apply,
		}),
	};
}
