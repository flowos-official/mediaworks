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
import { execFile } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import {
	classifyStageHealth,
	isCronDiscoveryRun,
	latestRunProbe,
	parseLatestVercelInvocation,
	type VercelInvocation,
} from "../lib/cron/pipeline-health";

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
	probe: () => Promise<{ at: string | null; detail: string; sourceHealthy?: boolean }>;
}

async function latestRun(context: string) {
	const { data, error } = await sb
		.from("discovery_runs")
		.select("run_at, completed_at, status, produced_count, category_plan, error")
		.eq("context", context)
		.or("produced_count.eq.0,category_plan.not.is.null")
		.order("run_at", { ascending: false })
		.limit(5);
	if (error) {
		return { at: null, sourceHealthy: false, detail: `조회 실패: ${error.message}` };
	}
	const rows = (data ?? []).filter(isCronDiscoveryRun);
	const run = latestRunProbe(rows, new Set(["completed", "partial"]));
	const ok = rows.find((row) => row.run_at === run.at);
	return {
		at: run.at ?? run.latestAt,
		sourceHealthy: run.healthy,
		detail: [
			ok ? `${ok.status}, ${ok.produced_count}건` : "성공 기록 없음",
			run.latestStatus && run.latestAt !== run.at ? `최근=${run.latestStatus}` : "",
		]
			.filter(Boolean)
			.join(" · "),
	};
}

function latestArchiveInvocation(): Promise<VercelInvocation | null> {
	const project = process.env.VERCEL_PROJECT_NAME ?? "mediaworks";
	const scope = process.env.VERCEL_SCOPE ?? "flow-os";
	return new Promise((resolve, reject) => {
		execFile(
			"vercel",
			[
				"logs",
				"--project", project,
				"--scope", scope,
				"--environment", "production",
				"--since", "4h",
				"--json",
				"--limit", "300",
				"--no-branch",
				"--non-interactive",
			],
			{
				maxBuffer: 4 * 1024 * 1024,
				timeout: 30_000,
				killSignal: "SIGKILL",
			},
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error((stderr || error.message).trim()));
					return;
				}
				try {
					resolve(parseLatestVercelInvocation(stdout, "/api/cron/archive-videos"));
				} catch (parseError) {
					reject(parseError);
				}
			},
		);
	});
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
			const { data, error } = await sb
				.from("historical_crawl_runs")
				.select("run_at, status, total_rows, upserted")
				.order("run_at", { ascending: false })
				.limit(5);
			if (error) {
				return { at: null, sourceHealthy: false, detail: `조회 실패: ${error.message}` };
			}
			const rows = data ?? [];
			const run = latestRunProbe(rows, new Set(["completed"]));
			const ok = rows.find((row) => row.run_at === run.at);
			return {
				at: run.at ?? run.latestAt,
				sourceHealthy: run.healthy,
				detail: [
					ok ? `${ok.total_rows}행 수집 / ${ok.upserted}건 반영` : "성공 기록 없음",
					run.latestStatus && run.latestAt !== run.at ? `최근=${run.latestStatus}` : "",
				].filter(Boolean).join(" · "),
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
		maxAgeMs: 3 * HOUR,
		probe: async () => {
			const [queuedResult, downloadingResult, archivedResult] = await Promise.all([
				sb.from("broadcasts").select("id", { count: "exact", head: true }).eq("video_status", "queued"),
				sb.from("broadcasts").select("id", { count: "exact", head: true }).eq("video_status", "downloading"),
				sb.from("broadcasts").select("id", { count: "exact", head: true }).not("archived_video_s3", "is", null),
			]);
			const counts = `보관 ${archivedResult.count ?? 0}건 · 대기열 ${queuedResult.count ?? 0}건 · 다운로드중 ${downloadingResult.count ?? 0}건`;
			try {
				const invocation = await latestArchiveInvocation();
				if (!invocation) {
					return { at: null, sourceHealthy: false, detail: `최근 Vercel 실행 기록 없음 · ${counts}` };
				}
				return {
					at: invocation.at,
					sourceHealthy: invocation.healthy,
					detail: `HTTP ${invocation.statusCode}${invocation.message ? ` · ${invocation.message}` : ""} · ${counts}`,
				};
			} catch (error) {
				return {
					at: null,
					sourceHealthy: false,
					detail: `Vercel 로그 조회 실패: ${error instanceof Error ? error.message : String(error)} · ${counts}`,
				};
			}
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

	let unhealthy = 0;
	for (const s of STAGES) {
		const { at, detail, sourceHealthy = true } = await s.probe();
		const state = classifyStageHealth({
			at,
			sourceHealthy,
			maxAgeMs: s.maxAgeMs,
			nowMs: now.getTime(),
		});
		if (state !== "healthy") unhealthy += 1;
		if (!at) {
			console.log(`  [기록없음] ${s.name.padEnd(22)} ${s.schedule.padEnd(20)} ${detail}`);
			continue;
		}
		const a = age(at);
		const label = state === "healthy" ? "정상" : state === "stale" ? "지연" : "실패";
		console.log(
			`  [${label}]     ${s.name.padEnd(22)} ${s.schedule.padEnd(20)} ` +
				`${a.text.padStart(8)} 전 · ${detail}`,
		);
	}

	console.log(
		unhealthy === 0
			? "\n전 단계 정상입니다."
			: `\n${unhealthy}개 단계가 실패·지연 상태입니다. 어느 프로젝트가 크론을 쏘는지부터 확인하세요:\n` +
					"  vercel logs --project mediaworks --scope flow-os --since 30m\n" +
					"  크론 자체가 꺼져 있는지: GET /v9/projects/{id} 의 crons.disabledAt",
	);
	process.exit(unhealthy === 0 ? 0 : 1);
})();
