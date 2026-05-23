import type { SupabaseClient } from "@supabase/supabase-js";

export interface BroadcastCategoryCandidate {
	category: string | null;
}

export interface OperatorFitCategoryRow {
	id: string;
	channel: string;
	product_name: string;
	air_date: string;
	category: string | null;
}

export interface OperatorFitCategoryAssignment {
	id: string;
	category: string;
	productName: string;
	channel: string;
	airDate: string;
}

export function pickCategoryFromBroadcastRows(
	rows: BroadcastCategoryCandidate[],
): string | null {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const category = row.category?.trim();
		if (!category) continue;
		counts.set(category, (counts.get(category) ?? 0) + 1);
	}
	return (
		[...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
		null
	);
}

export async function inferOperatorFitCategory(
	sb: SupabaseClient,
	row: Pick<OperatorFitCategoryRow, "channel" | "product_name" | "air_date">,
): Promise<string | null> {
	const { data, error } = await sb
		.from("broadcasts")
		.select("category")
		.eq("channel", row.channel)
		.eq("air_date", row.air_date)
		.eq("program_title", row.product_name)
		.not("category", "is", null)
		.limit(20);
	if (error) throw new Error(`broadcast category lookup failed: ${error.message}`);
	return pickCategoryFromBroadcastRows(
		(data ?? []) as BroadcastCategoryCandidate[],
	);
}

export async function buildOperatorFitCategoryAssignments(
	sb: SupabaseClient,
	rows: OperatorFitCategoryRow[],
): Promise<OperatorFitCategoryAssignment[]> {
	const assignments: OperatorFitCategoryAssignment[] = [];
	for (const row of rows) {
		if (row.category?.trim()) continue;
		const category = await inferOperatorFitCategory(sb, row);
		if (!category) continue;
		assignments.push({
			id: row.id,
			category,
			productName: row.product_name,
			channel: row.channel,
			airDate: row.air_date,
		});
	}
	return assignments;
}

export async function backfillOperatorFitCategories(input: {
	sb: SupabaseClient;
	limit: number;
	apply: boolean;
}): Promise<{
	totalCandidates: number;
	assignableRows: number;
	updatedRows: number;
	assignments: OperatorFitCategoryAssignment[];
}> {
	const { data, error } = await input.sb
		.from("competitor_fit_analyses")
		.select("id, channel, product_name, air_date, category")
		.is("category", null)
		.order("created_at", { ascending: false })
		.limit(input.limit);
	if (error) throw new Error(`competitor_fit_analyses lookup failed: ${error.message}`);

	const rows = (data ?? []) as OperatorFitCategoryRow[];
	const assignments = await buildOperatorFitCategoryAssignments(input.sb, rows);
	let updatedRows = 0;

	if (input.apply && assignments.length > 0) {
		for (const assignment of assignments) {
			const { count, error: updateError } = await input.sb
				.from("competitor_fit_analyses")
				.update({ category: assignment.category }, { count: "exact" })
				.eq("id", assignment.id)
				.is("category", null);
			if (updateError) {
				throw new Error(
					`competitor_fit_analyses update failed for ${assignment.id}: ${updateError.message}`,
				);
			}
			updatedRows += count ?? 0;
		}
	}

	return {
		totalCandidates: rows.length,
		assignableRows: assignments.length,
		updatedRows,
		assignments,
	};
}
