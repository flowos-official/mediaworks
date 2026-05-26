import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_INFLIGHT_PER_USER = Number(process.env.ANALYZE_MAX_INFLIGHT_PER_USER ?? "3");
const MAX_DAILY_PER_USER = Number(process.env.ANALYZE_MAX_DAILY_PER_USER ?? "20");

export type RateLimitResult =
	| { kind: "ok" }
	| { kind: "inflight_exceeded"; current: number; max: number }
	| { kind: "daily_exceeded"; current: number; max: number };

/**
 * /api/upload の per-user rate limit を Postgres カウントで判定。
 *
 * - inflight: 同一 user の products WHERE status IN ('pending','analyzing') が
 *   MAX_INFLIGHT 以上なら 429。同時並列の暴走防止。
 * - daily: 同一 user の products WHERE created_at > now() - 24h が MAX_DAILY 以上
 *   なら 429。一日あたりの Gemini 予算をキャップ。
 *
 * Admin role はスキップ。internal-secret 経路 (cron) はこの helper を呼ばない。
 */
export async function checkAnalyzeRateLimit(
	sb: SupabaseClient,
	userId: string,
	role: "member" | "admin",
): Promise<RateLimitResult> {
	if (role === "admin") return { kind: "ok" };

	const { count: inflightCount, error: inflightErr } = await sb
		.from("products")
		.select("id", { count: "exact", head: true })
		.eq("created_by", userId)
		.in("status", ["pending", "analyzing"]);
	if (inflightErr) throw inflightErr;
	const inflight = inflightCount ?? 0;
	if (inflight >= MAX_INFLIGHT_PER_USER) {
		return { kind: "inflight_exceeded", current: inflight, max: MAX_INFLIGHT_PER_USER };
	}

	const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const { count: dailyCount, error: dailyErr } = await sb
		.from("products")
		.select("id", { count: "exact", head: true })
		.eq("created_by", userId)
		.gt("created_at", since);
	if (dailyErr) throw dailyErr;
	const daily = dailyCount ?? 0;
	if (daily >= MAX_DAILY_PER_USER) {
		return { kind: "daily_exceeded", current: daily, max: MAX_DAILY_PER_USER };
	}

	return { kind: "ok" };
}
