import { requireUser } from "@/lib/auth/require-user";
import { type NextRequest, NextResponse } from "next/server";
import {
	aggregateCalendarCounts,
	type CountsByDate,
} from "@/lib/broadcasts/aggregate-counts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 62;

export interface CalendarCountsResponse {
	counts: CountsByDate;
}

export async function GET(req: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { searchParams } = new URL(req.url);
	const from = searchParams.get("from");
	const to = searchParams.get("to");

	if (!from || !ISO_DATE.test(from)) {
		return NextResponse.json(
			{ error: "missing or invalid 'from'" },
			{ status: 400 },
		);
	}
	if (!to || !ISO_DATE.test(to)) {
		return NextResponse.json(
			{ error: "missing or invalid 'to'" },
			{ status: 400 },
		);
	}
	if (to < from) {
		return NextResponse.json({ error: "to < from" }, { status: 400 });
	}
	const days =
		Math.round(
			(new Date(`${to}T00:00:00Z`).getTime() -
				new Date(`${from}T00:00:00Z`).getTime()) /
				86_400_000,
		) + 1;
	if (days > MAX_RANGE_DAYS) {
		return NextResponse.json(
			{ error: `range > ${MAX_RANGE_DAYS} days` },
			{ status: 400 },
		);
	}

	const counts = await aggregateCalendarCounts(from, to);

	return NextResponse.json(
		{ counts } satisfies CalendarCountsResponse,
		{
			headers: {
				// `private`: response is auth-gated, must not be served by shared
				// caches (CDN/proxy) to other users.
				"Cache-Control": "private, max-age=300, stale-while-revalidate=3600",
			},
		},
	);
}
