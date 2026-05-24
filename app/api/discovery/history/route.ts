import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from "next/server";
import { getCachedDiscoveryHistory } from "@/lib/discovery/cached";

export const dynamic = "force-dynamic";

/**
 * History API — returns sessions grouped by date for calendar rendering,
 * with optional context filter and date range.
 *
 * Query params:
 *   - context: home_shopping | live_commerce (optional)
 *   - from: ISO date (default: now - 60 days)
 *   - to: ISO date (default: now)
 */
export async function GET(req: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { searchParams } = new URL(req.url);
	const contextFilter = searchParams.get("context");
	const context =
		contextFilter === "home_shopping" || contextFilter === "live_commerce"
			? contextFilter
			: null;

	const toDate = (searchParams.get("to") ?? new Date().toISOString()).slice(0, 10);
	const fromDate = (
		searchParams.get("from") ??
		new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString()
	).slice(0, 10);

	try {
		const data = await getCachedDiscoveryHistory(context, fromDate, toDate);
		return NextResponse.json(data);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
