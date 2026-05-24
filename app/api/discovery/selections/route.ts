import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from "next/server";
import { getCachedDiscoverySelections } from "@/lib/discovery/cached";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { searchParams } = new URL(req.url);
	const status = searchParams.get("status");
	const contextFilter = searchParams.get("context");
	const context =
		contextFilter === "home_shopping" || contextFilter === "live_commerce"
			? contextFilter
			: null;
	const days = Math.min(Number(searchParams.get("days") ?? 30), 365);
	const page = Math.max(Number(searchParams.get("page") ?? 0), 0);
	const limit = Math.min(Number(searchParams.get("limit") ?? 20), 100);

	try {
		const data = await getCachedDiscoverySelections(context, status, days, page, limit);
		return NextResponse.json(data);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
