import { getServiceClient } from "../lib/supabase";

async function main() {
	const sb = getServiceClient();

	console.log("=== broadcasts diagnostic ===\n");

	// 전체 카운트
	const { count: total } = await sb
		.from("broadcasts")
		.select("*", { count: "exact", head: true });
	console.log(`Total rows: ${total ?? 0}`);

	// 어제/오늘 (UTC 기준)
	const today = new Date().toISOString().slice(0, 10);
	const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

	for (const date of [today, yesterday]) {
		const { data, count } = await sb
			.from("broadcasts")
			.select("channel", { count: "exact" })
			.eq("air_date", date);
		const byCh = (data ?? []).reduce<Record<string, number>>(
			(acc, r: { channel: string }) => {
				acc[r.channel] = (acc[r.channel] ?? 0) + 1;
				return acc;
			},
			{},
		);
		console.log(
			`${date}: total=${count ?? 0}, shopch=${byCh.shopch ?? 0}, qvc=${byCh.qvc ?? 0}`,
		);
	}

	// 최근 24시간 스크레이프
	const since = new Date(Date.now() - 86_400_000).toISOString();
	const { count: recent } = await sb
		.from("broadcasts")
		.select("*", { count: "exact", head: true })
		.gte("scraped_at", since);
	console.log(`\nScraped in last 24h: ${recent ?? 0}`);

	// 필드 충전율 (최근 1000행 샘플)
	const { data: sample } = await sb
		.from("broadcasts")
		.select("presenter,description,thumbnail_url")
		.order("scraped_at", { ascending: false })
		.limit(1000);
	if (sample && sample.length > 0) {
		type CoverageRow = {
			presenter: string | null;
			description: string | null;
			thumbnail_url: string | null;
		};
		const rows = sample as CoverageRow[];
		const n = rows.length;
		const pres = rows.filter((r) => r.presenter).length / n;
		const desc = rows.filter((r) => r.description).length / n;
		const thumb = rows.filter((r) => r.thumbnail_url).length / n;
		console.log(`\nField coverage (recent ${n} rows):`);
		console.log(`  presenter:     ${(pres * 100).toFixed(1)}%`);
		console.log(`  description:   ${(desc * 100).toFixed(1)}%`);
		console.log(`  thumbnail_url: ${(thumb * 100).toFixed(1)}%`);
	}
}

main().catch((e) => { console.error(e); process.exit(1); });
