/**
 * The competitor pattern, WITH the reason when there isn't one.
 *
 * loadCategoryPattern returns `CategoryPattern | null`, and that null carried
 * five different meanings: the feature is off, the product has no category,
 * the category is not one the broadcast corpus uses, there are fewer than
 * MIN_SAMPLES analysed slots in it, or the lookup was too slow. The workflow
 * logged which one to the console and then stored nothing, so a version
 * generated six weeks ago is unexplainable — and an operator who enabled the
 * feature and typed 「美容家電」 saw nothing happen with no way to find out why.
 *
 * Every one of those is now a value that gets persisted with the run.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import {
	ALL_WHITELIST_CATEGORIES,
	MIN_SAMPLES,
	loadCategoryPattern,
	type CategoryPattern,
} from "@/lib/broadcast-intel/category-pattern";

export type PatternLoadStatus =
	| "disabled"
	| "no_category"
	| "off_whitelist"
	| "under_sampled"
	| "timed_out"
	| "failed"
	| "applied";

export interface PatternLoadResult {
	status: PatternLoadStatus;
	pattern: CategoryPattern | null;
	detail: string;
}

export const PATTERN_TIMEOUT_MS = 5_000;

export interface PatternLoadOptions {
	/** Defaults to BROADCAST_INTEL_ENABLED === "true". */
	enabled?: boolean;
	timeoutMs?: number;
	/** Injectable so the statuses can be tested without a corpus. */
	load?: (category: string) => Promise<CategoryPattern | null>;
}

/**
 * Never throws. A screenplay must still generate when the corpus is thin,
 * disabled, slow or unreachable — the point of the status is that the failure
 * is recorded rather than swallowed.
 */
export async function loadPatternResult(
	category: string | null,
	options: PatternLoadOptions = {},
): Promise<PatternLoadResult> {
	const enabled = options.enabled ?? process.env.BROADCAST_INTEL_ENABLED === "true";
	const timeoutMs = options.timeoutMs ?? PATTERN_TIMEOUT_MS;
	const load = options.load ?? loadCategoryPattern;

	if (!enabled) {
		return {
			status: "disabled",
			pattern: null,
			detail: "broadcast intelligence is disabled (BROADCAST_INTEL_ENABLED)",
		};
	}
	const trimmed = category?.trim();
	if (!trimmed) {
		return { status: "no_category", pattern: null, detail: "product category is missing" };
	}
	if (!ALL_WHITELIST_CATEGORIES.has(trimmed)) {
		return {
			status: "off_whitelist",
			pattern: null,
			detail: `category "${trimmed}" is not on the broadcast whitelist`,
		};
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	try {
		const pattern = await Promise.race([
			load(trimmed),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => {
					timedOut = true;
					resolve(null);
				}, timeoutMs);
			}),
		]);
		if (timedOut) {
			return {
				status: "timed_out",
				pattern: null,
				detail: `pattern lookup for "${trimmed}" exceeded ${timeoutMs}ms`,
			};
		}
		if (!pattern) {
			// Whitelist was already checked, so a null here means the corpus is
			// too thin — the one remaining reason loadCategoryPattern has.
			return {
				status: "under_sampled",
				pattern: null,
				detail: `category "${trimmed}" has fewer than ${MIN_SAMPLES} analyzed broadcasts in the lookback window`,
			};
		}
		return {
			status: "applied",
			pattern,
			detail: `${pattern.sampleSize} analyzed broadcasts across ${pattern.channels.join(", ")}`,
		};
	} catch (error) {
		return {
			status: "failed",
			pattern: null,
			detail: `pattern lookup failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}
