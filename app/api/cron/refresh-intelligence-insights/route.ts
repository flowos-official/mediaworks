import { timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import {
	refreshIntelligenceInsights,
	type RefreshInsightsDependencies,
	type RefreshIntelligenceInsightsResult,
} from "@/lib/intelligence/refresh-insights";
import {
	createPipelineRunRepository,
	startPipelineRun,
	type PipelineRunHandle,
	type PipelineRunRepository,
} from "@/lib/intelligence/pipeline-run";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 300;

const REFRESH_LIMIT = 200;
const REFRESH_INVOCATION_BUCKET_MS = 15 * 60_000;

export function refreshInsightsInvocationBucket(now: Date): string {
	const nowMs = now.getTime();
	if (!Number.isFinite(nowMs)) throw new Error("refresh invocation clock is invalid");
	return new Date(Math.floor(nowMs / REFRESH_INVOCATION_BUCKET_MS) * REFRESH_INVOCATION_BUCKET_MS).toISOString();
}

export type RefreshInsightsInvocationAcquisition =
	| { status: "acquired"; invocationBucket: string; run: PipelineRunHandle }
	| { status: "duplicate"; invocationBucket: string };

function databaseErrorCode(error: unknown): string | null {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code ?? "") || null
		: null;
}

export async function acquireRefreshInsightsInvocation(
	repository: PipelineRunRepository,
	cutoff: string,
	limit: number,
): Promise<RefreshInsightsInvocationAcquisition> {
	const invocationBucket = refreshInsightsInvocationBucket(new Date(cutoff));
	try {
		const run = await startPipelineRun(repository, {
			sourceType: "evidence_items",
			jobType: "insight_refresh",
			externalRunId: `insight-refresh-cron:${invocationBucket}`,
			targetScope: { cutoff, invocationBucket, limit },
		});
		return { status: "acquired", invocationBucket, run };
	} catch (error) {
		if (databaseErrorCode(error) === "23505") return { status: "duplicate", invocationBucket };
		throw error;
	}
}

function safeEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function isRefreshInsightsCronAuthorized(headers: Headers, secret: string | undefined): boolean {
	if (!secret) return false;
	return safeEqual(headers.get("authorization") ?? "", `Bearer ${secret}`);
}

export interface RefreshInsightsCronDependencies {
	secret?: string;
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
}

export async function runRefreshInsightsCron(
	request: Pick<Request, "headers">,
	dependencies: RefreshInsightsCronDependencies = {},
): Promise<NextResponse> {
	const secret = dependencies.secret ?? process.env.CRON_SECRET;
	if (!isRefreshInsightsCronAuthorized(request.headers, secret)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		const cutoff = (dependencies.now ?? (() => new Date()))().toISOString();
		const sb = (dependencies.getClient ?? getServiceClient)();
		const acquireRun = dependencies.acquireRun
			?? ((client, currentCutoff, limit) => acquireRefreshInsightsInvocation(createPipelineRunRepository(client), currentCutoff, limit));
		const acquisition = await acquireRun(sb, cutoff, REFRESH_LIMIT);
		if (acquisition.status === "duplicate") {
			return NextResponse.json({
				ok: true,
				skipped: "duplicate-invocation",
				invocationBucket: acquisition.invocationBucket,
			});
		}
		const refresh = dependencies.refresh ?? refreshIntelligenceInsights;
		const summary = await refresh(sb, cutoff, REFRESH_LIMIT, {
			startPipelineRun: async () => acquisition.run,
		});
		return NextResponse.json({ ok: true, ...summary });
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
