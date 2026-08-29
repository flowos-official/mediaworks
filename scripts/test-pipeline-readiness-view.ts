import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { IntelligenceReadiness } from "../lib/intelligence/readiness";

const copy = {
	title: "データ準備状況",
	description: "収集・正規化・根拠・洞察の現在の準備状況です。",
	sources: "データソース",
	coverage: "カバレッジ",
	categories: "カテゴリ別の放送分析",
	failures: "最近の失敗",
	noFailures: "最近の失敗はありません。",
	notRequestedIsNormal: "推薦、Research、台本の実行が0件でも、データパイプラインの失敗ではありません。必要になった時点で実行します。",
	generatedAt: "集計時刻",
	latestAttempt: "最新試行",
	latestSuccess: "最新成功",
	statusLabel: "状態",
	status: {
		healthy: "正常",
		stale: "期限超過",
		failed: "失敗",
		missing: "未実行",
	},
	metric: {
		canonicalLink: "統合商品リンク",
		category: "カテゴリ正規化",
		broadcastAnalysis: "放送分析",
		evidence: "根拠アイテム",
		insights: "洞察スナップショット",
	},
	categoryColumns: {
		category: "カテゴリ",
		analyzed: "分析済み",
		total: "アーカイブ",
		coverage: "分析率",
	},
	noCategories: "分析対象のアーカイブ放送はまだありません。",
	failureColumns: {
		source: "ソース",
		startedAt: "発生時刻",
		error: "内容",
	},
	noData: "—",
	sourcesByKey: {
		discovery_home_shopping: "ホームショッピング発掘",
		discovery_live_commerce: "ライブコマース発掘",
		broadcast_schedule: "放送編成収集",
		historical_broadcast_crawl: "過去放送収集",
		broadcast_video_archive: "放送映像アーカイブ",
		broadcast_audio_analysis: "放送音声分析",
		intelligence_foundation_backfill: "インテリジェンス基盤バックフィル",
		intelligence_insight_refresh: "インサイト更新",
	},
};

const readiness: IntelligenceReadiness = {
	generatedAt: "2026-08-29T12:00:00.000Z",
	sources: [
		{
			key: "discovery_home_shopping",
			latestAttemptAt: "2026-08-29T11:00:00.000Z",
			latestSuccessAt: "2026-08-29T11:01:00.000Z",
			status: "healthy",
			detail: "discovery/home_shopping: daily (26h tolerance).",
		},
		{
			key: "broadcast_audio_analysis",
			latestAttemptAt: "2026-08-29T10:00:00.000Z",
			latestSuccessAt: "2026-08-29T09:00:00.000Z",
			status: "failed",
			detail: "broadcast_archive/audio_analysis: daily (26h tolerance).",
		},
	],
	coverage: {
		activeProducts: 10,
		canonicalLinked: 8,
		canonicalLinkPct: 80,
		categorizedActive: 5,
		categoryPct: null,
		archivedBroadcasts: 3,
		analyzedBroadcasts: 1,
		analysisPct: 33,
		evidenceItems: 12,
		insightSnapshots: 2,
	},
	categorySamples: [
		{ category: "B: measured", total: 10, analyzed: 2, pct: 20 },
		{ category: "C: lowest measured", total: 10, analyzed: 1, pct: 10 },
		{ category: "A: no denominator", total: 0, analyzed: 0, pct: null },
	],
	failures: [
		{
			sourceType: "broadcast_archive",
			jobType: "audio_analysis",
			errorCode: "timeout",
			errorSummary: "audio worker timed out",
			startedAt: "2026-08-29T10:00:00.000Z",
		},
	],
};

async function main() {
	const pagePath = path.join(process.cwd(), "app", "[locale]", "(market)", "analytics", "pipeline", "page.tsx");
	const pageSource = await readFile(pagePath, "utf8");

	assert.doesNotMatch(
		pageSource,
		/<DataIntelligenceFlow\b/,
		"Pipeline page must not render the static DataIntelligenceFlow vision.",
	);
	assert.match(
		pageSource,
		/import\s+\{\s*DataReadinessDashboard(?:\s*,[^}]*)?\s*\}\s+from\s+["']@\/components\/pipeline\/DataReadinessDashboard["']/,
		"Pipeline page must import the live readiness dashboard.",
	);
	assert.match(
		pageSource,
		/<KanbanBoard\b/,
		"Pipeline page must retain the product selection Kanban board.",
	);
	assert.match(
		pageSource,
		/loadIntelligenceReadiness\(getServiceClient\(\), new Date\(\)\)/,
		"Pipeline page must load readiness directly with the service client.",
	);
	assert.match(
		pageSource,
		/Promise\.all\(\[boardPromise, readinessPromise\]\)/,
		"Pipeline board and readiness loads must start in parallel.",
	);
	assert.doesNotMatch(
		pageSource,
		/fetch\(["']\/api\/intelligence\/status/,
		"Pipeline page must not fetch the internal intelligence status API.",
	);
	assert.doesNotMatch(
		pageSource,
		/(?:failed|failure|readiness)[\s\S]{0,160}\bboard\b[\s\S]{0,160}\.length|\bboard\b[\s\S]{0,160}\.length[\s\S]{0,160}(?:failed|failure|readiness)/i,
		"An empty product selection board must not be interpreted as failed intelligence readiness.",
	);

	const { DataReadinessDashboard } = await import("../components/pipeline/DataReadinessDashboard");
	const props = { readiness, copy, locale: "ja" } as Parameters<typeof DataReadinessDashboard>[0];
	const markup = renderToStaticMarkup(DataReadinessDashboard(props));
	assert.match(markup, /カテゴリ正規化/, "Coverage metrics must include category normalization.");
	assert.match(markup, />—</, "Null coverage must render as an em dash, not zero percent.");
	assert.match(markup, /aria-label="状態: 失敗"/, "Failed source status must have an accessible text label.");
	assert.ok(
		markup.indexOf("A: no denominator") < markup.indexOf("C: lowest measured")
			&& markup.indexOf("C: lowest measured") < markup.indexOf("B: measured"),
		"Category samples must show insufficient coverage before measured percentages, then ascending percentage.",
	);
	assert.match(markup, /推薦、Research、台本の実行が0件でも/, "On-demand runs must be explained as normal.");

	const noFailuresMarkup = renderToStaticMarkup(DataReadinessDashboard({ ...props, readiness: { ...readiness, failures: [] } }));
	assert.match(noFailuresMarkup, /最近の失敗はありません。/, "An empty failure list must render its truthful normal state.");

	console.log("PASS: pipeline readiness page structure");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
