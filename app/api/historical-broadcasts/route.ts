import { requireUser } from "@/lib/auth/require-user";
import { type NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const OA_CHANNELS = new Set([
	"japanet",
	"junsanpo",
	"ntv",
	"tbs",
	"dinos",
	"senobura",
	"uranoura",
	"btops",
]);

export interface HistoricalBroadcastRow {
	id: string;
	channel: string;
	air_date: string;
	day_of_week: string | null;
	product_name: string;
	price_text: string | null;
	price_jpy: number | null;
	price_is_tax_incl: boolean | null;
	source_url: string | null;
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
	const limit = Math.min(parseInt(searchParams.get("limit") ?? "200", 10), 500);
	const offset = Math.max(parseInt(searchParams.get("offset") ?? "0", 10), 0);

	if (channel && !OA_CHANNELS.has(channel)) {
		return NextResponse.json({ error: "invalid channel" }, { status: 400 });
	}
	for (const v of [from, to, date]) {
		if (v && !ISO_DATE.test(v)) {
			return NextResponse.json({ error: "invalid date format" }, { status: 400 });
		}
	}

	const sb = getServiceClient();
	let q = sb
		.from("historical_broadcasts")
		.select(
			"id,channel,air_date,day_of_week,product_name,price_text,price_jpy,price_is_tax_incl,source_url",
			{ count: "exact" },
		)
		.order("air_date", { ascending: false })
		.order("channel", { ascending: true })
		.range(offset, offset + limit - 1);

	if (channel) q = q.eq("channel", channel);
	if (date) q = q.eq("air_date", date);
	if (from) q = q.gte("air_date", from);
	if (to) q = q.lte("air_date", to);
	if (search) q = q.ilike("product_name", `%${search}%`);

	const { data, count, error } = await q;
	if (error) {
		console.error("historical-broadcasts list error", error);
		return NextResponse.json({ error: "db error" }, { status: 500 });
	}

	return NextResponse.json(
		{ rows: data ?? [], total: count ?? 0, limit, offset },
		{
			headers: {
				"Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
			},
		},
	);
}
