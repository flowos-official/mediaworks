import { NextResponse } from "next/server";

export const maxDuration = 10;

/**
 * DEPRECATED — replaced by /api/cron/daily-discovery-home and /-live.
 * Kept for backwards compatibility: returns 410 Gone.
 */
export async function GET() {
	return NextResponse.json(
		{
			error: "deprecated",
			replacement: [
				"/api/cron/daily-discovery-home",
				"/api/cron/daily-discovery-live",
			],
		},
		{ status: 410 },
	);
}
