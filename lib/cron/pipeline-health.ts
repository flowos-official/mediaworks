/**
 * Pure health classification for scripts/verify-pipeline.ts.
 *
 * NO `import "server-only"` — imported by a tsx regression test.
 */

export interface RunRecord {
	run_at: string;
	status: string;
}

export interface DiscoveryRunOriginRecord {
	produced_count: number;
	category_plan: unknown | null;
}

/**
 * Cron sessions start at zero products and later receive a category plan.
 * Synthetic strategy sessions start with a positive produced_count and never
 * receive a plan. Unlike `iterations`, these shapes remain distinct after the
 * cron finalizer updates the row.
 */
export function isCronDiscoveryRun(row: DiscoveryRunOriginRecord): boolean {
	return row.produced_count === 0 || row.category_plan !== null;
}

export interface LatestRunProbe {
	/** Most recent successful run, used for freshness. */
	at: string | null;
	latestAt: string | null;
	latestStatus: string | null;
	/** The latest run itself must be successful. */
	healthy: boolean;
}

export function latestRunProbe(
	rows: RunRecord[],
	successfulStatuses: ReadonlySet<string>,
): LatestRunProbe {
	const sorted = [...rows].sort(
		(a, b) => Date.parse(b.run_at) - Date.parse(a.run_at),
	);
	const latest = sorted[0];
	const latestSuccess = sorted.find((row) => successfulStatuses.has(row.status));
	return {
		at: latestSuccess?.run_at ?? null,
		latestAt: latest?.run_at ?? null,
		latestStatus: latest?.status ?? null,
		healthy: Boolean(latest && successfulStatuses.has(latest.status)),
	};
}

export type StageHealth = "healthy" | "failed" | "stale" | "missing";

export function classifyStageHealth(input: {
	at: string | null;
	sourceHealthy: boolean;
	maxAgeMs: number;
	nowMs: number;
}): StageHealth {
	if (!input.at) return "missing";
	if (!input.sourceHealthy) return "failed";
	const atMs = Date.parse(input.at);
	if (!Number.isFinite(atMs) || atMs > input.nowMs) return "failed";
	return input.nowMs - atMs <= input.maxAgeMs ? "healthy" : "stale";
}

interface VercelLogLine {
	timestamp?: number;
	requestPath?: string;
	responseStatusCode?: number;
	message?: string;
}

export interface VercelInvocation {
	at: string;
	statusCode: number;
	message: string;
	healthy: boolean;
}

export function parseLatestVercelInvocation(
	jsonLines: string,
	requestPath: string,
): VercelInvocation | null {
	const matches = jsonLines
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as VercelLogLine)
		.filter(
			(line): line is Required<Pick<VercelLogLine, "timestamp" | "requestPath" | "responseStatusCode">> & VercelLogLine =>
				line.requestPath === requestPath &&
				Number.isFinite(line.timestamp) &&
				Number.isInteger(line.responseStatusCode),
		)
		.sort((a, b) => b.timestamp - a.timestamp);
	const latest = matches[0];
	if (!latest) return null;
	return {
		at: new Date(latest.timestamp).toISOString(),
		statusCode: latest.responseStatusCode,
		message: latest.message ?? "",
		healthy: latest.responseStatusCode >= 200 && latest.responseStatusCode < 300,
	};
}
