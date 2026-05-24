import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from "next/server";
import { getCachedDiscoveryInsights } from "@/lib/discovery/cached";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { searchParams } = new URL(req.url);
	const contextFilter = searchParams.get("context");
	const context =
		contextFilter === "home_shopping" || contextFilter === "live_commerce"
			? contextFilter
			: null;
	const weeks = Math.min(Number(searchParams.get("weeks") ?? 12), 52);

	const now = new Date();
	const day = now.getUTCDay();
	const daysFromMonday = day === 0 ? 6 : day - 1;
	const monday = new Date(now);
	monday.setUTCDate(now.getUTCDate() - daysFromMonday);
	monday.setUTCHours(0, 0, 0, 0);
	const mondayIso = monday.toISOString();

	try {
		const data = await getCachedDiscoveryInsights(context, weeks, mondayIso);
		return NextResponse.json(data);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
