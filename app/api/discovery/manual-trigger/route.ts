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
	const secret = process.env.CRON_SECRET;
	if (secret) {
		const header = req.headers.get("authorization");
		if (header !== `Bearer ${secret}`) {
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		}
	}

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
