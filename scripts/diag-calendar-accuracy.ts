/**
 * One-off read-only diagnostic for the broadcast-calendar accuracy report:
 *   "products that did NOT air on a given day are shown, OR airing products
 *    are not shown."
 *
 * Tests two hypotheses against live data:
 *   (c) null-category QVC/ShopCh slots are hidden by the UI whitelist gate
 *       (UnifiedDayDetailPanel.isWhitelistedSlot) -> "airing but not shown"
 *   (d) today/future JST slots are sparse vs past -> monthly-refresh gap
 *
 * Usage: tsx --env-file=.env.local scripts/diag-calendar-accuracy.ts
 */
import { getServiceClient } from "../lib/supabase";

function jstDateStr(offsetDays: number): string {
	// JST = UTC+9. Shift now into JST wall-clock, then take the calendar date.
	const jstMs = Date.now() + 9 * 3600 * 1000 + offsetDays * 86_400_000;
	return new Date(jstMs).toISOString().slice(0, 10);
}

async function main() {
	const sb = getServiceClient();

	console.log("=== calendar accuracy diagnostic ===");
	console.log(`UTC now date  : ${new Date().toISOString().slice(0, 10)}`);
	console.log(`JST today     : ${jstDateStr(0)}`);
	console.log(`(MonthGrid uses the UTC date for its "today" highlight)\n`);

	// Window: 5 days back .. 14 days forward (JST)
	const from = jstDateStr(-5);
	const to = jstDateStr(14);

	const { data, error } = await sb
		.from("broadcasts")
		.select("channel,air_date,start_time,category,program_title,video_status")
		.gte("air_date", from)
		.lte("air_date", to)
		.in("channel", ["qvc", "shopch"])
		.order("air_date", { ascending: true });

	if (error) {
		console.error("query failed:", error);
		process.exit(1);
	}

	const rows = data ?? [];
	console.log(`window ${from} .. ${to}: ${rows.length} qvc+shopch rows\n`);

	// Per-date, per-channel: total vs null-category (hidden by UI gate)
	type Agg = { total: number; nullCat: number };
	const byDate = new Map<string, { qvc: Agg; shopch: Agg }>();
	for (const r of rows) {
		const slot = byDate.get(r.air_date) ?? {
			qvc: { total: 0, nullCat: 0 },
			shopch: { total: 0, nullCat: 0 },
		};
		const ch = r.channel as "qvc" | "shopch";
		slot[ch].total += 1;
		if (r.category == null || r.category === "") slot[ch].nullCat += 1;
		byDate.set(r.air_date, slot);
	}

	const todayJst = jstDateStr(0);
	console.log("date        | qvc total/null-hidden | shopch total/null-hidden");
	console.log("------------|-----------------------|--------------------------");
	for (const date of [...byDate.keys()].sort()) {
		const s = byDate.get(date)!;
		const mark = date === todayJst ? " <- JST today" : "";
		console.log(
			`${date}  |   ${String(s.qvc.total).padStart(3)} / ${String(s.qvc.nullCat).padStart(3)} hidden    |   ${String(s.shopch.total).padStart(3)} / ${String(s.shopch.nullCat).padStart(3)} hidden${mark}`,
		);
	}

	// Hypothesis (c): how many airing slots would be invisible?
	const nullCatTotal = rows.filter(
		(r) => r.category == null || r.category === "",
	).length;
	console.log(
		`\n[c] null/empty-category qvc+shopch slots in window (hidden by UI gate): ${nullCatTotal} / ${rows.length}`,
	);
	// Sample a few hidden slots so we can confirm they are real airing programs
	const sampleHidden = rows
		.filter((r) => r.category == null || r.category === "")
		.slice(0, 8);
	if (sampleHidden.length) {
		console.log("  sample hidden slots (real programs that won't display):");
		for (const r of sampleHidden) {
			console.log(
				`    ${r.air_date} ${r.start_time} ${r.channel} "${(r.program_title ?? "").slice(0, 40)}" video=${r.video_status}`,
			);
		}
	}

	// Hypothesis (d): today/future coverage vs past
	const todayCount = (byDate.get(todayJst)?.qvc.total ?? 0) +
		(byDate.get(todayJst)?.shopch.total ?? 0);
	const futureDates = [...byDate.keys()].filter((d) => d > todayJst);
	console.log(
		`\n[d] JST today (${todayJst}) qvc+shopch slots: ${todayCount}; future dates with any data: ${futureDates.length}`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
