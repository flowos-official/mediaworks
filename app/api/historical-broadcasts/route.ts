import { requireUser } from "@/lib/auth/require-user";
import { MISDATED_OA_OR_CLAUSES } from "@/lib/broadcasts/misdated-suppression";
import { DELISTED_CALENDAR_CHANNELS } from "@/lib/broadcasts/channel-style";
import { type NextRequest, NextResponse } from "next/server";
import { filterMarketRecords } from "@/lib/market/data-visibility";
import { appConfig } from "@/config/app";
import { getRuntimeMarketCountry } from "@/lib/market/runtime-market";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INT_PARAM = /^\d+$/;
const OA_CHANNELS = new Set([
	"japanet",
	"junsanpo",
	"ntv",
	"tbs",
	"dinos",
	"senobura",
	"txd",
	"kantv",
	"rakuraku",
	"ichiban",
]);
// ropping (2026-06-18, duplicate of junsanpo) and uranoura (2026-06-19, off-air)
// were delisted from the calendar. Their historical_broadcasts rows are
// preserved but excluded from this read API so they don't resurface in the
// calendar's free-text search. Shared list in
// lib/broadcasts/channel-style.ts::DELISTED_CALENDAR_CHANNELS.

export interface HistoricalBroadcastRow {
	id: string;
	channel: string;
	air_date: string;
	day_of_week: string | null;
	start_time: string | null;
	product_name: string;
	price_text: string | null;
	price_jpy: number | null;
	price_is_tax_incl: boolean | null;
	source_url: string | null;
	category: string | null;
	image_url: string | null;
}

export async function GET(req: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { searchParams } = new URL(req.url);
	const channel = searchParams.get("channel");
	const from = searchParams.get("from");
	const to = searchParams.get("to");
	const date = searchParams.get("date");
	const search = searchParams.get("search");
	const category = searchParams.get("category");
	const limitRaw = searchParams.get("limit");
	const offsetRaw = searchParams.get("offset");

	for (const [name, raw] of [["limit", limitRaw], ["offset", offsetRaw]] as const) {
		if (raw !== null && !INT_PARAM.test(raw)) {
			return NextResponse.json({ error: `invalid ${name}` }, { status: 400 });
		}
	}
	const limit = Math.min(limitRaw === null ? 200 : parseInt(limitRaw, 10), 500);
	const offset = offsetRaw === null ? 0 : parseInt(offsetRaw, 10);

	if (channel && !OA_CHANNELS.has(channel)) {
		return NextResponse.json({ error: "invalid channel" }, { status: 400 });
	}
	for (const v of [from, to, date]) {
		if (v && !ISO_DATE.test(v)) {
			return NextResponse.json({ error: "invalid date format" }, { status: 400 });
		}
	}

	// Use the server client returned by requireUser so RLS policies still apply.
	// Per CLAUDE.md: getServiceClient is reserved for cron/workflow paths.
	let q = auth.sb
		.from("historical_broadcasts")
		.select(
			"id,channel,air_date,day_of_week,start_time,product_name,price_text,price_jpy,price_is_tax_incl,source_url,category,image_url",
			{ count: "exact" },
		)
		.order("air_date", { ascending: false })
		.order("start_time", { ascending: true, nullsFirst: false })
		.order("channel", { ascending: true })
		.range(offset, offset + limit - 1);
	q = q.eq("country", getRuntimeMarketCountry());

	if (channel) q = q.eq("channel", channel);
	if (appConfig.market.countryCode === "JP") q = q.in("channel", [...OA_CHANNELS]);
	// Exclude delisted channels (ropping) from list + search — rows are kept in
	// the DB but must not appear in the calendar.
	for (const delisted of DELISTED_CALENDAR_CHANNELS) q = q.neq("channel", delisted);
	if (date) q = q.eq("air_date", date);
	if (from) q = q.gte("air_date", from);
	if (to) q = q.lte("air_date", to);
	if (search) q = q.ilike("product_name", `%${search}%`);
	if (category) q = q.eq("category", category);
	// Hide mis-dated OA rows (ntv/junsanpo/tbs) from list + search. Each clause
	// is a no-op for channels / dates it doesn't target. See misdated-suppression.ts.
	for (const clause of MISDATED_OA_OR_CLAUSES) q = q.or(clause);

	const { data, count, error } = await q;
	if (error) {
		console.error("historical-broadcasts list error", error);
		return NextResponse.json({ error: "db error" }, { status: 500 });
	}

	const rows = filterMarketRecords(data ?? []);
	return NextResponse.json(
		{ rows, total: count ?? rows.length, limit, offset },
		{
			headers: {
				// `private`: this response is auth-gated, must not be served by
				// shared caches (CDN/proxy) to other users.
				"Cache-Control": "private, max-age=300, stale-while-revalidate=3600",
			},
		},
	);
}
