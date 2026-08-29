import { timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import {
	refreshIntelligenceInsights,
	type RefreshIntelligenceInsightsResult,
} from "@/lib/intelligence/refresh-insights";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 300;

const REFRESH_LIMIT = 200;

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
	) => Promise<RefreshIntelligenceInsightsResult>;
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
		const refresh = dependencies.refresh ?? refreshIntelligenceInsights;
		const summary = await refresh(sb, cutoff, REFRESH_LIMIT);
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
