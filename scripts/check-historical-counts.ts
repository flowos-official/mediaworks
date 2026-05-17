import { createClient } from "@supabase/supabase-js";

const sb = createClient(
	process.env.NEXT_PUBLIC_SUPABASE_URL!,
	process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

(async () => {
	const today = new Date(new Date().getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
	const [y, m] = today.split("-").map((x) => parseInt(x, 10));
	const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
	const monthFrom = today.slice(0, 7) + "-01";
	const monthTo = today.slice(0, 7) + "-" + String(last).padStart(2, "0");
	console.log("month range: " + monthFrom + " ~ " + monthTo + "\n");

	const channels = ["japanet", "junsanpo", "ntv", "tbs", "dinos", "senobura", "uranoura"];
	let monthTotal = 0;
	for (const c of channels) {
		const { count: monthCount } = await sb
			.from("historical_broadcasts")
			.select("id", { count: "exact", head: true })
			.eq("channel", c)
			.gte("air_date", monthFrom)
			.lte("air_date", monthTo);
		const { count: allCount } = await sb
			.from("historical_broadcasts")
			.select("id", { count: "exact", head: true })
			.eq("channel", c);
		monthTotal += monthCount ?? 0;
		console.log(c.padEnd(10) + " thisMonth=" + (monthCount ?? 0) + "  all=" + (allCount ?? 0));
	}
	console.log("\nthis month total:", monthTotal);
})();
