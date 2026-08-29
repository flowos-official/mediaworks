import type { SupabaseClient } from "@supabase/supabase-js";

export type ReadinessStatus = "healthy" | "stale" | "failed" | "missing";

export interface IntelligenceReadiness {
	generatedAt: string;
	sources: Array<{
		key: string;
		latestAttemptAt: string | null;
		latestSuccessAt: string | null;
		status: ReadinessStatus;
		detail: string;
	}>;
	coverage: {
		activeProducts: number;
		canonicalLinked: number;
		canonicalLinkPct: number | null;
		categorizedActive: number;
		categoryPct: number | null;
		archivedBroadcasts: number;
		analyzedBroadcasts: number;
		analysisPct: number | null;
		evidenceItems: number;
		insightSnapshots: number;
	};
	categorySamples: Array<{ category: string; total: number; analyzed: number; pct: number | null }>;
	failures: Array<{
		sourceType: string;
		jobType: string;
		errorCode: string | null;
		errorSummary: string | null;
		startedAt: string;
	}>;
}

interface PipelineRunRow {
	id: string;
	source_type: string;
	job_type: string;
	external_run_id: string | null;
	status: string;
	started_at: string;
	finished_at: string | null;
	error_code: string | null;
	error_summary: string | null;
}

interface SourceLinkRow {
	id: string;
	source_type: string;
	source_table: string;
	source_record_id: string;
	canonical_product_id: string;
}

interface CanonicalProductRow {
	id: string;
	normalized_category: string | null;
}

interface ArchivedBroadcastRow {
	id: string;
	category: string | null;
}

const HOUR = 3_600_000;
const PAGE_SIZE = 500;
const ID_CHUNK_SIZE = 200;
const RECENT_FAILURE_LIMIT = 10;

/**
 * Freshness is based on the Vercel schedules: daily sources receive a two-hour
 * execution cushion, the twice-daily OA crawl receives a 20-hour interval,
 * archive runs every two hours receive a one-hour cushion, and the foundation
 * backfill is deliberately on-demand rather than periodic.
 */
export const INTELLIGENCE_READINESS_SOURCES = [
	{ key: "discovery_home_shopping", sourceType: "discovery", jobType: "home_shopping", maxAgeMs: 26 * HOUR, cadence: "daily (26h tolerance)" },
	{ key: "discovery_live_commerce", sourceType: "discovery", jobType: "live_commerce", maxAgeMs: 26 * HOUR, cadence: "daily (26h tolerance)" },
	{ key: "broadcast_schedule", sourceType: "qvc_shopch", jobType: "broadcast_schedule", maxAgeMs: 26 * HOUR, cadence: "daily (26h tolerance)" },
	{ key: "historical_broadcast_crawl", sourceType: "oa_channels", jobType: "historical_broadcast_crawl", maxAgeMs: 20 * HOUR, cadence: "twice daily (20h tolerance)" },
	{ key: "broadcast_video_archive", sourceType: "qvc_shopch", jobType: "video_archive", maxAgeMs: 3 * HOUR, cadence: "every 2h (3h tolerance)" },
	{ key: "broadcast_audio_analysis", sourceType: "broadcast_archive", jobType: "audio_analysis", maxAgeMs: 26 * HOUR, cadence: "daily (26h tolerance)" },
	{ key: "intelligence_foundation_backfill", sourceType: "intelligence_foundation", jobType: "intelligence_foundation_backfill", maxAgeMs: null, cadence: "on demand" },
	{ key: "intelligence_insight_refresh", sourceType: "evidence_items", jobType: "insight_refresh", maxAgeMs: 26 * HOUR, cadence: "daily (26h tolerance)" },
] as const;

type ReadinessSource = (typeof INTELLIGENCE_READINESS_SOURCES)[number];

export function percent(numerator: number, denominator: number): number | null {
	if (!Number.isFinite(denominator) || denominator <= 0) return null;
	if (!Number.isFinite(numerator)) return null;
	return Math.round((Math.max(0, numerator) / denominator) * 100);
}

/** A newest non-successful attempt is intentionally never masked by an older success. */
export function classifyReadiness(input: {
	latestAttemptAt: string | null;
	latestSuccessAt: string | null;
	latestStatus: string | null;
	maxAgeMs: number | null;
	nowMs: number;
}): ReadinessStatus {
	if (!input.latestAttemptAt && !input.latestSuccessAt) return "missing";
	if (input.latestStatus !== "succeeded" || !input.latestAttemptAt || !input.latestSuccessAt) return "failed";

	const attemptMs = Date.parse(input.latestAttemptAt);
	const successMs = Date.parse(input.latestSuccessAt);
	if (!Number.isFinite(attemptMs) || !Number.isFinite(successMs) || attemptMs > input.nowMs || successMs > input.nowMs) return "failed";
	if (input.maxAgeMs === null) return "healthy";
	return input.nowMs - successMs <= input.maxAgeMs ? "healthy" : "stale";
}

function asError(label: string, error: { message?: string } | null): never {
	throw new Error(`${label} failed: ${error?.message ?? "unknown database error"}`);
}

function chunks<T>(values: readonly T[], size = ID_CHUNK_SIZE): T[][] {
	const result: T[][] = [];
	for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
	return result;
}

function uniqueNonEmpty(values: Iterable<string | null | undefined>): string[] {
	return [...new Set([...values].filter((value): value is string => Boolean(value)))];
}

function sourceIdentity(row: Pick<SourceLinkRow, "source_type" | "source_table" | "source_record_id">): string {
	return `${row.source_type}\u0000${row.source_table}\u0000${row.source_record_id}`;
}

function internalCanonicalIdentity(canonicalProductId: string): string {
	return `canonical_internal\u0000${canonicalProductId}`;
}

function categoryName(value: string | null): string {
	return value?.trim() || "Uncategorized";
}

function timestampForSuccess(row: PipelineRunRow | null): string | null {
	return row ? row.finished_at ?? row.started_at : null;
}

/** Discovery products reference discovery_runs.id, persisted as telemetry external_run_id. */
function discoverySessionId(jobType: "home_shopping" | "live_commerce", row: PipelineRunRow | null): string | null {
	if (!row) return null;
	const sessionId = row.external_run_id?.trim();
	if (!sessionId) throw new Error(`latest successful Discovery ${jobType} run is missing external_run_id`);
	return sessionId;
}

export interface LatestPipelineRunPair {
	latestAttempt: PipelineRunRow | null;
	latestSuccess: PipelineRunRow | null;
}

export interface IntelligenceReadinessRepository {
	loadLatestPipelineRun(sourceType: string, jobType: string): Promise<LatestPipelineRunPair>;
	loadRecentFailures(limit: number): Promise<PipelineRunRow[]>;
	loadDiscoveryProducts(runIds: string[]): Promise<Array<{ id: string }>>;
	loadDiscoverySourceLinks(discoveryProductIds: string[]): Promise<SourceLinkRow[]>;
	loadInternalSourceLinks(): Promise<SourceLinkRow[]>;
	loadActiveCanonicalProducts(canonicalIds: string[]): Promise<CanonicalProductRow[]>;
	loadArchivedBroadcasts(): Promise<ArchivedBroadcastRow[]>;
	loadAnalyzedBroadcastIds(broadcastIds: string[]): Promise<string[]>;
	countEvidenceItems(): Promise<number>;
	countInsightSnapshots(): Promise<number>;
}

/**
 * Read-only Supabase adapter. Identity-bearing result sets are explicitly
 * paged; count-only metrics use PostgREST exact-count heads.
 */
export function createIntelligenceReadinessRepository(sb: SupabaseClient): IntelligenceReadinessRepository {
	async function readPagedRows<T>(
		label: string,
		createQuery: () => any,
	): Promise<T[]> {
		const rows: T[] = [];
		for (let offset = 0; ; offset += PAGE_SIZE) {
			const { data, error } = await createQuery().range(offset, offset + PAGE_SIZE - 1);
			if (error) asError(label, error);
			const page = (data ?? []) as T[];
			rows.push(...page);
			if (page.length < PAGE_SIZE) return rows;
		}
	}

	async function readRowsForIds<T>(
		label: string,
		table: string,
		columns: string,
		column: string,
		ids: string[],
		filters: (query: any) => any = (query) => query,
	): Promise<T[]> {
		const rows: T[] = [];
		for (const group of chunks(ids)) {
			const { data, error } = await filters(
				sb.from(table).select(columns).in(column, group),
			);
			if (error) asError(label, error);
			rows.push(...((data ?? []) as T[]));
		}
		return rows;
	}

	async function countRequiredTable(table: "evidence_items" | "insight_snapshots", label: string): Promise<number> {
		const { count, error } = await sb.from(table).select("id", { count: "exact" }).limit(1);
		if (error) asError(label, error);
		if (count === null || count === undefined) asError(label, { message: "exact count unavailable" });
		return count;
	}

	return {
		async loadLatestPipelineRun(sourceType, jobType) {
			const [attemptResult, successResult] = await Promise.all([
				sb
					.from("data_pipeline_runs")
					.select("id,source_type,job_type,external_run_id,status,started_at,finished_at,error_code,error_summary")
					.eq("source_type", sourceType)
					.eq("job_type", jobType)
					.order("started_at", { ascending: false })
					.limit(1)
					.maybeSingle(),
				sb
					.from("data_pipeline_runs")
					.select("id,source_type,job_type,external_run_id,status,started_at,finished_at,error_code,error_summary")
					.eq("source_type", sourceType)
					.eq("job_type", jobType)
					.eq("status", "succeeded")
					.order("started_at", { ascending: false })
					.limit(1)
					.maybeSingle(),
			]);
			if (attemptResult.error) asError(`latest ${sourceType}/${jobType} attempt`, attemptResult.error);
			if (successResult.error) asError(`latest ${sourceType}/${jobType} success`, successResult.error);
			return {
				latestAttempt: (attemptResult.data as PipelineRunRow | null) ?? null,
				latestSuccess: (successResult.data as PipelineRunRow | null) ?? null,
			};
		},

		async loadRecentFailures(limit) {
			const { data, error } = await sb
				.from("data_pipeline_runs")
				.select("source_type,job_type,error_code,error_summary,started_at")
				.eq("status", "failed")
				.order("started_at", { ascending: false })
				.limit(limit);
			if (error) asError("recent pipeline failures", error);
			return (data ?? []) as PipelineRunRow[];
		},

		loadDiscoveryProducts(runIds) {
			if (runIds.length === 0) return Promise.resolve([]);
			return readPagedRows("latest Discovery products", () => sb
				.from("discovered_products")
				.select("id,session_id")
				.in("session_id", runIds)
				.order("id", { ascending: true }));
		},

		loadDiscoverySourceLinks(discoveryProductIds) {
			if (discoveryProductIds.length === 0) return Promise.resolve([]);
			return readRowsForIds<SourceLinkRow>(
				"Discovery canonical links",
				"product_source_links",
				"id,source_type,source_table,source_record_id,canonical_product_id",
				"source_record_id",
				discoveryProductIds,
				(query) => query.eq("source_type", "discovery").eq("source_table", "discovered_products"),
			);
		},

		loadInternalSourceLinks() {
			return readPagedRows("internal source links", () => sb
				.from("product_source_links")
				.select("id,source_type,source_table,source_record_id,canonical_product_id")
				.eq("source_type", "internal_excel")
				.order("id", { ascending: true }));
		},

		loadActiveCanonicalProducts(canonicalIds) {
			if (canonicalIds.length === 0) return Promise.resolve([]);
			return readRowsForIds<CanonicalProductRow>(
				"active canonical products",
				"canonical_products",
				"id,normalized_category",
				"id",
				canonicalIds,
				(query) => query.eq("status", "active"),
			);
		},

		loadArchivedBroadcasts() {
			return readPagedRows("archived broadcasts", () => sb
				.from("broadcasts")
				.select("id,category")
				.not("archived_video_s3", "is", null)
				.order("id", { ascending: true }));
		},

		loadAnalyzedBroadcastIds(broadcastIds) {
			if (broadcastIds.length === 0) return Promise.resolve([]);
			return readRowsForIds<{ broadcast_id: string }>(
				"analyzed broadcast IDs",
				"broadcast_speech_analyses",
				"broadcast_id",
				"broadcast_id",
				broadcastIds,
			).then((rows) => rows.map((row) => row.broadcast_id));
		},

		countEvidenceItems: () => countRequiredTable("evidence_items", "evidence item count"),
		countInsightSnapshots: () => countRequiredTable("insight_snapshots", "insight snapshot count"),
	};
}

interface ActiveProduct {
	identity: string;
	canonicalProductId: string | null;
}

function sourceDetail(source: ReadinessSource, status: ReadinessStatus): string {
	if (status === "missing") return `${source.sourceType}/${source.jobType}: no recorded attempt (${source.cadence}).`;
	return `${source.sourceType}/${source.jobType}: ${source.cadence}.`;
}

export async function loadIntelligenceReadiness(
	sb: SupabaseClient,
	now: Date = new Date(),
	repository: IntelligenceReadinessRepository = createIntelligenceReadinessRepository(sb),
): Promise<IntelligenceReadiness> {
	const nowMs = now.getTime();
	if (!Number.isFinite(nowMs)) throw new Error("readiness clock is invalid");

	const latestRuns = await Promise.all(
		INTELLIGENCE_READINESS_SOURCES.map((source) => repository.loadLatestPipelineRun(source.sourceType, source.jobType)),
	);

	const sourceRuns = new Map(INTELLIGENCE_READINESS_SOURCES.map((source, index) => [source.key, latestRuns[index]]));
	const sources = INTELLIGENCE_READINESS_SOURCES.map((source) => {
		const runs = sourceRuns.get(source.key)!;
		const latestAttemptAt = runs.latestAttempt?.started_at ?? null;
		const latestSuccessAt = timestampForSuccess(runs.latestSuccess);
		const status = classifyReadiness({
			latestAttemptAt,
			latestSuccessAt,
			latestStatus: runs.latestAttempt?.status ?? null,
			maxAgeMs: source.maxAgeMs,
			nowMs,
		});
		return { key: source.key, latestAttemptAt, latestSuccessAt, status, detail: sourceDetail(source, status) };
	});

	const discoveryRunIds = uniqueNonEmpty([
		discoverySessionId("home_shopping", sourceRuns.get("discovery_home_shopping")?.latestSuccess ?? null),
		discoverySessionId("live_commerce", sourceRuns.get("discovery_live_commerce")?.latestSuccess ?? null),
	]);
	const [recentFailures, internalLinks, archivedBroadcasts, evidenceItems, insightSnapshots] = await Promise.all([
		repository.loadRecentFailures(RECENT_FAILURE_LIMIT),
		repository.loadInternalSourceLinks(),
		repository.loadArchivedBroadcasts(),
		repository.countEvidenceItems(),
		repository.countInsightSnapshots(),
	]);
	const discoveryProducts = await repository.loadDiscoveryProducts(discoveryRunIds);
	const discoveryProductIds = uniqueNonEmpty(discoveryProducts.map((product) => product.id));
	const discoveryLinks = await repository.loadDiscoverySourceLinks(discoveryProductIds);

	const allLinkedCanonicalIds = uniqueNonEmpty([
		...discoveryLinks.map((link) => link.canonical_product_id),
		...internalLinks.map((link) => link.canonical_product_id),
	]);
	const activeCanonicals = await repository.loadActiveCanonicalProducts(allLinkedCanonicalIds);
	const activeCanonicalById = new Map(activeCanonicals.map((product) => [product.id, product]));
	const discoveryLinkByIdentity = new Map(discoveryLinks.map((link) => [sourceIdentity(link), link]));

	const activeProductsByIdentity = new Map<string, ActiveProduct>();
	for (const product of discoveryProducts) {
		const identity = sourceIdentity({ source_type: "discovery", source_table: "discovered_products", source_record_id: product.id });
		const link = discoveryLinkByIdentity.get(identity);
		activeProductsByIdentity.set(identity, { identity, canonicalProductId: link?.canonical_product_id ?? null });
	}
	for (const link of internalLinks) {
		if (!activeCanonicalById.has(link.canonical_product_id)) continue;
		// An internal product can be represented by more than one source row over
		// time. It remains one canonical active product in this denominator.
		const identity = internalCanonicalIdentity(link.canonical_product_id);
		activeProductsByIdentity.set(identity, { identity, canonicalProductId: link.canonical_product_id });
	}
	const activeProducts = [...activeProductsByIdentity.values()];
	const canonicalLinked = activeProducts.filter((product) => product.canonicalProductId !== null).length;
	const categorizedActive = activeProducts.filter((product) => {
		const category = product.canonicalProductId ? activeCanonicalById.get(product.canonicalProductId)?.normalized_category : null;
		return Boolean(category?.trim());
	}).length;

	const archivedBroadcastById = new Map(archivedBroadcasts.map((broadcast) => [broadcast.id, broadcast]));
	const analyzedIds = new Set(
		(await repository.loadAnalyzedBroadcastIds([...archivedBroadcastById.keys()]))
			.filter((broadcastId) => archivedBroadcastById.has(broadcastId)),
	);
	const categoryCounts = new Map<string, { total: number; analyzed: number }>();
	for (const broadcast of archivedBroadcastById.values()) {
		const category = categoryName(broadcast.category);
		const current = categoryCounts.get(category) ?? { total: 0, analyzed: 0 };
		current.total += 1;
		if (analyzedIds.has(broadcast.id)) current.analyzed += 1;
		categoryCounts.set(category, current);
	}
	const categorySamples = [...categoryCounts.entries()]
		.map(([category, counts]) => ({ category, ...counts, pct: percent(counts.analyzed, counts.total) }))
		.sort((left, right) => (left.pct ?? Number.POSITIVE_INFINITY) - (right.pct ?? Number.POSITIVE_INFINITY) || left.category.localeCompare(right.category));

	return {
		generatedAt: now.toISOString(),
		sources,
		coverage: {
			activeProducts: activeProducts.length,
			canonicalLinked,
			canonicalLinkPct: percent(canonicalLinked, activeProducts.length),
			categorizedActive,
			categoryPct: percent(categorizedActive, activeProducts.length),
			archivedBroadcasts: archivedBroadcastById.size,
			analyzedBroadcasts: analyzedIds.size,
			analysisPct: percent(analyzedIds.size, archivedBroadcastById.size),
			evidenceItems,
			insightSnapshots,
		},
		categorySamples,
		failures: recentFailures.map((run) => ({
			sourceType: run.source_type,
			jobType: run.job_type,
			errorCode: run.error_code,
			errorSummary: run.error_summary,
			startedAt: run.started_at,
		})),
	};
}
