import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import type { IntelligenceReadiness } from "../lib/intelligence/readiness";
import type { ReadinessDashboardCopy } from "../components/pipeline/DataReadinessDashboard";

/**
 * The copy is read from the shipped message files rather than restated here.
 * A literal would keep passing after a key was renamed or dropped, and
 * `t.raw("readiness")` in the page is an assertion, so this is the only place
 * the component's key usage is checked against what the app actually ships.
 */
async function loadCopy(locale: "ja" | "ko"): Promise<ReadinessDashboardCopy> {
	const file = path.join(process.cwd(), "messages", `${locale}.json`);
	const messages = JSON.parse(await readFile(file, "utf8")) as {
		pipeline?: { readiness?: unknown };
	};
	const readinessCopy = messages.pipeline?.readiness;
	assert.ok(readinessCopy, `messages/${locale}.json must define pipeline.readiness`);
	return readinessCopy as ReadinessDashboardCopy;
}

/** Every leaf the component reads must exist in both locales, not just the default. */
function assertSameShape(left: unknown, right: unknown, trail: string): void {
	if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
		assert.equal(typeof left, typeof right, `${trail} must have the same type in both locales`);
		return;
	}
	const leftKeys = Object.keys(left as Record<string, unknown>).sort();
	const rightKeys = Object.keys(right as Record<string, unknown>).sort();
	assert.deepEqual(leftKeys, rightKeys, `${trail} must define the same keys in ja and ko`);
	for (const key of leftKeys) {
		assertSameShape(
			(left as Record<string, unknown>)[key],
			(right as Record<string, unknown>)[key],
			`${trail}.${key}`,
		);
	}
}

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
	assert.doesNotMatch(
		pageSource,
		/getServiceClient/,
		"Pipeline page is user-reachable, so readiness must not bypass RLS with the service client.",
	);
	assert.match(
		pageSource,
		/loadIntelligenceReadiness\(sb, new Date\(\)\)/,
		"Pipeline page must load readiness as the signed-in user so RLS applies.",
	);
	assert.match(
		pageSource,
		/canWrite \? loadReadiness\(auth\.sb\) : Promise\.resolve\(null\)/,
		"A viewer cannot read the Group B readiness sources, so the loader must be skipped for them.",
	);
	assert.match(
		pageSource,
		/Promise\.all\(\[\s*loadBoard\(auth\.sb\),/,
		"Pipeline board and readiness loads must start in parallel.",
	);
	assert.match(
		pageSource,
		/catch \(err\) \{[\s\S]*?return null;/,
		"Readiness is secondary to the board: its failure must degrade the panel, not the page.",
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
	const copy = await loadCopy("ja");
	assertSameShape(copy, await loadCopy("ko"), "pipeline.readiness");
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
	assert.equal(
		$("[data-readiness-failure-summary]").length,
		0,
		"error_summary is unvetted third-party text and is revoked from `authenticated`; only our own error_code is shown.",
	);
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
			failures: [{ ...readiness.failures[0], errorCode: null }],
		},
	}));
	const emptyFieldMarkupDocument = load(emptyFieldMarkup);
	assert.equal(emptyFieldMarkupDocument("[data-readiness-source-detail]").text(), "—", "An empty source detail must use the safe empty fallback.");
	assert.equal(emptyFieldMarkupDocument("[data-readiness-failure-code]").text(), "—", "A missing failure error code must use the safe empty fallback.");
	assert.equal(emptyFieldMarkupDocument("[data-readiness-failure-summary]").length, 0, "Raw third-party error text is revoked at the database and must not be rendered.");

	const noFailuresMarkup = renderToStaticMarkup(DataReadinessDashboard({ ...props, readiness: { ...readiness, failures: [] } }));
	assert.match(noFailuresMarkup, /最近の失敗はありません。/, "An empty failure list must render its truthful normal state.");

	console.log("PASS: pipeline readiness page structure");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
