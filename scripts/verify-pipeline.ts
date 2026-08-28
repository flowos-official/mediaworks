/**
 * One command that answers "is the nightly pipeline actually running?".
 *
 * Every stage here is driven by a Vercel cron, and for a month the answer was
 * no — the crons were disabled on this project while two sibling projects on
 * the same database fired them instead, one with a dead API key. That took days
 * to see because each stage had to be queried by hand. This prints all of them
 * at once, with the age of the last successful run against how often it is
 * supposed to happen.
 *
 * Run: npm run verify:pipeline
 * Exits 1 if any stage is stale, so it can gate a deploy or a morning check.
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
	process.env.NEXT_PUBLIC_SUPABASE_URL!,
	process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const HOUR = 3_600_000;

interface Stage {
	name: string;
	/** UTC cron expression, shown so a stale row can be matched to its schedule. */
	schedule: string;
	/** Older than this and the stage is stale. Allows one missed run plus slack. */
	maxAgeMs: number;
	probe: () => Promise<{ at: string | null; detail: string }>;
}

async function latestRun(context: string) {
	const { data } = await sb
		.from("discovery_runs")
		.select("run_at, completed_at, status, produced_count, error")
		.eq("context", context)
		.order("run_at", { ascending: false })
		.limit(5);
	const rows = data ?? [];
	const ok = rows.find((r) => r.status === "completed" || r.status === "partial");
	const newest = rows[0];
	const failedSince = ok
		? rows.filter((r) => r.status === "failed" && r.run_at > ok.run_at).length
		: rows.filter((r) => r.status === "failed").length;
	return {
		at: ok?.run_at ?? null,
		detail: [
			ok ? `${ok.status}, ${ok.produced_count}건` : "성공 기록 없음",
			newest && newest !== ok ? `최근=${newest.status}` : "",
			failedSince ? `이후 실패 ${failedSince}건` : "",
		]
			.filter(Boolean)
			.join(" · "),
	};
}

const STAGES: Stage[] = [
	{
		name: "발굴 / home_shopping",
		schedule: "0 23 * * *",
		maxAgeMs: 26 * HOUR,
		probe: () => latestRun("home_shopping"),
	},
	{
		name: "발굴 / live_commerce",
		schedule: "30 23 * * *",
		maxAgeMs: 26 * HOUR,
		probe: () => latestRun("live_commerce"),
	},
	{
		name: "OA 채널 크롤",
		schedule: "0 8 / 30 16 * * *",
		maxAgeMs: 20 * HOUR,
		probe: async () => {
			const { data } = await sb
				.from("historical_crawl_runs")
				.select("run_at, status, total_rows, upserted")
				.eq("status", "completed")
				.order("run_at", { ascending: false })
				.limit(1)
				.maybeSingle();
			return {
				at: data?.run_at ?? null,
				detail: data ? `${data.total_rows}행 수집 / ${data.upserted}건 반영` : "성공 기록 없음",
			};
		},
	},
	{
		name: "방송 캘린더 수집",
		schedule: "0 16 / 0 17 * * *",
		maxAgeMs: 26 * HOUR,
		probe: async () => {
			const { data } = await sb
				.from("broadcasts")
				.select("scraped_at")
				.order("scraped_at", { ascending: false })
				.limit(1)
				.maybeSingle();
			const { data: furthest } = await sb
				.from("broadcasts")
				.select("air_date")
				.order("air_date", { ascending: false })
				.limit(1)
				.maybeSingle();
			return {
				at: data?.scraped_at ?? null,
				detail: furthest ? `편성 확보: ${furthest.air_date}까지` : "",
			};
		},
	},
	{
		name: "영상 아카이브",
		schedule: "0 */2 * * *",
		maxAgeMs: 30 * HOUR,
		probe: async () => {
			const { data } = await sb
				.from("broadcasts")
				.select("video_downloaded_at")
				.not("video_downloaded_at", "is", null)
				.order("video_downloaded_at", { ascending: false })
				.limit(1)
				.maybeSingle();
			const { count: queued } = await sb
				.from("broadcasts")
				.select("id", { count: "exact", head: true })
				.eq("video_status", "queued");
			const { count: archived } = await sb
				.from("broadcasts")
				.select("id", { count: "exact", head: true })
				.not("archived_video_s3", "is", null);
			return {
				at: data?.video_downloaded_at ?? null,
				detail: `보관 ${archived ?? 0}건 · 대기열 ${queued ?? 0}건`,
			};
		},
	},
	{
		name: "학습 상태 갱신",
		schedule: "45 22 * * *",
		maxAgeMs: 50 * HOUR,
		probe: async () => {
			const { data } = await sb
				.from("learning_state")
				.select("updated_at, context, feedback_sample_size")
				.order("updated_at", { ascending: false })
				.limit(1)
				.maybeSingle();
			return {
				at: data?.updated_at ?? null,
				detail: data ? `${data.context} · 피드백 ${data.feedback_sample_size}건` : "",
			};
		},
	},
];

function age(from: string): { ms: number; text: string } {
	const ms = Date.now() - new Date(from).getTime();
	const h = ms / HOUR;
	return { ms, text: h < 48 ? `${h.toFixed(1)}시간` : `${(h / 24).toFixed(1)}일` };
}

(async () => {
	const now = new Date();
	console.log(`점검 시각: ${now.toISOString().replace("T", " ").slice(0, 19)}Z`);
	console.log("크론 스케줄은 UTC 기준입니다 (23:00 UTC = 08:00 KST)\n");

	let stale = 0;
	for (const s of STAGES) {
		const { at, detail } = await s.probe();
		if (!at) {
			stale += 1;
			console.log(`  [기록없음] ${s.name.padEnd(22)} ${s.schedule.padEnd(20)} ${detail}`);
			continue;
		}
		const a = age(at);
		const ok = a.ms <= s.maxAgeMs;
		if (!ok) stale += 1;
		console.log(
			`  [${ok ? "정상" : "지연"}]     ${s.name.padEnd(22)} ${s.schedule.padEnd(20)} ` +
				`${a.text.padStart(8)} 전 · ${detail}`,
		);
	}

	console.log(
		stale === 0
			? "\n전 단계 정상입니다."
			: `\n${stale}개 단계가 지연 상태입니다. 어느 프로젝트가 크론을 쏘는지부터 확인하세요:\n` +
					"  vercel logs --project mediaworks --scope flow-os --since 30m\n" +
					"  크론 자체가 꺼져 있는지: GET /v9/projects/{id} 의 crons.disabledAt",
	);
	process.exit(stale === 0 ? 0 : 1);
})();
