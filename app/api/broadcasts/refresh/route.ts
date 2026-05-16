import { type NextRequest, NextResponse } from "next/server";
import { scrapeAllForDate } from "@/lib/broadcasts";
import { sleep } from "@/lib/broadcasts/fetch";
import { hasInternalSecret, requireUser } from "@/lib/auth/require-user";

export const maxDuration = 60;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function verifyAdminOrCron(req: NextRequest): Promise<NextResponse | null> {
	if (hasInternalSecret(req)) return null;
	const auth = await requireUser(["admin"]);
	if ("error" in auth) return auth.error;
	return null;
}

function parseISO(d: string): Date | null {
	if (!ISO_DATE.test(d)) return null;
	const date = new Date(`${d}T00:00:00Z`);
	if (Number.isNaN(date.getTime())) return null;
	return date;
}

function diffDays(a: Date, b: Date): number {
	return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

interface RefreshBody {
	date?: string;
	from?: string;
	to?: string;
}

export async function POST(req: NextRequest) {
	const denied = await verifyAdminOrCron(req);
	if (denied) return denied;

	let body: RefreshBody;
	try {
		body = (await req.json()) as RefreshBody;
	} catch {
		return NextResponse.json({ error: "invalid json" }, { status: 400 });
	}

	const dates: Date[] = [];
	if (body.date) {
		const d = parseISO(body.date);
		if (!d) return NextResponse.json({ error: "bad date" }, { status: 400 });
		dates.push(d);
	} else if (body.from && body.to) {
		const from = parseISO(body.from);
		const to = parseISO(body.to);
		if (!from || !to) {
			return NextResponse.json({ error: "bad from/to" }, { status: 400 });
		}
		if (to.getTime() < from.getTime()) {
			return NextResponse.json({ error: "to < from" }, { status: 400 });
		}
		const days = diffDays(from, to) + 1;
		if (days > 7) {
			return NextResponse.json({ error: "range > 7 days" }, { status: 400 });
		}
		for (let i = 0; i < days; i++) {
			const d = new Date(from);
			d.setUTCDate(d.getUTCDate() + i);
			dates.push(d);
		}
	} else {
		return NextResponse.json(
			{ error: "provide date or from+to" },
			{ status: 400 },
		);
	}

	const results: Array<Record<string, unknown>> = [];
	let totalInserted = 0;
	let totalUpdated = 0;
	let totalErrors = 0;

	for (const [i, d] of dates.entries()) {
		const iso = d.toISOString().slice(0, 10);
		const summary = await scrapeAllForDate(d);
		totalInserted += summary.totalInserted;
		totalUpdated += summary.totalUpdated;
		totalErrors += summary.totalErrors;
		results.push({
			date: iso,
			channels: Object.fromEntries(
				summary.results.map((r) => [
					r.channel,
					{ ok: r.ok, count: r.slots.length, ...(r.error ? { error: r.error } : {}) },
				]),
			),
			inserted: summary.totalInserted,
			updated: summary.totalUpdated,
			errors: summary.totalErrors,
		});
		if (i < dates.length - 1) await sleep(1000);
	}

	return NextResponse.json({
		ok: true,
		results,
		totals: { inserted: totalInserted, updated: totalUpdated, errors: totalErrors },
	});
}
