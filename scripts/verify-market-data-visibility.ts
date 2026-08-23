import { createClient } from "@supabase/supabase-js";
import {
	filterMarketBatchRecords,
	filterMarketRecords,
	isKoreanMarketRecord,
} from "../lib/market/data-visibility";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Supabase production credentials are unavailable");
const supabaseUrl = url;
const serviceRoleKey = key;

async function main() {
	const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
	const { data: products, error: productError } = await sb
		.from("products")
		.select("id,name,description")
		.order("created_at", { ascending: false });
	if (productError) throw productError;

	const visibleResearch = filterMarketRecords(products ?? []);
	const discovery: Record<string, unknown> = {};
	const [{ data: broadcasts, error: broadcastError }, { data: screenplays, error: screenplayError }] =
		await Promise.all([
			sb
				.from("broadcasts")
				.select("id,channel,air_date,program_title,description,source_url")
				.order("air_date", { ascending: false })
				.limit(1000),
			sb
				.from("screenplays")
				.select("id,title,product_id,product_info_snapshot,created_at")
				.order("created_at", { ascending: false })
				.limit(500),
		]);
	if (broadcastError) throw broadcastError;
	if (screenplayError) throw screenplayError;
	const visibleBroadcasts = filterMarketRecords(broadcasts ?? []);
	const visibleScreenplays = filterMarketRecords(screenplays ?? []);
	if (visibleBroadcasts.some(isKoreanMarketRecord)) {
		throw new Error("Korean broadcasts remain visible in the Japanese profile");
	}
	if (visibleScreenplays.some(isKoreanMarketRecord)) {
		throw new Error("Korean screenplays remain visible in the Japanese profile");
	}

	for (const context of ["home_shopping", "live_commerce"] as const) {
		const { data: runs, error: runError } = await sb
			.from("discovery_runs")
			.select("id,run_at,status,context")
			.in("status", ["completed", "partial"])
			.eq("context", context)
			.order("run_at", { ascending: false })
			.limit(20);
		if (runError) throw runError;

		const ids = (runs ?? []).map((run) => run.id);
		const { data: rows, error: rowsError } = await sb
			.from("discovered_products")
			.select("session_id,name,product_url,tv_fit_reason")
			.in("session_id", ids)
			.limit(5000);
		if (rowsError) throw rowsError;

		const rowsByRun = new Map<string, typeof rows>();
		for (const row of rows ?? []) {
			const batch = rowsByRun.get(row.session_id) ?? [];
			batch.push(row);
			rowsByRun.set(row.session_id, batch);
		}
		const selected = (runs ?? []).find(
			(run) => filterMarketBatchRecords(rowsByRun.get(run.id) ?? []).length > 0,
		);
		const selectedRows = selected
			? filterMarketBatchRecords(rowsByRun.get(selected.id) ?? [])
			: [];

		discovery[context] = {
			selectedRun: selected?.id ?? null,
			runAt: selected?.run_at ?? null,
			visibleCount: selectedRows.length,
			koreanVisibleCount: selectedRows.filter(isKoreanMarketRecord).length,
			samples: selectedRows.slice(0, 3).map((row) => row.name),
		};
	}

	console.log(JSON.stringify({
		research: {
			originalCount: products?.length ?? 0,
			visibleCount: visibleResearch.length,
			koreanVisibleCount: visibleResearch.filter(isKoreanMarketRecord).length,
			visibleNames: visibleResearch.map((product) => product.name),
		},
		broadcasts: {
			originalCount: broadcasts?.length ?? 0,
			visibleCount: visibleBroadcasts.length,
			hiddenKoreanCount: (broadcasts?.length ?? 0) - visibleBroadcasts.length,
			visibleChannels: [...new Set(visibleBroadcasts.map((row) => row.channel))],
		},
		screenplays: {
			originalCount: screenplays?.length ?? 0,
			visibleCount: visibleScreenplays.length,
			hiddenKoreanCount: (screenplays?.length ?? 0) - visibleScreenplays.length,
			visibleTitles: visibleScreenplays.map((row) => row.title),
		},
		discovery,
	}, null, 2));
}

void main();
