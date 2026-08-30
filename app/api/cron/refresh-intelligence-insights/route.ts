import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import {
	refreshIntelligenceInsights,
	type RefreshInsightsDependencies,
	type RefreshIntelligenceInsightsResult,
} from "@/lib/intelligence/refresh-insights";
import {
	createPipelineRunRepository,
	reapOrphanedPipelineRuns,
	startPipelineRun,
	type PipelineRunHandle,
	type PipelineRunRepository,
} from "@/lib/intelligence/pipeline-run";
import { isDuplicateRunError } from "@/lib/cron/duplicate-guard";
import { hasInternalSecret } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 300;

const REFRESH_LIMIT = 200;

/**
 * Leave headroom under `maxDuration` for the run to record its own outcome. A
 * job that spends its whole allowance on work and is then killed mid-settle has
 * produced one more orphan, which is the opposite of the point.
 */
const BUDGET_MS = 240_000;

/**
 * `input_until` is floored to this quantum so two invocations of the same
 * trigger compute the same evidence window, which is what lets the identity
 * constraint on `insight_snapshots` (20260830120000) actually catch them.
 *
 * This is not the lock — 20260830110000's sliding-window trigger is, and this
 * quantum has a boundary a pair can straddle just as the old invocation bucket
 * did. The difference is what a straddle now costs: one redundant snapshot,
 * not a corrupted scan cursor. Matches DUPLICATE_WINDOW_MS so the two agree on
 * what "the same trigger" means.
 */
const CUTOFF_QUANTUM_MS = 5 * 60_000;

export function refreshInsightsCutoff(now: Date): string {
	const nowMs = now.getTime();
	if (!Number.isFinite(nowMs)) throw new Error("refresh cutoff clock is invalid");
	return new Date(Math.floor(nowMs / CUTOFF_QUANTUM_MS) * CUTOFF_QUANTUM_MS).toISOString();
}

export type RefreshInsightsInvocationAcquisition =
	| { status: "acquired"; run: PipelineRunHandle }
	| { status: "duplicate"; reason: string };

function databaseErrorCode(error: unknown): string | null {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code ?? "") || null
		: null;
}

/**
 * Mutual exclusion is the database's, via the sliding-window trigger in
 * 20260830110000. The fixed 15-minute bucket this replaces could not see the
 * duplicate this project actually gets — two invocations 26-82s apart straddle
 * a bucket boundary often enough to slip through, and two concurrent refreshes
 * read the same cursor and write the same snapshots twice.
 *
 * The error is matched on message, not on SQLSTATE alone. `23505` is also what
 * a genuine constraint violation raises, and this repo has already been bitten
 * by a silently skipped write hiding a 22-day outage — so anything that is not
 * recognisably the duplicate trigger is re-thrown and becomes a 500.
 */
export async function acquireRefreshInsightsInvocation(
	repository: PipelineRunRepository,
	cutoff: string,
	limit: number,
): Promise<RefreshInsightsInvocationAcquisition> {
	try {
		const run = await startPipelineRun(repository, {
			sourceType: "evidence_items",
			jobType: "insight_refresh",
			externalRunId: `insight-refresh-cron:${randomUUID()}`,
			targetScope: { cutoff, limit },
		});
		return { status: "acquired", run };
	} catch (error) {
		if (databaseErrorCode(error) === "23505" && isDuplicateRunError(error)) {
			return { status: "duplicate", reason: error instanceof Error ? error.message : String(error) };
		}
		throw error;
	}
}

export function isRefreshInsightsCronAuthorized(headers: Headers): boolean {
	return hasInternalSecret({ headers });
}

export interface RefreshInsightsCronDependencies {
	now?: () => Date;
	getClient?: () => SupabaseClient;
	refresh?: (
		sb: SupabaseClient,
		cutoff: string,
		limit: number,
		dependencies?: RefreshInsightsDependencies,
	) => Promise<RefreshIntelligenceInsightsResult>;
	acquireRun?: (
		sb: SupabaseClient,
		cutoff: string,
		limit: number,
	) => Promise<RefreshInsightsInvocationAcquisition>;
	reapOrphans?: (sb: SupabaseClient, now: Date) => Promise<number>;
}

export async function runRefreshInsightsCron(
	request: Pick<Request, "headers">,
	dependencies: RefreshInsightsCronDependencies = {},
): Promise<NextResponse> {
	if (!isRefreshInsightsCronAuthorized(request.headers)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const startedAtMs = Date.now();
	try {
		const startedAt = (dependencies.now ?? (() => new Date()))();
		const cutoff = refreshInsightsCutoff(startedAt);
		const sb = (dependencies.getClient ?? getServiceClient)();

		// Preflight sweep, the same shape as archive-videos calling
		// recoverStaleDownloading: settle runs a killed function left behind so
		// they stop holding the duplicate-guard slot and stop being trusted as a
		// cursor to resume from. Best-effort — a telemetry sweep is never a
		// reason to skip the refresh.
		const reapOrphans = dependencies.reapOrphans ?? reapOrphanedPipelineRuns;
		let orphansReaped = 0;
		try {
			orphansReaped = await reapOrphans(sb, startedAt);
			if (orphansReaped > 0) {
				console.warn(`[refresh-intelligence-insights] settled ${orphansReaped} orphaned pipeline run(s)`);
			}
		} catch (error) {
			console.warn(
				"[refresh-intelligence-insights] orphan sweep failed:",
				error instanceof Error ? error.message : String(error),
			);
		}

		const acquireRun = dependencies.acquireRun
			?? ((client, currentCutoff, limit) => acquireRefreshInsightsInvocation(createPipelineRunRepository(client), currentCutoff, limit));
		const acquisition = await acquireRun(sb, cutoff, REFRESH_LIMIT);
		if (acquisition.status === "duplicate") {
			return NextResponse.json({
				ok: true,
				skipped: "duplicate-invocation",
				reason: acquisition.reason,
				orphansReaped,
			});
		}
		const refresh = dependencies.refresh ?? refreshIntelligenceInsights;
		const summary = await refresh(sb, cutoff, REFRESH_LIMIT, {
			startPipelineRun: async () => acquisition.run,
			deadlineAtMs: startedAtMs + BUDGET_MS,
		});
		return NextResponse.json({ ok: true, orphansReaped, ...summary });
	} catch (error) {
		console.error(
			"[refresh-intelligence-insights] failed:",
			error instanceof Error ? error.message : String(error),
		);
		return NextResponse.json({ error: "internal_error" }, { status: 500 });
	}
}

export async function GET(request: Request): Promise<NextResponse> {
	return runRefreshInsightsCron(request);
}
