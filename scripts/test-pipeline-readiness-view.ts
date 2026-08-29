import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
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
	sourceDetail: "詳細",
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
		errorCode: "エラーコード",
		errorSummary: "概要",
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
		canonicalLinkPct: null,
		categorizedActive: 5,
		categoryPct: null,
		archivedBroadcasts: 3,
		analyzedBroadcasts: 1,
		analysisPct: Number.NaN,
		evidenceItems: 12,
		insightSnapshots: 2,
	},
	categorySamples: [
		{ category: "B: measured", total: 10, analyzed: 2, pct: 20 },
		{ category: "C: lowest measured", total: 10, analyzed: 1, pct: 10 },
		{ category: "A: no denominator", total: 0, analyzed: 0, pct: null },
		{ category: "D: NaN", total: 10, analyzed: 0, pct: Number.NaN },
		{ category: "E: positive infinity", total: 10, analyzed: 0, pct: Number.POSITIVE_INFINITY },
		{ category: "F: negative infinity", total: 10, analyzed: 0, pct: Number.NEGATIVE_INFINITY },
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

	const { DataReadinessDashboard, sortReadinessCategorySamples } = await import("../components/pipeline/DataReadinessDashboard");
	const sortProbe = [
		{ category: "Zulu finite", total: 10, analyzed: 2, pct: 20 },
		{ category: "Beta NaN", total: 10, analyzed: 0, pct: Number.NaN },
		{ category: "Gamma positive infinity", total: 10, analyzed: 0, pct: Number.POSITIVE_INFINITY },
		{ category: "Alpha undefined", total: 0, analyzed: 0, pct: undefined },
		{ category: "Delta negative infinity", total: 10, analyzed: 0, pct: Number.NEGATIVE_INFINITY },
		{ category: "Epsilon null", total: 0, analyzed: 0, pct: null },
		{ category: "Beta finite tie", total: 10, analyzed: 5, pct: 50 },
		{ category: "Alpha finite tie", total: 10, analyzed: 5, pct: 50 },
	] as unknown as IntelligenceReadiness["categorySamples"];
	const sortProbeInputOrder = sortProbe.map((sample) => sample.category);
	assert.deepEqual(
		sortReadinessCategorySamples(sortProbe).map((sample) => sample.category),
		[
			"Alpha undefined",
			"Beta NaN",
			"Delta negative infinity",
			"Epsilon null",
			"Gamma positive infinity",
			"Zulu finite",
			"Alpha finite tie",
			"Beta finite tie",
		],
		"Category sorting must put every insufficient percentage first, then finite percentages and deterministic category ties.",
	);
	assert.deepEqual(
		sortProbe.map((sample) => sample.category),
		sortProbeInputOrder,
		"Category sorting must not mutate readiness props.",
	);
	const props = { readiness, copy, locale: "ja" } as Parameters<typeof DataReadinessDashboard>[0];
	const markup = renderToStaticMarkup(DataReadinessDashboard(props));
	const $ = load(markup);
	const metricValue = (key: string) => {
		const metric = $(`[data-readiness-metric="${key}"]`);
		assert.equal(metric.length, 1, `Expected one rendered ${key} coverage metric.`);
		return metric.find("[data-readiness-metric-value]").text();
	};
	assert.match(markup, /カテゴリ正規化/, "Coverage metrics must include category normalization.");
	assert.equal(metricValue("canonical-link"), "—", "Null canonical-link coverage must render as an em dash, never 0%.");
	assert.equal(metricValue("category"), "—", "Null category coverage must render as an em dash, never 0%.");
	assert.equal(metricValue("broadcast-analysis"), "—", "NaN broadcast-analysis coverage must render as an em dash.");
	assert.equal($("[data-readiness-category='D: NaN'] td").last().text(), "—", "NaN category coverage must render as an em dash.");
	assert.equal($("[data-readiness-category='E: positive infinity'] td").last().text(), "—", "Positive infinite category coverage must render as an em dash.");
	assert.equal($("[data-readiness-category='F: negative infinity'] td").last().text(), "—", "Negative infinite category coverage must render as an em dash.");
	assert.match(markup, /aria-label="状態: 失敗"/, "Failed source status must have an accessible text label.");
	assert.match(markup, /discovery\/home_shopping: daily \(26h tolerance\)\./, "Source cards must render readiness detail.");
	assert.match(markup, /timeout/, "Failure rows must render a non-null error code.");
	assert.match(markup, /audio worker timed out/, "Failure rows must render a non-null error summary.");
	assert.ok(
		markup.indexOf("A: no denominator") < markup.indexOf("C: lowest measured")
			&& markup.indexOf("C: lowest measured") < markup.indexOf("B: measured"),
		"Category samples must show insufficient coverage before measured percentages, then ascending percentage.",
	);
	assert.match(markup, /推薦、Research、台本の実行が0件でも/, "On-demand runs must be explained as normal.");

	const emptyFieldMarkup = renderToStaticMarkup(DataReadinessDashboard({
		...props,
		readiness: {
			...readiness,
			sources: [{ ...readiness.sources[0], detail: "" }],
			failures: [{ ...readiness.failures[0], errorCode: null, errorSummary: null }],
		},
	}));
	const emptyFieldMarkupDocument = load(emptyFieldMarkup);
	assert.equal(emptyFieldMarkupDocument("[data-readiness-source-detail]").text(), "—", "An empty source detail must use the safe empty fallback.");
	assert.equal(emptyFieldMarkupDocument("[data-readiness-failure-code]").text(), "—", "A missing failure error code must use the safe empty fallback.");
	assert.equal(emptyFieldMarkupDocument("[data-readiness-failure-summary]").text(), "—", "A missing failure error summary must use the safe empty fallback.");

	const noFailuresMarkup = renderToStaticMarkup(DataReadinessDashboard({ ...props, readiness: { ...readiness, failures: [] } }));
	assert.match(noFailuresMarkup, /最近の失敗はありません。/, "An empty failure list must render its truthful normal state.");

	console.log("PASS: pipeline readiness page structure");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
