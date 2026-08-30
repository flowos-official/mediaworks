import assert from "node:assert/strict";

import {
	classifyReadiness,
	loadIntelligenceReadiness,
	percent,
} from "../lib/intelligence/readiness";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const HOUR = 3_600_000;

function iso(hoursAgo: number): string {
	return new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
}

function pipelineRun(input: {
	id: string;
	sourceType: string;
	jobType: string;
	status: "succeeded" | "partial" | "failed" | "running" | "queued";
	hoursAgo: number;
	externalRunId?: string | null;
	errorCode?: string | null;
	heartbeatHoursAgo?: number;
}) {
	return {
		id: input.id,
		source_type: input.sourceType,
		job_type: input.jobType,
		external_run_id: input.externalRunId ?? `external:${input.id}`,
		status: input.status,
		started_at: iso(input.hoursAgo),
		heartbeat_at: input.heartbeatHoursAgo === undefined ? null : iso(input.heartbeatHoursAgo),
		finished_at: input.status === "running" ? null : iso(Math.max(0, input.hoursAgo - 0.01)),
		error_code: input.errorCode ?? null,
	};
}

type Row = Record<string, unknown>;

class FakeReadinessClient {
	readonly calls: string[] = [];

	constructor(readonly rows: Record<string, Row[]>) {}

	from(table: string) {
		this.calls.push(`from:${table}`);
		return new FakeQuery(this, table);
	}
}

class FakeQuery implements PromiseLike<{ data: Row[] | null; error: { message: string } | null; count: number | null }> {
	private readonly equals = new Map<string, unknown>();
	private readonly includes = new Map<string, unknown[]>();
	private readonly notEquals = new Map<string, unknown>();
	private orderBy: { column: string; ascending: boolean } | null = null;
	private limitValue: number | null = null;
	private rangeValue: [number, number] | null = null;
	private countRequested = false;
	private head = false;

	constructor(private readonly client: FakeReadinessClient, private readonly table: string) {}

	select(_columns: string, options?: { count?: "exact"; head?: boolean }) {
		this.countRequested = options?.count === "exact";
		this.head = options?.head === true;
		this.client.calls.push(`${this.table}:select:${this.countRequested ? "count" : "rows"}:${this.head ? "head" : "body"}`);
		return this;
	}

	eq(column: string, value: unknown) {
		this.equals.set(column, value);
		this.client.calls.push(`${this.table}:eq:${column}:${String(value)}`);
		return this;
	}

	in(column: string, values: unknown[]) {
		this.includes.set(column, values);
		this.client.calls.push(`${this.table}:in:${column}:${values.join(",")}`);
		return this;
	}

	not(column: string, _operator: string, value: unknown) {
		this.notEquals.set(column, value);
		this.client.calls.push(`${this.table}:not:${column}:${String(value)}`);
		return this;
	}

	order(column: string, options?: { ascending?: boolean }) {
		this.orderBy = { column, ascending: options?.ascending ?? true };
		this.client.calls.push(`${this.table}:order:${column}:${this.orderBy.ascending ? "asc" : "desc"}`);
		return this;
	}

	limit(value: number) {
		this.limitValue = value;
		this.client.calls.push(`${this.table}:limit:${value}`);
		return this;
	}

	range(from: number, to: number) {
		this.rangeValue = [from, to];
		this.client.calls.push(`${this.table}:range:${from}:${to}`);
		return this;
	}

	async maybeSingle() {
		const result = this.execute();
		return { data: result.data?.[0] ?? null, error: result.error };
	}

	then<TResult1 = { data: Row[] | null; error: { message: string } | null; count: number | null }, TResult2 = never>(
		onfulfilled?: ((value: { data: Row[] | null; error: { message: string } | null; count: number | null }) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): PromiseLike<TResult1 | TResult2> {
		return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
	}

	private execute() {
		if (this.table === "evidence_items_missing") {
			return { data: null, error: { message: "relation evidence_items does not exist" }, count: null };
		}
		if (this.table === "evidence_items_unavailable_count") {
			return { data: null, error: null, count: null };
		}
		let data = [...(this.client.rows[this.table] ?? [])];
		for (const [column, value] of this.equals) data = data.filter((row) => row[column] === value);
		for (const [column, values] of this.includes) data = data.filter((row) => values.includes(row[column]));
		for (const [column, value] of this.notEquals) {
			if (value === null) data = data.filter((row) => row[column] !== null && row[column] !== undefined);
			else data = data.filter((row) => row[column] !== value);
		}
		if (this.orderBy) {
			const { column, ascending } = this.orderBy;
			data.sort((left, right) => String(left[column] ?? "").localeCompare(String(right[column] ?? "")) * (ascending ? 1 : -1));
		}
		const count = data.length;
		if (this.limitValue !== null) data = data.slice(0, this.limitValue);
		if (this.rangeValue) data = data.slice(this.rangeValue[0], this.rangeValue[1] + 1);
		return { data: this.head ? null : data, error: null, count: this.countRequested ? count : null };
	}
}

const normalRows: Record<string, Row[]> = {
	data_pipeline_runs: [
		pipelineRun({ id: "home-success", externalRunId: "discovery-session-home", sourceType: "discovery", jobType: "home_shopping", status: "succeeded", hoursAgo: 1 }),
		pipelineRun({ id: "home-old-failure", sourceType: "discovery", jobType: "home_shopping", status: "failed", hoursAgo: 30, errorCode: "home_old" }),
		pipelineRun({ id: "live-failure", sourceType: "discovery", jobType: "live_commerce", status: "failed", hoursAgo: 1, errorCode: "live_failed" }),
		pipelineRun({ id: "live-success", externalRunId: "discovery-session-live", sourceType: "discovery", jobType: "live_commerce", status: "succeeded", hoursAgo: 5 }),
		pipelineRun({ id: "other-discovery", sourceType: "discovery", jobType: "other", status: "succeeded", hoursAgo: 0.1 }),
		pipelineRun({ id: "schedule-success", sourceType: "qvc_shopch", jobType: "broadcast_schedule", status: "succeeded", hoursAgo: 2 }),
		pipelineRun({ id: "crawl-success", sourceType: "oa_channels", jobType: "historical_broadcast_crawl", status: "succeeded", hoursAgo: 2 }),
		pipelineRun({ id: "archive-success", sourceType: "qvc_shopch", jobType: "video_archive", status: "succeeded", hoursAgo: 1 }),
		pipelineRun({ id: "audio-partial", sourceType: "broadcast_archive", jobType: "audio_analysis", status: "partial", hoursAgo: 1, errorCode: "partial" }),
		pipelineRun({ id: "refresh-success", sourceType: "evidence_items", jobType: "insight_refresh", status: "succeeded", hoursAgo: 2 }),
		pipelineRun({ id: "backfill-success", sourceType: "intelligence_foundation", jobType: "intelligence_foundation_backfill", status: "succeeded", hoursAgo: 100 }),
		...Array.from({ length: 11 }, (_, index) => pipelineRun({
			id: `failure-${index}`,
			sourceType: "unrelated",
			jobType: "ignored",
			status: "failed",
			hoursAgo: 10 + index,
			errorCode: `failure_${index}`,
		})),
	],
	discovered_products: [
		{ id: "d-home", session_id: "discovery-session-home" },
		{ id: "d-shared", session_id: "discovery-session-home" },
		{ id: "d-unlinked", session_id: "discovery-session-home" },
		{ id: "d-shared", session_id: "discovery-session-live" },
		{ id: "d-live", session_id: "discovery-session-live" },
		{ id: "d-historical", session_id: "external:home-old-failure" },
	],
	product_source_links: [
		{ id: "link-home", source_type: "discovery", source_table: "discovered_products", source_record_id: "d-home", canonical_product_id: "canonical-home" },
		{ id: "link-shared", source_type: "discovery", source_table: "discovered_products", source_record_id: "d-shared", canonical_product_id: "canonical-home" },
		{ id: "link-live", source_type: "discovery", source_table: "discovered_products", source_record_id: "d-live", canonical_product_id: "canonical-live" },
		{ id: "link-historical", source_type: "discovery", source_table: "discovered_products", source_record_id: "d-historical", canonical_product_id: "canonical-historical" },
		{ id: "link-internal", source_type: "internal_excel", source_table: "import_rows", source_record_id: "internal-1", canonical_product_id: "canonical-internal" },
		{ id: "link-internal-repeat", source_type: "internal_excel", source_table: "import_rows", source_record_id: "internal-1-reimport", canonical_product_id: "canonical-internal" },
		{ id: "link-inactive", source_type: "internal_excel", source_table: "import_rows", source_record_id: "internal-inactive", canonical_product_id: "canonical-inactive" },
	],
	canonical_products: [
		{ id: "canonical-home", status: "active", normalized_category: "Beauty" },
		{ id: "canonical-live", status: "active", normalized_category: null },
		{ id: "canonical-historical", status: "active", normalized_category: "Historical" },
		{ id: "canonical-internal", status: "active", normalized_category: "Internal" },
		{ id: "canonical-inactive", status: "inactive", normalized_category: "Inactive" },
	],
	broadcasts: [
		{ id: "broadcast-1", archived_video_s3: "archive/1", category: "Beauty" },
		{ id: "broadcast-2", archived_video_s3: "archive/2", category: "Beauty" },
		{ id: "broadcast-3", archived_video_s3: "archive/3", category: "Electronics" },
		{ id: "broadcast-4", archived_video_s3: "archive/4", category: null },
		{ id: "broadcast-unarchived", archived_video_s3: null, category: "Beauty" },
	],
	broadcast_speech_analyses: [
		{ broadcast_id: "broadcast-1" },
		{ broadcast_id: "broadcast-1" },
		{ broadcast_id: "broadcast-3" },
		{ broadcast_id: "broadcast-unarchived" },
	],
	evidence_items: Array.from({ length: 7 }, (_, index) => ({ id: `evidence-${index}` })),
	insight_snapshots: Array.from({ length: 3 }, (_, index) => ({ id: `insight-${index}` })),
};

function withCrawlRun(crawl: Row, laterAttempt?: Row): Record<string, Row[]> {
	return {
		...normalRows,
		data_pipeline_runs: [
			...normalRows.data_pipeline_runs.filter((row) => row.id !== "crawl-success"),
			crawl,
			...(laterAttempt ? [laterAttempt] : []),
		],
	};
}

async function run(): Promise<void> {
	assert.equal(percent(0, 0), null, "an unknown denominator is not 0%");
	assert.equal(percent(95, 100), 95);
	assert.equal(percent(1, 3), 33, "percentages are rounded to integers");
	assert.equal(percent(2, 3), 67, "rounding is symmetric around the half point");
	assert.equal(percent(0, 4), 0);

	const classifierNow = NOW.getTime();
	assert.equal(classifyReadiness({ latestAttemptAt: iso(1), latestSuccessAt: iso(1), latestStatus: "succeeded", maxAgeMs: 26 * 3_600_000, nowMs: classifierNow }), "healthy");
	assert.equal(classifyReadiness({ latestAttemptAt: iso(27), latestSuccessAt: iso(27), latestStatus: "succeeded", maxAgeMs: 26 * 3_600_000, nowMs: classifierNow }), "stale");
	assert.equal(classifyReadiness({ latestAttemptAt: iso(26), latestSuccessAt: iso(26), latestStatus: "succeeded", maxAgeMs: 26 * 3_600_000, nowMs: classifierNow }), "healthy", "the cutoff is inclusive");
	assert.equal(classifyReadiness({ latestAttemptAt: iso(1), latestSuccessAt: iso(5), latestStatus: "failed", maxAgeMs: 26 * 3_600_000, nowMs: classifierNow }), "failed", "a latest failure stays failed despite a recent older success");
	// `partial` now means genuinely degraded rather than merely busy, so it gets
	// its own state. Folding it into `failed` put a red badge on healthy runs —
	// seven of the archive job's last nine, each with zero failures — beside an
	// empty failure table, which is how a signal stops being read.
	assert.equal(classifyReadiness({ latestAttemptAt: iso(1), latestSuccessAt: iso(5), latestStatus: "partial", maxAgeMs: 26 * 3_600_000, nowMs: classifierNow }), "degraded", "a partial latest attempt is degraded, not an outage");
	assert.equal(classifyReadiness({ latestAttemptAt: iso(0.01), latestSuccessAt: iso(5), latestStatus: "running", latestHeartbeatAt: iso(0.01), maxAgeMs: 26 * 3_600_000, nowMs: classifierNow }), "running", "a live run is in flight, not failed");
	assert.equal(classifyReadiness({ latestAttemptAt: iso(2), latestSuccessAt: iso(5), latestStatus: "running", latestHeartbeatAt: iso(2), maxAgeMs: 26 * 3_600_000, nowMs: classifierNow }), "failed", "a run whose heartbeat went quiet was killed, and says so");
	assert.equal(classifyReadiness({ latestAttemptAt: iso(0.01), latestSuccessAt: iso(5), latestStatus: "running", latestHeartbeatAt: null, maxAgeMs: 26 * 3_600_000, nowMs: classifierNow }), "running", "a run that has not beaten yet falls back to its start time");
	assert.equal(classifyReadiness({ latestAttemptAt: iso(2), latestSuccessAt: iso(5), latestStatus: "queued", latestHeartbeatAt: null, maxAgeMs: 26 * 3_600_000, nowMs: classifierNow }), "failed", "a queued run that never started is orphaned on the same threshold");
	assert.equal(classifyReadiness({ latestAttemptAt: null, latestSuccessAt: null, latestStatus: null, maxAgeMs: 26 * 3_600_000, nowMs: classifierNow }), "missing");
	assert.equal(classifyReadiness({ latestAttemptAt: new Date(classifierNow + 1_000).toISOString(), latestSuccessAt: new Date(classifierNow + 1_000).toISOString(), latestStatus: "succeeded", maxAgeMs: 26 * 3_600_000, nowMs: classifierNow }), "failed", "future clock skew is never fresh success");
	assert.equal(classifyReadiness({ latestAttemptAt: new Date(classifierNow - 20 * HOUR).toISOString(), latestSuccessAt: new Date(classifierNow - 20 * HOUR).toISOString(), latestStatus: "succeeded", maxAgeMs: 20 * HOUR, nowMs: classifierNow }), "healthy", "the twice-daily OA cutoff is inclusive at 20 hours");
	assert.equal(classifyReadiness({ latestAttemptAt: new Date(classifierNow - 20 * HOUR - 1).toISOString(), latestSuccessAt: new Date(classifierNow - 20 * HOUR - 1).toISOString(), latestStatus: "succeeded", maxAgeMs: 20 * HOUR, nowMs: classifierNow }), "stale", "OA becomes stale immediately beyond the 20-hour boundary");

	const client = new FakeReadinessClient(normalRows);
	const readiness = await loadIntelligenceReadiness(client as never, NOW);
	assert.equal(readiness.generatedAt, NOW.toISOString());
	const liveSource = readiness.sources.find((source) => source.key === "discovery_live_commerce");
	assert.equal(liveSource?.status, "failed", "latest failed Discovery attempt is preserved separately from prior success");
	assert.equal(liveSource?.latestAttemptAt, iso(1));
	assert.equal(liveSource?.latestSuccessAt, iso(4.99), "the latest successful run remains available for the active-product denominator");
	assert.equal(readiness.sources.find((source) => source.key === "discovery_home_shopping")?.status, "healthy", "a newer unrelated Discovery job type cannot leak into home-shopping telemetry");
	const audioSource = readiness.sources.find((source) => source.key === "broadcast_audio_analysis");
	assert.equal(audioSource?.status, "degraded", "a partial attempt is degraded, not healthy and not an outage");
	assert.match(audioSource?.detail ?? "", /partial/, "a non-healthy source carries its error code, so the badge says why");
	assert.equal(readiness.sources.find((source) => source.key === "intelligence_foundation_backfill")?.status, "healthy", "on-demand backfill does not become stale merely because it is not scheduled");
	assert.deepEqual(readiness.coverage, {
		activeProducts: 5,
		canonicalLinked: 4,
		canonicalLinkPct: 80,
		categorizedActive: 3,
		categoryPct: 60,
		archivedBroadcasts: 4,
		analyzedBroadcasts: 2,
		analysisPct: 50,
		evidenceItems: 7,
		insightSnapshots: 3,
	});
	assert.equal(readiness.coverage.activeProducts, 5, "Discovery identities and re-imported internal source links are de-duplicated to the exact active-product set");
	assert.deepEqual(readiness.categorySamples, [
		{ category: "Uncategorized", total: 1, analyzed: 0, pct: 0 },
		{ category: "Beauty", total: 2, analyzed: 1, pct: 50 },
		{ category: "Electronics", total: 1, analyzed: 1, pct: 100 },
	]);
	assert.equal(readiness.failures.length, 10, "recent failures are bounded");
	assert.equal(readiness.failures[0]?.startedAt, iso(1), "recent failures are newest first");
	assert.ok(client.calls.includes("data_pipeline_runs:eq:source_type:discovery") && client.calls.includes("data_pipeline_runs:eq:job_type:home_shopping"), "latest telemetry scopes each source and job type together");
	assert.ok(client.calls.includes("data_pipeline_runs:limit:10"), "failure history is limited at query time");
	assert.ok(client.calls.some((call) => call === "discovered_products:in:session_id:discovery-session-home,discovery-session-live"), "only the distinct latest-success Discovery external run IDs define membership");
	assert.equal(client.calls.some((call) => call === "discovered_products:in:session_id:home-success,live-success"), false, "telemetry UUIDs never leak into Discovery session membership queries");
	assert.equal(client.calls.some((call) => call.includes("d-historical")), false, "historical Discovery products never enter the active denominator");
	assert.ok(client.calls.includes("product_source_links:eq:source_type:internal_excel"), "internal coverage is sourced from active internal source links");
	assert.ok(client.calls.includes("broadcasts:range:0:499"), "broadcast identity sets use pagination rather than PostgREST's default row cap");
	assert.ok(client.calls.includes("evidence_items:select:count:body") && client.calls.includes("insight_snapshots:select:count:body"), "required-table counts use exact counts without a HEAD response that can mask relation failures");
	assert.ok(client.calls.includes("evidence_items:limit:1") && client.calls.includes("insight_snapshots:limit:1"), "required-table probes read at most one row while obtaining the exact count");

	for (const [telemetryId, jobType, externalRunId] of [["home-success", "home_shopping", null], ["live-success", "live_commerce", "   "]] as const) {
		const missingExternalClient = new FakeReadinessClient({
			...normalRows,
			data_pipeline_runs: normalRows.data_pipeline_runs.map((row) => row.id === telemetryId ? { ...row, external_run_id: externalRunId } : row),
		});
		await assert.rejects(
			() => loadIntelligenceReadiness(missingExternalClient as never, NOW),
			new RegExp(`latest successful Discovery ${jobType} run is missing external_run_id`),
			"a successful Discovery telemetry row without its session identifier is an integrity error, not an empty denominator",
		);
	}

	const exactlyTwentyHours = new Date(NOW.getTime() - 20 * HOUR).toISOString();
	const oaBoundary = await loadIntelligenceReadiness(
		new FakeReadinessClient(withCrawlRun({
			...normalRows.data_pipeline_runs.find((row) => row.id === "crawl-success")!,
			started_at: exactlyTwentyHours,
			finished_at: exactlyTwentyHours,
		})) as never,
		NOW,
	);
	assert.equal(oaBoundary.sources.find((source) => source.key === "historical_broadcast_crawl")?.status, "healthy", "OA is healthy exactly 20 hours after a successful crawl");
	const oaMissed = await loadIntelligenceReadiness(
		new FakeReadinessClient(withCrawlRun({
			...normalRows.data_pipeline_runs.find((row) => row.id === "crawl-success")!,
			started_at: new Date(NOW.getTime() - 20 * HOUR - 1).toISOString(),
			finished_at: new Date(NOW.getTime() - 20 * HOUR - 1).toISOString(),
		})) as never,
		NOW,
	);
	assert.equal(oaMissed.sources.find((source) => source.key === "historical_broadcast_crawl")?.status, "stale", "a missed second OA invocation is stale immediately after 20 hours");
	// The rule an older success never masks a newer non-success still holds; what
	// changed is that the newer non-success now says which kind it is.
	for (const [status, expected] of [["partial", "degraded"], ["failed", "failed"]] as const) {
		const oaLatestFailure = await loadIntelligenceReadiness(
			new FakeReadinessClient(withCrawlRun(
				{
					...normalRows.data_pipeline_runs.find((row) => row.id === "crawl-success")!,
					started_at: exactlyTwentyHours,
					finished_at: exactlyTwentyHours,
				},
				pipelineRun({ id: `crawl-${status}`, sourceType: "oa_channels", jobType: "historical_broadcast_crawl", status, hoursAgo: 1 }),
			)) as never,
			NOW,
		);
		assert.equal(oaLatestFailure.sources.find((source) => source.key === "historical_broadcast_crawl")?.status, expected, `a latest OA ${status} attempt is not masked by a fresh older success`);
	}

	const missingEvidenceClient = new FakeReadinessClient({ ...normalRows, evidence_items: [] });
	const originalFrom = missingEvidenceClient.from.bind(missingEvidenceClient);
	missingEvidenceClient.from = ((table: string) => originalFrom(table === "evidence_items" ? "evidence_items_missing" : table)) as typeof missingEvidenceClient.from;
	await assert.rejects(
		() => loadIntelligenceReadiness(missingEvidenceClient as never, NOW),
		/evidence item count failed: relation evidence_items does not exist/,
		"an unapplied new table is a visible loader failure, never fabricated zero coverage",
	);
	const unavailableCountClient = new FakeReadinessClient({ ...normalRows, evidence_items: [] });
	const unavailableCountFrom = unavailableCountClient.from.bind(unavailableCountClient);
	unavailableCountClient.from = ((table: string) => unavailableCountFrom(table === "evidence_items" ? "evidence_items_unavailable_count" : table)) as typeof unavailableCountClient.from;
	await assert.rejects(
		() => loadIntelligenceReadiness(unavailableCountClient as never, NOW),
		/evidence item count failed: exact count unavailable/,
		"an error-null/count-null required-table response is unavailable, never empty coverage",
	);
	const legitimateEmptyClient = new FakeReadinessClient({
		...normalRows,
		evidence_items: [],
		insight_snapshots: [],
	});
	const legitimateEmpty = await loadIntelligenceReadiness(legitimateEmptyClient as never, NOW);
	assert.equal(legitimateEmpty.coverage.evidenceItems, 0, "a successful exact count distinguishes a legitimate empty table");
	assert.equal(legitimateEmpty.coverage.insightSnapshots, 0, "every required-table count preserves a real zero");
	const emptyCoverage = await loadIntelligenceReadiness(
		new FakeReadinessClient({
			...normalRows,
			discovered_products: [],
			product_source_links: [],
			canonical_products: [],
			broadcasts: [],
			broadcast_speech_analyses: [],
		}) as never,
		NOW,
	);
	assert.equal(emptyCoverage.coverage.canonicalLinkPct, null, "zero active products is unknown coverage, not 0%");
	assert.equal(emptyCoverage.coverage.categoryPct, null, "zero active products never manufactures category failure");
	assert.equal(emptyCoverage.coverage.analysisPct, null, "zero archived broadcasts is unknown analysis coverage, not 0%");

	console.log("PASS: intelligence readiness model");
}

void run();
