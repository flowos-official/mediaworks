import { type NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { loadProductsForBroadcasts } from "@/lib/qvc-products/attach";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_CHANNELS = new Set(["shopch", "qvc"]);
const MAX_RANGE_DAYS = 62;

export async function GET(req: NextRequest) {
	const { searchParams } = new URL(req.url);
	const from = searchParams.get("from");
	const to = searchParams.get("to");
	const channel = searchParams.get("channel");

	if (!from || !ISO_DATE.test(from)) {
		return NextResponse.json({ error: "missing or invalid 'from'" }, { status: 400 });
	}
	if (!to || !ISO_DATE.test(to)) {
		return NextResponse.json({ error: "missing or invalid 'to'" }, { status: 400 });
	}
	if (to < from) {
		return NextResponse.json({ error: "to < from" }, { status: 400 });
	}
	const days =
		Math.round(
			(new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) /
				86_400_000,
		) + 1;
	if (days > MAX_RANGE_DAYS) {
		return NextResponse.json(
			{ error: `range > ${MAX_RANGE_DAYS} days` },
			{ status: 400 },
		);
	}
	if (channel && !VALID_CHANNELS.has(channel)) {
		return NextResponse.json({ error: "invalid channel" }, { status: 400 });
	}

	const sb = getServiceClient();
	let query = sb
		.from("broadcasts")
		.select(
			"id,channel,air_date,start_time,program_title,presenter,description,thumbnail_url,source_url,product_ids",
		)
		.gte("air_date", from)
		.lte("air_date", to)
		.order("air_date", { ascending: true })
		.order("start_time", { ascending: true })
		.order("channel", { ascending: true });

	if (channel) query = query.eq("channel", channel);

	const { data, error } = await query;
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
	// Also pull the slot-level archived video URL on broadcasts (for Shop Channel)
	const idsForVideo = rows.map((r) => r.id);
	const videoMap = new Map<string, string | null>();
	if (idsForVideo.length > 0) {
		const { data: videoRows } = await sb
			.from("broadcasts")
			.select("id,archived_video_s3")
			.in("id", idsForVideo);
		for (const v of videoRows ?? []) {
			videoMap.set((v as { id: string }).id, (v as { archived_video_s3: string | null }).archived_video_s3);
		}
	}

	const { qvc: qvcMap, shopch: shopchMap } = await loadProductsForBroadcasts(rows);
	const enriched = rows.map((b) => ({
		...b,
		products: b.channel === "qvc" ? (qvcMap.get(b.id) ?? null) : (shopchMap.get(b.id) ?? null),
		archived_video_s3: videoMap.get(b.id) ?? null,
	}));

	return NextResponse.json(
		{ broadcasts: enriched, total: enriched.length },
		{
			headers: {
				"Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
			},
		},
	);
}
