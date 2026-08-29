import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
	buildBroadcastCategoryInsight,
	buildProductMarketInsight,
	selectActiveEvidence,
} from "../lib/intelligence/insights";
import type { EvidenceItem, EvidenceValueState } from "../lib/intelligence/types";
import {
	createInsightRefreshRepository,
	persistInsightSnapshot,
	refreshIntelligenceInsights,
	resolveStoredBroadcastCategories,
	type InsightRefreshRepository,
	type SnapshotPersistence,
} from "../lib/intelligence/refresh-insights";
import type { PipelineRunCounts, PipelineRunHandle } from "../lib/intelligence/pipeline-run";
import {
	isRefreshInsightsCronAuthorized,
	maxDuration as refreshInsightsMaxDuration,
	runRefreshInsightsCron,
} from "../app/api/cron/refresh-intelligence-insights/route";

const CUTOFF = "2026-08-29T00:00:00.000Z";

function evidence(input: {
	id: string;
	subjectId?: string;
	subjectType?: EvidenceItem["subjectType"];
	predicate: string;
	value?: unknown;
	valueState?: EvidenceValueState;
	evidenceClass?: EvidenceItem["evidenceClass"];
	sourceType?: string;
	sourceTable?: string;
	sourceRecordId?: string;
	sourceLocator?: string;
	observedAt?: string;
	validFrom?: string;
	validUntil?: string;
	confidence?: number;
}): EvidenceItem {
	const valueState = input.valueState ?? "known";
	return {
		id: input.id,
		dedupeKey: `dedupe:${input.id}`,
		subjectType: input.subjectType ?? "product",
		subjectId: input.subjectId ?? "product-1",
		predicate: input.predicate,
		...(valueState === "known" ? { value: input.value } : {}),
		valueState,
		evidenceClass: input.evidenceClass ?? "proxy",
		sourceType: input.sourceType ?? "discovery",
		sourceTable: input.sourceTable ?? "discovered_products",
		sourceRecordId: input.sourceRecordId ?? input.id,
		...(input.sourceLocator ? { sourceLocator: input.sourceLocator } : {}),
		observedAt: input.observedAt ?? "2026-08-20T00:00:00.000Z",
		...(input.validFrom ? { validFrom: input.validFrom } : {}),
		...(input.validUntil ? { validUntil: input.validUntil } : {}),
		confidence: input.confidence ?? 0.8,
	};
}

function assertNoExternalFields(value: unknown): void {
	const forbidden = new Set([
		"externalSearch",
		"externalSearchResults",
		"recommendations",
		"research",
		"screenplay",
		"searchResults",
	]);
	const visit = (current: unknown): void => {
		if (!current || typeof current !== "object") return;
		for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
			assert.equal(forbidden.has(key), false, `stored-only insight must omit ${key}`);
			visit(child);
		}
	};
	visit(value);
}

{
	const selection = selectActiveEvidence([
		evidence({ id: "old-known", predicate: "price_jpy", value: 9_000, sourceRecordId: "same", observedAt: "2026-08-10T00:00:00.000Z" }),
		evidence({ id: "current-unknown", predicate: "price_jpy", valueState: "unknown", sourceRecordId: "same", observedAt: "2026-08-20T00:00:00.000Z" }),
		evidence({ id: "current-tie-a", predicate: "review_count", value: 3, sourceRecordId: "tie", observedAt: "2026-08-20T00:00:00.000Z" }),
		evidence({ id: "current-tie-b", predicate: "review_count", valueState: "conflicting", sourceRecordId: "tie", observedAt: "2026-08-20T00:00:00.000Z" }),
		evidence({ id: "stale", predicate: "review_count", valueState: "stale" }),
		evidence({ id: "expired", predicate: "review_count", value: 99, validUntil: "2026-08-28T23:59:59.999Z" }),
		evidence({ id: "expires-at-cutoff", predicate: "review_count", value: 7, validUntil: CUTOFF }),
		evidence({ id: "not-yet-valid", predicate: "review_count", value: 8, validFrom: "2026-08-29T00:00:00.001Z" }),
		evidence({ id: "future-observation", predicate: "review_count", value: 10, observedAt: "2026-08-29T00:00:00.001Z" }),
	], CUTOFF);
	assert.deepEqual(
		selection.map((item) => item.id),
		["current-tie-a", "current-tie-b", "current-unknown", "expires-at-cutoff"],
		"active means observed and valid at the cutoff, non-stale, and current per provenance key; unknown/conflicting current rows remain",
	);
}

const productEvidence: EvidenceItem[] = [
	evidence({ id: "price-a", predicate: "price_jpy", value: 10_000, evidenceClass: "verified", confidence: 1 }),
	evidence({ id: "price-b", predicate: "price_jpy", value: 15_000, evidenceClass: "verified", confidence: 1 }),
	evidence({ id: "price-unknown", predicate: "price_jpy", valueState: "unknown" }),
	evidence({ id: "tv", predicate: "airing_count_30d", value: 4 }),
	evidence({ id: "review", predicate: "review_count", value: 128 }),
	evidence({ id: "rank", predicate: "ranking_position", value: 3 }),
	evidence({ id: "seller", predicate: "seller_claim", value: "工具不要", evidenceClass: "source_claim", sourceType: "qvc" }),
	evidence({ id: "profit-unknown", predicate: "gross_profit_jpy", valueState: "unknown", evidenceClass: "internal_input", sourceType: "internal_excel" }),
	evidence({ id: "sales-unknown", predicate: "actual_competitor_sales", valueState: "unknown" }),
];

{
	const product = buildProductMarketInsight(productEvidence, CUTOFF);
	const result = product.result as any;
	assert.equal(product.insightType, "product_market");
	assert.equal(product.subjectType, "product");
	assert.equal(product.subjectId, "product-1");
	assert.equal(product.inputFrom, "2026-08-20T00:00:00.000Z");
	assert.equal(product.inputUntil, CUTOFF);
	assert.equal(product.formulaVersion, "product-market-v1");
	assert.deepEqual(result.price.observedJpy, { count: 2, min: 10_000, median: 12_500, max: 15_000 });
	assert.equal(result.demand.tvAirings30d, 4);
	assert.equal(result.demand.reviewCount, 128);
	assert.deepEqual(result.demand.rankingPositions, { best: 3, observed: [3] });
	assert.equal(result.demand.actualCompetitorSales, undefined, "unknown competitor sales is absent, never zero");
	assert.deepEqual(result.sellerClaims, [{ predicate: "seller_claim", value: "工具不要" }]);
	assert.equal(result.profitability, undefined, "unknown profitability is absent, never zero");
	assert.equal(product.coverage.price, "known");
	assert.equal((product.coverage.demand as any).actualCompetitorSales, "unknown");
	assert.equal(product.coverage.profitability, "unknown");
	assert.deepEqual(product.evidenceIds, productEvidence.map((item) => item.id).sort());
	assert.equal(new Set(product.evidenceIds).size, product.evidenceIds.length);
	assertNoExternalFields(product);
	assert.deepEqual(
		buildProductMarketInsight([...productEvidence].reverse(), CUTOFF),
		product,
		"product output is deterministic across input ordering",
	);
}

{
	const withProfit = buildProductMarketInsight([
		evidence({ id: "gross-profit", predicate: "gross_profit_jpy", value: 2_400, evidenceClass: "internal_input", sourceType: "internal_excel" }),
		evidence({ id: "margin", predicate: "gross_margin_pct", value: 24.5, evidenceClass: "internal_input", sourceType: "internal_excel" }),
	], CUTOFF);
	assert.deepEqual(withProfit.result.profitability, { grossMarginPct: 24.5, grossProfitJpy: 2_400 });
	assert.equal(withProfit.coverage.profitability, "known");
}

const broadcastEvidence: EvidenceItem[] = [
	evidence({ id: "b1-category", subjectType: "broadcast", subjectId: "broadcast-1", predicate: "normalized_category", value: "家電", evidenceClass: "verified", sourceType: "qvc", sourceTable: "broadcasts", sourceRecordId: "broadcast-1", confidence: 1 }),
	evidence({ id: "b1-date", subjectType: "broadcast", subjectId: "broadcast-1", predicate: "air_date", value: "2026-08-20", evidenceClass: "verified", sourceType: "qvc", sourceTable: "broadcast_speech_analyses", sourceRecordId: "broadcast-1", confidence: 1 }),
	evidence({ id: "b1-price", subjectType: "broadcast", subjectId: "broadcast-1", predicate: "price_jpy", value: 10_000, evidenceClass: "verified", sourceType: "qvc", sourceTable: "broadcasts", sourceRecordId: "broadcast-1", confidence: 1 }),
	evidence({ id: "b1-structure", subjectType: "broadcast", subjectId: "broadcast-1", predicate: "segment_pattern", value: [{ label: "opening" }], evidenceClass: "inferred", sourceType: "qvc", sourceTable: "broadcast_speech_analyses", sourceRecordId: "broadcast-1" }),
	evidence({ id: "b2-date", subjectType: "broadcast", subjectId: "broadcast-2", predicate: "air_date", value: "2026-08-21", evidenceClass: "verified", sourceType: "shopch", sourceTable: "broadcast_speech_analyses", sourceRecordId: "broadcast-2", confidence: 1 }),
	evidence({ id: "b2-price", subjectType: "broadcast", subjectId: "broadcast-2", predicate: "price_jpy", value: 20_000, evidenceClass: "verified", sourceType: "shopch", sourceTable: "broadcasts", sourceRecordId: "broadcast-2", confidence: 1 }),
	evidence({ id: "b2-structure", subjectType: "broadcast", subjectId: "broadcast-2", predicate: "selling_points", value: [{ type: "demo" }], evidenceClass: "inferred", sourceType: "shopch", sourceTable: "broadcast_speech_analyses", sourceRecordId: "broadcast-2" }),
	evidence({ id: "b2-price-conflict", subjectType: "broadcast", subjectId: "broadcast-2", predicate: "price_jpy", valueState: "conflicting", sourceType: "shopch", sourceTable: "manual", sourceRecordId: "broadcast-2" }),
];

{
	const category = buildBroadcastCategoryInsight(broadcastEvidence, "家電", CUTOFF);
	const result = category.result as any;
	assert.equal(category.insightType, "broadcast_category_market");
	assert.equal(category.subjectType, "category");
	assert.equal(category.subjectId, "家電");
	assert.equal(category.formulaVersion, "broadcast-category-v1");
	assert.equal(result.sampleSize, 2);
	assert.deepEqual(result.productDensity, { broadcasts: 2, observedDays: 2, broadcastsPerObservedDay: 1 });
	assert.deepEqual(result.priceDistributionJpy, { count: 2, min: 10_000, median: 15_000, max: 20_000 });
	assert.deepEqual(result.channels, ["qvc", "shopch"]);
	assert.deepEqual(result.structurePatternAvailability, { broadcastsWithPatterns: 2, ratio: 1 });
	assert.deepEqual(result.categoryImbalance, { dominantChannel: "qvc", dominantShare: 0.5, byChannel: { qvc: 1, shopch: 1 } });
	assert.equal(category.coverage.priceDistribution, "conflicting");
	assert.equal(category.coverage.categoryMembership, "known");
	assert.ok(category.confidence < 0.8, "a two-row sample must remain low confidence");
	assert.deepEqual(category.evidenceIds, broadcastEvidence.map((item) => item.id).sort());
	assertNoExternalFields(category);
	assert.deepEqual(
		buildBroadcastCategoryInsight([...broadcastEvidence].reverse(), "家電", CUTOFF),
		category,
		"category output is deterministic across input ordering",
	);
}

{
	const unknownCategory = buildBroadcastCategoryInsight([
		evidence({ id: "unknown-date", subjectType: "broadcast", subjectId: "unknown-broadcast", predicate: "air_date", valueState: "unknown", sourceType: "qvc", sourceTable: "broadcast_speech_analyses", sourceRecordId: "unknown-broadcast" }),
		evidence({ id: "unknown-price", subjectType: "broadcast", subjectId: "unknown-broadcast", predicate: "price_jpy", valueState: "unknown", sourceType: "qvc", sourceTable: "broadcasts", sourceRecordId: "unknown-broadcast" }),
		evidence({ id: "unknown-structure", subjectType: "broadcast", subjectId: "unknown-broadcast", predicate: "segment_pattern", valueState: "unknown", sourceType: "qvc", sourceTable: "broadcast_speech_analyses", sourceRecordId: "unknown-broadcast" }),
	], "家電", CUTOFF);
	const result = unknownCategory.result as any;
	assert.deepEqual(result.productDensity, { broadcasts: 1 }, "unknown dates do not become zero observed days");
	assert.equal(result.priceDistributionJpy, undefined, "unknown prices do not become a zero range");
	assert.equal(result.structurePatternAvailability, undefined, "unknown structures do not become zero availability");
}

console.log("PASS: deterministic stored-evidence insight builders");

function pipelineHandle(events: Array<{ status: string; counts?: Partial<PipelineRunCounts> }>): PipelineRunHandle {
	return {
		id: "pipeline-test",
		async heartbeat(counts) { events.push({ status: "running", counts }); },
		async succeed(counts) { events.push({ status: "succeeded", counts }); },
		async partial(counts) { events.push({ status: "partial", counts }); },
		async fail() { events.push({ status: "failed" }); },
	};
}

function repository(overrides: Partial<InsightRefreshRepository> = {}): InsightRefreshRepository {
	return {
		async listActiveSubjectHeads() { return []; },
		async resolveBroadcastCategories() { return new Map(); },
		async loadLatestInsightCutoffs() { return new Map(); },
		async loadProductEvidence() { throw new Error("unexpected product evidence load"); },
		async loadCategoryEvidence() { throw new Error("unexpected category evidence load"); },
		async writeSnapshot() { throw new Error("unexpected snapshot write"); },
		...overrides,
	};
}

async function testRefresh(): Promise<void> {
	{
		let selectedSubjectTypes: string[] = [];
		const internalRow = {
			id: "internal-profit",
			dedupe_key: "dedupe:internal-profit",
			subject_type: "internal_product",
			subject_id: "canonical-product",
			predicate: "gross_profit_jpy",
			value_json: 2_500,
			unit: "JPY",
			value_state: "known",
			evidence_class: "internal_input",
			source_type: "internal_excel",
			source_table: "sales_weekly",
			source_record_id: "sales-row",
			source_url: null,
			source_locator: null,
			observed_at: "2026-08-28T00:00:00.000Z",
			valid_from: null,
			valid_until: null,
			confidence: 1,
			raw_hash: null,
		};
		const client = {
			from(table: string) {
				assert.equal(table, "evidence_items");
				const builder: any = {
					select: () => builder,
					in(column: string, values: string[]) {
						if (column === "subject_type") selectedSubjectTypes = values;
						return builder;
					},
					lte: () => builder,
					neq: () => builder,
					or: () => builder,
					order: () => builder,
					range: async () => ({ data: selectedSubjectTypes.includes("internal_product") ? [internalRow] : [], error: null }),
				};
				return builder;
			},
		};
		const heads = await createInsightRefreshRepository(client as never).listActiveSubjectHeads(CUTOFF, 200);
		assert.deepEqual(heads, [{ subjectType: "product", subjectId: "canonical-product", newestObservedAt: "2026-08-28T00:00:00.000Z" }]);
	}

	{
		let explicitCategoryFilter: unknown;
		const client = {
			from(table: string) {
				const builder: any = {
					select: () => builder,
					eq(column: string, value: unknown) {
						if (table === "evidence_items" && column === "value_json") explicitCategoryFilter = value;
						return builder;
					},
					in: () => builder,
					lte: () => builder,
					neq: () => builder,
					or: () => builder,
					order: () => builder,
					range: async () => ({ data: [], error: null }),
				};
				return builder;
			},
		};
		await createInsightRefreshRepository(client as never).loadCategoryEvidence("家電", CUTOFF);
		assert.equal(explicitCategoryFilter, JSON.stringify("家電"), "JSONB string membership uses a valid JSON literal");
	}

	{
		const resolved = resolveStoredBroadcastCategories(
			["explicit", "domain", "fallback", "missing"],
			[
				evidence({ id: "explicit-category", subjectType: "broadcast", subjectId: "explicit", predicate: "normalized_category", value: "家電", evidenceClass: "verified", sourceTable: "broadcasts", sourceRecordId: "explicit" }),
				evidence({ id: "unknown-category", subjectType: "broadcast", subjectId: "fallback", predicate: "category", valueState: "unknown", sourceTable: "broadcasts", sourceRecordId: "fallback" }),
			],
			[
				{ broadcastId: "explicit", category: "美容", source: "broadcasts" },
				{ broadcastId: "domain", category: "コスメ", source: "broadcast_speech_analyses" },
				{ broadcastId: "fallback", category: "生活", source: "broadcasts" },
			],
			CUTOFF,
		);
		assert.deepEqual([...resolved.entries()], [
			["domain", "コスメ"],
			["explicit", "家電"],
			["fallback", "生活"],
			["missing", null],
		]);
	}

	{
		const calls: string[] = [];
		const persistence: SnapshotPersistence = {
			async insertParent(draft) { calls.push(`parent:${draft.evidenceIds.length}`); return "snapshot-ok"; },
			async insertEvidenceLinks(snapshotId, evidenceIds) { calls.push(`links:${snapshotId}:${evidenceIds.length}`); return evidenceIds.length; },
			async deleteParent(snapshotId) { calls.push(`delete:${snapshotId}`); },
		};
		const id = await persistInsightSnapshot(persistence, buildProductMarketInsight(productEvidence, CUTOFF));
		assert.equal(id, "snapshot-ok");
		assert.deepEqual(calls, ["parent:9", "links:snapshot-ok:9"]);
	}

	for (const scenario of ["link-error", "count-mismatch"] as const) {
		const calls: string[] = [];
		const persistence: SnapshotPersistence = {
			async insertParent() { calls.push("parent"); return `snapshot-${scenario}`; },
			async insertEvidenceLinks(_snapshotId, evidenceIds) {
				calls.push("links");
				if (scenario === "link-error") throw new Error("link unavailable");
				return evidenceIds.length - 1;
			},
			async deleteParent() { calls.push("delete"); },
		};
		await assert.rejects(
			() => persistInsightSnapshot(persistence, buildProductMarketInsight(productEvidence, CUTOFF)),
			scenario === "link-error" ? /link unavailable/ : /evidence link count mismatch/,
		);
		assert.deepEqual(calls, ["parent", "links", "delete"], `${scenario} deletes the unlinked snapshot parent`);
	}

	{
		const persistence: SnapshotPersistence = {
			async insertParent() { return "snapshot-cleanup-fails"; },
			async insertEvidenceLinks() { throw new Error("link unavailable"); },
			async deleteParent() { throw new Error("delete unavailable"); },
		};
		await assert.rejects(
			() => persistInsightSnapshot(persistence, buildProductMarketInsight(productEvidence, CUTOFF)),
			/link unavailable.*snapshot cleanup failed: delete unavailable/,
			"cleanup failure is surfaced alongside the primary link failure",
		);
	}

	{
		const events: Array<{ status: string; counts?: Partial<PipelineRunCounts> }> = [];
		let writes = 0;
		const result = await refreshIntelligenceInsights({} as never, CUTOFF, 200, {
			repository: repository({
				async listActiveSubjectHeads() {
					return [{ subjectType: "product", subjectId: "unchanged", newestObservedAt: "2026-08-20T00:00:00.000Z" }];
				},
				async loadLatestInsightCutoffs() {
					return new Map([["product\u0000unchanged", "2026-08-20T00:00:00.000Z"]]);
				},
				async writeSnapshot() { writes += 1; return "unexpected"; },
			}),
			startPipelineRun: async () => pipelineHandle(events),
		});
		assert.equal(writes, 0, "no evidence newer than the matching insight cutoff writes no snapshot");
		assert.equal(result.skippedNoNewEvidence, 1);
		assert.equal(result.status, "succeeded");
		assert.deepEqual(events.map((event) => event.status), ["succeeded"]);
		assert.deepEqual(events[0]?.counts, { new: 0, updated: 0, duplicate: 1, failed: 0, processed: 1 });
	}

	{
		const heads = Array.from({ length: 205 }, (_, index) => ({
			subjectType: "product" as const,
			subjectId: `product-${String(index).padStart(3, "0")}`,
			newestObservedAt: new Date(Date.parse(CUTOFF) - index * 1_000).toISOString(),
		}));
		const writes: string[] = [];
		let observedRepositoryLimit = 0;
		const result = await refreshIntelligenceInsights({} as never, CUTOFF, 999, {
			repository: repository({
				async listActiveSubjectHeads(_cutoff, limit) { observedRepositoryLimit = limit; return heads; },
				async loadProductEvidence(productId) {
					return [evidence({ id: `price-${productId}`, subjectId: productId, predicate: "price_jpy", value: 1_000 })];
				},
				async writeSnapshot(draft) { writes.push(draft.subjectId); return `snapshot-${draft.subjectId}`; },
			}),
			startPipelineRun: async () => null,
		});
		assert.equal(observedRepositoryLimit, 200);
		assert.equal(writes.length, 200, "orchestrator defends the 200-subject bound even when a repository over-returns");
		assert.equal(result.consideredSubjects, 200);
		assert.equal(result.productSnapshots, 200);
		assert.deepEqual(writes, heads.slice(0, 200).map((head) => head.subjectId), "refresh order is deterministic");
	}

	{
		const events: Array<{ status: string; counts?: Partial<PipelineRunCounts> }> = [];
		const written: Array<{ subjectType: string; subjectId: string; evidenceIds: string[] }> = [];
		const result = await refreshIntelligenceInsights({} as never, CUTOFF, 200, {
			repository: repository({
				async listActiveSubjectHeads() {
					return [
						{ subjectType: "broadcast", subjectId: "broadcast-1", newestObservedAt: "2026-08-28T03:00:00.000Z" },
						{ subjectType: "broadcast", subjectId: "broadcast-2", newestObservedAt: "2026-08-28T02:00:00.000Z" },
						{ subjectType: "broadcast", subjectId: "missing", newestObservedAt: "2026-08-28T01:00:00.000Z" },
					];
				},
				async resolveBroadcastCategories() {
					return new Map([["broadcast-1", "家電"], ["broadcast-2", "家電"], ["missing", null]]);
				},
				async loadCategoryEvidence(category) {
					assert.equal(category, "家電");
					return broadcastEvidence;
				},
				async writeSnapshot(draft) {
					written.push({ subjectType: draft.subjectType, subjectId: draft.subjectId, evidenceIds: draft.evidenceIds });
					return "category-snapshot";
				},
			}),
			startPipelineRun: async () => pipelineHandle(events),
		});
		assert.equal(result.categorySnapshots, 1);
		assert.deepEqual(result.unresolvedBroadcastIds, ["missing"]);
		assert.deepEqual(written, [{ subjectType: "category", subjectId: "家電", evidenceIds: broadcastEvidence.map((item) => item.id).sort() }]);
		assert.equal(result.status, "partial");
		assert.deepEqual(events.map((event) => event.status), ["partial"]);
		assert.deepEqual(events[0]?.counts, { new: 1, updated: 0, duplicate: 0, failed: 1, processed: 3 });
	}

	{
		const events: Array<{ status: string; counts?: Partial<PipelineRunCounts> }> = [];
		await assert.rejects(
			() => refreshIntelligenceInsights({} as never, CUTOFF, 200, {
				repository: repository({ async listActiveSubjectHeads() { throw new Error("evidence query failed"); } }),
				startPipelineRun: async () => pipelineHandle(events),
			}),
			/evidence query failed/,
		);
		assert.deepEqual(events.map((event) => event.status), ["running", "failed"], "fatal data errors retain observed counts before failed settlement");
	}

	{
		const reports: string[] = [];
		let wrote = false;
		const result = await refreshIntelligenceInsights({} as never, CUTOFF, 1, {
			repository: repository({
				async listActiveSubjectHeads() { return [{ subjectType: "product", subjectId: "telemetry", newestObservedAt: "2026-08-28T00:00:00.000Z" }]; },
				async loadProductEvidence() { return [evidence({ id: "telemetry-price", subjectId: "telemetry", predicate: "price_jpy", value: 5_000 })]; },
				async writeSnapshot() { wrote = true; return "telemetry-snapshot"; },
			}),
			startPipelineRun: async () => ({
				...pipelineHandle([]),
				async succeed() { throw new Error("telemetry settlement unavailable"); },
			}),
			reportTelemetryFailure: (phase) => reports.push(phase),
		});
		assert.equal(wrote, true);
		assert.equal(result.productSnapshots, 1, "telemetry settlement failure does not mask a completed data write");
		assert.deepEqual(reports, ["settle"]);
	}
}

async function testCronRoute(): Promise<void> {
	assert.equal(refreshInsightsMaxDuration, 300);
	assert.equal(isRefreshInsightsCronAuthorized(new Headers(), undefined), false, "missing CRON_SECRET fails closed");
	assert.equal(isRefreshInsightsCronAuthorized(new Headers({ authorization: "Bearer wrong" }), "secret"), false);
	assert.equal(isRefreshInsightsCronAuthorized(new Headers({ authorization: "Bearer secret" }), "secret"), true);
	let receivedLimit = 0;
	let receivedCutoff = "";
	const response = await runRefreshInsightsCron(
		new Request("https://example.test/api/cron/refresh-intelligence-insights", {
			headers: { authorization: "Bearer secret" },
		}),
		{
			secret: "secret",
			now: () => new Date(CUTOFF),
			getClient: () => ({} as never),
			refresh: async (_sb, cutoff, limit) => {
				receivedCutoff = cutoff;
				receivedLimit = limit;
				return {
					status: "succeeded",
					cutoff,
					limit,
					consideredSubjects: 2,
					eligibleInsightSubjects: 2,
					productSnapshots: 1,
					categorySnapshots: 1,
					skippedNoNewEvidence: 0,
					unresolvedBroadcastIds: [],
					errors: [],
					counts: { new: 2, updated: 0, duplicate: 0, failed: 0, processed: 2 },
				};
			},
		},
	);
	assert.equal(response.status, 200);
	assert.equal(receivedLimit, 200);
	assert.equal(receivedCutoff, CUTOFF);
	assert.deepEqual(await response.json(), {
		ok: true,
		status: "succeeded",
		cutoff: CUTOFF,
		limit: 200,
		consideredSubjects: 2,
		eligibleInsightSubjects: 2,
		productSnapshots: 1,
		categorySnapshots: 1,
		skippedNoNewEvidence: 0,
		unresolvedBroadcastIds: [],
		errors: [],
		counts: { new: 2, updated: 0, duplicate: 0, failed: 0, processed: 2 },
	});

	let unauthorizedRefreshCalled = false;
	const unauthorized = await runRefreshInsightsCron(new Request("https://example.test"), {
		secret: "secret",
		getClient: () => ({} as never),
		refresh: async () => {
			unauthorizedRefreshCalled = true;
			throw new Error("must not run");
		},
	});
	assert.equal(unauthorized.status, 401);
	assert.equal(unauthorizedRefreshCalled, false);

	const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
		functions: Record<string, { maxDuration: number }>;
		crons: Array<{ path: string; schedule: string }>;
	};
	assert.deepEqual(vercel.functions["app/api/cron/refresh-intelligence-insights/route.ts"], { maxDuration: 300 });
	const scheduled = vercel.crons.filter((cron) => cron.path === "/api/cron/refresh-intelligence-insights");
	assert.deepEqual(scheduled, [{ path: "/api/cron/refresh-intelligence-insights", schedule: "0 20 * * *" }]);
	assert.ok(
		vercel.crons.findIndex((cron) => cron.path === "/api/cron/refresh-intelligence-insights")
			> vercel.crons.findIndex((cron) => cron.path === "/api/cron/analyze-broadcast-audio"),
		"insight refresh is ordered after the existing 19:00 analysis schedule",
	);
	const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
		scripts: Record<string, string>;
	};
	assert.equal(packageJson.scripts["test:intelligence-insights"], "tsx scripts/test-intelligence-insights.ts");
}

testRefresh()
	.then(testCronRoute)
	.then(() => console.log("PASS: bounded incremental insight refresh and cron route"))
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
