import { requireUser } from "@/lib/auth/require-user";
import { type NextRequest, NextResponse } from "next/server";
import { loadProductsForBroadcasts } from "@/lib/qvc-products/attach";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INT_PARAM = /^\d+$/;
const VALID_CHANNELS = new Set(["shopch", "qvc"]);
const MAX_RANGE_DAYS = 62;

export async function GET(req: NextRequest) {
	// auth: requireUser
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { searchParams } = new URL(req.url);
	const from = searchParams.get("from");
	const to = searchParams.get("to");
	const channel = searchParams.get("channel");
	const category = searchParams.get("category");
	const search = searchParams.get("search");
	const limitRaw = searchParams.get("limit");
	const offsetRaw = searchParams.get("offset");

	// In search mode, from/to are optional. In calendar mode, both are required.
	if (!search) {
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
	} else {
		// Optional date refinement in search mode.
		if (from && !ISO_DATE.test(from)) {
			return NextResponse.json({ error: "invalid 'from'" }, { status: 400 });
		}
		if (to && !ISO_DATE.test(to)) {
			return NextResponse.json({ error: "invalid 'to'" }, { status: 400 });
		}
	}
	for (const [name, raw] of [
		["limit", limitRaw],
		["offset", offsetRaw],
	] as const) {
		if (raw !== null && !INT_PARAM.test(raw)) {
			return NextResponse.json({ error: `invalid ${name}` }, { status: 400 });
		}
	}
	// Cap bumped 2026-05-19: calendar's gridBounds (45-day range, ~30 broadcasts/day)
	// needs ≥1,400 rows. Old 500 cap silently truncated client month-nav data,
	// leaving most cells empty when user navigated to a different month.
	const limit = Math.min(limitRaw === null ? 200 : parseInt(limitRaw, 10), 2000);
	const offset = offsetRaw === null ? 0 : parseInt(offsetRaw, 10);

	if (channel && !VALID_CHANNELS.has(channel)) {
		return NextResponse.json({ error: "invalid channel" }, { status: 400 });
	}

	// Use the server client returned by requireUser so RLS still applies.
	// Per CLAUDE.md: getServiceClient is reserved for cron/workflow paths.
	let query = auth.sb
		.from("broadcasts")
		.select(
			"id,channel,air_date,start_time,program_title,presenter,description,thumbnail_url,source_url,product_ids,category,archived_video_s3,video_status,brand_name,brand_code",
			{ count: "exact" },
		)
		.order("air_date", { ascending: !search })
		.order("start_time", { ascending: true })
		.order("channel", { ascending: true })
		.range(offset, offset + limit - 1);

	if (from) query = query.gte("air_date", from);
	if (to) query = query.lte("air_date", to);
	if (channel) query = query.eq("channel", channel);
	if (category) query = query.eq("category", category);
	if (search) query = query.ilike("program_title", `%${search}%`);

	const { data, count, error } = await query;
	if (error) {
		console.error("broadcasts list error", error);
		return NextResponse.json({ error: "db error" }, { status: 500 });
	}

	const rows = (data ?? []) as Array<{
		id: string;
		channel: "shopch" | "qvc";
		product_ids: string[] | null;
		[k: string]: unknown;
	}>;
	const productMap = await loadProductsForBroadcasts(rows);
	const enriched = rows.map((b) => ({
		...b,
		products: productMap.get(b.id) ?? null,
	}));

	return NextResponse.json(
		{ broadcasts: enriched, total: count ?? enriched.length },
		{
			headers: {
				// `private`: response is auth-gated, must not be served by
				// shared caches (CDN/proxy) to other users.
				"Cache-Control": "private, max-age=300, stale-while-revalidate=3600",
			},
		},
	);
}
