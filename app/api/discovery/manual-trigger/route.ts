import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from "next/server";
import { GET as runHomeCron } from "@/app/api/cron/daily-discovery-home/route";
import { GET as runLiveCron } from "@/app/api/cron/daily-discovery-live/route";

export const maxDuration = 300;

/**
 * Manual admin trigger for discovery cron.
 * Body: { context: 'home_shopping' | 'live_commerce' }
 * Protected by CRON_SECRET.
 */
export async function POST(req: NextRequest) {
	// auth: requireUser — admin only; replaces the prior CRON_SECRET gate so admins
	// can trigger from the UI without forging the header.
	const auth = await requireUser(["admin"]);
	if ("error" in auth) return auth.error;

	let context: "home_shopping" | "live_commerce" = "home_shopping";
	try {
		const body = (await req.json()) as { context?: string };
		if (body.context === "live_commerce") context = "live_commerce";
	} catch {
		// fall back to default
	}

	const runner = context === "live_commerce" ? runLiveCron : runHomeCron;
	return runner(req);
}
