/**
 * PostgREST answers an unbounded select with at most 1000 rows and reports no
 * error, so a query that outgrows that silently starts computing on a slice of
 * the data. That has bitten this codebase repeatedly — exclusion lists missing
 * two thirds of their known product codes, category weights derived from half
 * the calendar, an admin dashboard totalling 1000 of 6000 rows.
 *
 * Use this wherever a select can legitimately return more than a page.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */

export interface PageRange {
	from: number;
	to: number;
}

interface PageResult<T> {
	data: T[] | null;
	error: { message: string } | null;
}

export const SUPABASE_PAGE_SIZE = 1000;

/**
 * Read every row a query matches, one page at a time.
 *
 * The builder must apply a stable `.order()` — without a deterministic sort,
 * successive ranges can repeat or skip rows.
 *
 * @param build   Runs one page; receives the row range to request.
 * @param options `pageSize` matches PostgREST's cap by default. `maxRows`
 *                stops runaway reads; hitting it throws rather than returning a
 *                quietly truncated result, since silent truncation is the very
 *                failure this helper exists to prevent.
 */
export async function selectAllPages<T>(
	build: (range: PageRange) => PromiseLike<PageResult<T>>,
	options: { pageSize?: number; maxRows?: number; label?: string } = {},
): Promise<T[]> {
	const pageSize = options.pageSize ?? SUPABASE_PAGE_SIZE;
	const maxRows = options.maxRows ?? 100_000;
	const label = options.label ?? "selectAllPages";
	const rows: T[] = [];

	for (let from = 0; ; from += pageSize) {
		const { data, error } = await build({ from, to: from + pageSize - 1 });
		if (error) throw new Error(`${label}: ${error.message}`);
		const page = data ?? [];
		rows.push(...page);
		if (page.length < pageSize) return rows;
		if (rows.length >= maxRows) {
			throw new Error(
				`${label}: exceeded maxRows (${maxRows}) — narrow the filter or raise the ceiling deliberately`,
			);
		}
	}
}
