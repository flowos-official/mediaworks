import { NextRequest, NextResponse } from "next/server";
import { GET as runCron } from "@/app/api/cron/daily-discovery/route";

export const maxDuration = 300;

/**
 * Manual admin trigger for discovery cron — used when the scheduled run
 * fails or for ad-hoc runs. Protected by CRON_SECRET (matches cron auth).
 */
export async function POST(req: NextRequest) {
	const secret = process.env.CRON_SECRET;
	if (secret) {
		const header = req.headers.get("authorization");
		if (header !== `Bearer ${secret}`) {
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		}
	}
	return runCron(req);
}
