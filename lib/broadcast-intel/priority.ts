/**
 * Pure, deterministic priority for a bounded broadcast-analysis candidate
 * pool. The unclassified bucket is an internal balancing key only: callers
 * always receive the row's stored category unchanged.
 */
export const UNCLASSIFIED_ANALYSIS_CATEGORY = "\u0000broadcast-analysis-unclassified";

export interface AnalysisCandidate {
	id: string;
	channel: "qvc" | "shopch";
	category: string | null | undefined;
	airDate: string;
	repeatCount: number;
}

/**
 * Balancing is per channel AND category, not category alone.
 *
 * The two channels are different media, not different lengths of the same one:
 * QVC archives ~2-minute digest clips, Shop Channel archives ~1-hour
 * programmes. Keying on category alone let QVC's higher slot count take every
 * round in a category both channels share, so Shop Channel's rows in that
 * category were never analysed no matter how low their count.
 */
export function analysisBalanceKey(
	channel: "qvc" | "shopch",
	category: string | null | undefined,
): string {
	return `${channel}\u0000${normalizeAnalysisCategory(category)}`;
}

export function normalizeAnalysisCategory(category: string | null | undefined): string {
	const normalized = typeof category === "string" ? category.trim() : "";
	return normalized || UNCLASSIFIED_ANALYSIS_CATEGORY;
}

function normalizedCount(value: number | undefined): number {
	return Number.isFinite(value) && value! >= 0 ? value! : 0;
}

/** Counts arrive already keyed by `analysisBalanceKey`; this only sanitizes them. */
function normalizeCategoryCounts(categoryCounts: ReadonlyMap<string, number>): Map<string, number> {
	const normalized = new Map<string, number>();
	for (const [key, count] of categoryCounts) {
		normalized.set(key, (normalized.get(key) ?? 0) + normalizedCount(count));
	}
	return normalized;
}

function compareTextAscending(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareCandidates(
	left: AnalysisCandidate,
	right: AnalysisCandidate,
	categoryCounts: ReadonlyMap<string, number>,
): number {
	const leftCount = categoryCounts.get(analysisBalanceKey(left.channel, left.category)) ?? 0;
	const rightCount = categoryCounts.get(analysisBalanceKey(right.channel, right.category)) ?? 0;
	if (leftCount !== rightCount) return leftCount - rightCount;

	const leftRepeat = normalizedCount(left.repeatCount);
	const rightRepeat = normalizedCount(right.repeatCount);
	if (leftRepeat !== rightRepeat) return rightRepeat - leftRepeat;

	if (left.airDate !== right.airDate) return compareTextAscending(right.airDate, left.airDate);
	return compareTextAscending(left.id, right.id);
}

/**
 * Select a balanced slice from a bounded candidate pool.
 *
 * Category heads are ordered by the priority tuple — analyzed sample count
 * ascending, repeat count descending, air date descending, ID ascending —
 * and every available category contributes once per round. That lets a lower
 * volume category surface before a larger category can consume the batch.
 */
export function chooseBalancedAnalysisSlots(
	rows: readonly AnalysisCandidate[],
	categoryCounts: ReadonlyMap<string, number>,
	limit: number,
): AnalysisCandidate[] {
	if (!Number.isFinite(limit) || limit <= 0) return [];
	const capacity = Math.floor(limit);
	const normalizedCounts = normalizeCategoryCounts(categoryCounts);
	const byCategory = new Map<string, AnalysisCandidate[]>();

	for (const row of rows) {
		const key = analysisBalanceKey(row.channel, row.category);
		const group = byCategory.get(key);
		if (group) group.push(row);
		else byCategory.set(key, [row]);
	}

	const groups = [...byCategory.entries()].map(([category, group]) => ({
		category,
		rows: [...group].sort((left, right) => compareCandidates(left, right, normalizedCounts)),
	}));
	const selected: AnalysisCandidate[] = [];

	while (selected.length < capacity) {
		const available = groups
			.filter((group) => group.rows.length > 0)
			.sort((left, right) => {
				const priority = compareCandidates(left.rows[0]!, right.rows[0]!, normalizedCounts);
				return priority || compareTextAscending(left.category, right.category);
			});
		if (available.length === 0) break;

		for (const group of available) {
			if (selected.length >= capacity) break;
			selected.push(group.rows.shift()!);
		}
	}

	return selected;
}
