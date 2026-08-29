import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
	buildBroadcastCategoryInsight,
	buildProductMarketInsight,
	selectActiveEvidence,
} from "../lib/intelligence/insights";
import type { EvidenceItem, EvidenceValueState } from "../lib/intelligence/types";
import {
	INITIAL_INSIGHT_SCAN_STATE,
	createInsightRefreshRepository,
	persistInsightSnapshot,
	refreshIntelligenceInsights,
	resolveStoredBroadcastCategories,
	type EvidenceScanCursor,
	type EvidenceScanState,
	type InsightRefreshRepository,
} from "../lib/intelligence/refresh-insights";
import type { PipelineRunCounts, PipelineRunHandle } from "../lib/intelligence/pipeline-run";
import {
	acquireRefreshInsightsInvocation,
	refreshInsightsInvocationBucket,
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

{
	const conflictingCategory = buildBroadcastCategoryInsight([
		evidence({ id: "conflicting-structure", subjectType: "broadcast", subjectId: "conflicting-broadcast", predicate: "segment_pattern", valueState: "conflicting", sourceType: "qvc", sourceTable: "broadcast_speech_analyses", sourceRecordId: "conflicting-broadcast" }),
	], "家電", CUTOFF);
	const result = conflictingCategory.result as any;
	assert.equal(conflictingCategory.coverage.structurePatterns, "conflicting");
	assert.equal(result.structurePatternAvailability, undefined, "conflicting structures remain coverage-only, never numeric zero");
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

function repository(overrides: Record<string, unknown> = {}): InsightRefreshRepository {
	return {
		async loadScanState() { return INITIAL_INSIGHT_SCAN_STATE; },
		async scanActiveEvidencePage() { return { evidence: [], reachedEnd: true }; },
		async saveScanState() {},
		async resolveBroadcastCategories() { return new Map(); },
		async loadLatestInsightCutoffs() { return new Map(); },
		async loadProductEvidence() { throw new Error("unexpected product evidence load"); },
		async loadBroadcastEvidence() { throw new Error("unexpected broadcast evidence load"); },
		async writeSnapshot() { throw new Error("unexpected snapshot write"); },
		...overrides,
	} as InsightRefreshRepository;
}

function databaseEvidenceRow(item: EvidenceItem): Record<string, unknown> {
	return {
		id: item.id,
		dedupe_key: item.dedupeKey,
		subject_type: item.subjectType,
		subject_id: item.subjectId,
		predicate: item.predicate,
		value_json: item.value ?? null,
		unit: item.unit ?? null,
		value_state: item.valueState,
		evidence_class: item.evidenceClass,
		source_type: item.sourceType,
		source_table: item.sourceTable,
		source_record_id: item.sourceRecordId,
		source_url: item.sourceUrl ?? null,
		source_locator: item.sourceLocator ?? null,
		observed_at: item.observedAt,
		valid_from: item.validFrom ?? null,
		valid_until: item.validUntil ?? null,
		confidence: item.confidence,
		raw_hash: item.rawHash ?? null,
	};
}

function memoryRefreshRepository(input: {
	evidence: EvidenceItem[];
	latest?: Map<string, string>;
	categories?: Map<string, string | null>;
	state?: EvidenceScanState;
}) {
	let state: EvidenceScanState = input.state ?? INITIAL_INSIGHT_SCAN_STATE;
	const writes: Array<{ subjectType: string; subjectId: string; evidenceIds: string[] }> = [];
	const loadedBroadcastGroups: string[][] = [];
	const latestRequests: string[][] = [];
	const latest = input.latest ?? new Map<string, string>();
	const categories = input.categories ?? new Map<string, string | null>();
	const repo = repository({
		async loadScanState() { return state; },
		async scanActiveEvidencePage(_cutoff: string, cursor: EvidenceScanCursor | null, pageSize: number) {
			const start = cursor ? input.evidence.findIndex((item) => item.id === cursor.evidenceId) + 1 : 0;
			const evidencePage = input.evidence.slice(start, start + pageSize);
			return { evidence: evidencePage, reachedEnd: start + evidencePage.length >= input.evidence.length };
		},
		async saveScanState(_runId: string, next: EvidenceScanState) { state = next; },
		async resolveBroadcastCategories(ids: string[]) {
			return new Map(ids.map((id) => [id, categories.get(id) ?? null]));
		},
		async loadLatestInsightCutoffs(subjects: Array<{ subjectType: "product" | "category"; subjectId: string }>) {
			latestRequests.push(subjects.map((subject) => subject.subjectId));
			return new Map(subjects.flatMap((subject) => {
				const value = latest.get(`${subject.subjectType}\u0000${subject.subjectId}`);
				return value ? [[`${subject.subjectType}\u0000${subject.subjectId}`, value] as const] : [];
			}));
		},
		async loadProductEvidence(productId: string) {
			return [evidence({ id: `snapshot-${productId}`, subjectId: productId, predicate: "price_jpy", value: 1_000 })];
		},
		async loadBroadcastEvidence(broadcastIds: string[]) {
			const ids = [...broadcastIds].sort();
			loadedBroadcastGroups.push(ids);
			return ids.flatMap((broadcastId, index) => [
				evidence({ id: `${broadcastId}-category`, subjectType: "broadcast", subjectId: broadcastId, predicate: "normalized_category", value: categories.get(broadcastId), evidenceClass: "verified", sourceType: index % 2 ? "shopch" : "qvc", sourceTable: "broadcasts", sourceRecordId: broadcastId }),
				evidence({ id: `${broadcastId}-date`, subjectType: "broadcast", subjectId: broadcastId, predicate: "air_date", value: `2026-08-${20 + index}`, evidenceClass: "verified", sourceType: index % 2 ? "shopch" : "qvc", sourceTable: "broadcast_speech_analyses", sourceRecordId: broadcastId }),
			]);
		},
		async writeSnapshot(draft: any) {
			writes.push({ subjectType: draft.subjectType, subjectId: draft.subjectId, evidenceIds: draft.evidenceIds });
			latest.set(`${draft.subjectType}\u0000${draft.subjectId}`, draft.inputUntil);
			return `written-${draft.subjectId}`;
		},
	});
	return { repository: repo, writes, loadedBroadcastGroups, latestRequests, latest, get state() { return state; } };
}

async function testRefreshRound1(): Promise<void> {
	{
		const draft = buildProductMarketInsight(productEvidence, CUTOFF);
		let deleted = false;
		await assert.rejects(
			persistInsightSnapshot({
				async insertParent() { return "rollback-parent"; },
				async insertEvidenceLinks() { throw new Error("link insert unavailable"); },
				async deleteParent() { deleted = true; },
			}, draft),
			/link insert unavailable/,
		);
		assert.equal(deleted, true, "a link failure compensates by deleting the new parent");

		await assert.rejects(
			persistInsightSnapshot({
				async insertParent() { return "cleanup-parent"; },
				async insertEvidenceLinks() { return draft.evidenceIds.length - 1; },
				async deleteParent() { throw new Error("cleanup unavailable"); },
			}, draft),
			/evidence link count mismatch.*snapshot cleanup failed: cleanup unavailable/,
			"the primary count mismatch and cleanup failure are both surfaced",
		);
	}

	{
		const conflictingCurrent = resolveStoredBroadcastCategories(
			["broadcast-explicit", "broadcast-domain"],
			[
				evidence({ id: "old-explicit", subjectType: "broadcast", subjectId: "broadcast-explicit", predicate: "normalized_category", value: "旧分類", evidenceClass: "verified", sourceTable: "broadcasts", sourceRecordId: "same", observedAt: "2026-08-10T00:00:00.000Z" }),
				evidence({ id: "current-conflict", subjectType: "broadcast", subjectId: "broadcast-explicit", predicate: "normalized_category", valueState: "conflicting", evidenceClass: "verified", sourceTable: "broadcasts", sourceRecordId: "same", observedAt: "2026-08-20T00:00:00.000Z" }),
				evidence({ id: "current-explicit", subjectType: "broadcast", subjectId: "broadcast-explicit", predicate: "category", value: "家電", evidenceClass: "verified", sourceTable: "manual_category", sourceRecordId: "manual", observedAt: "2026-08-21T00:00:00.000Z" }),
			],
			[
				{ broadcastId: "broadcast-explicit", category: "美容", source: "broadcast_speech_analyses" },
				{ broadcastId: "broadcast-explicit", category: "生活", source: "broadcasts" },
				{ broadcastId: "broadcast-domain", category: "コスメ", source: "broadcast_speech_analyses" },
				{ broadcastId: "broadcast-domain", category: "服飾", source: "broadcasts" },
			],
			CUTOFF,
		);
		assert.deepEqual([...conflictingCurrent.entries()], [
			["broadcast-domain", "コスメ"],
			["broadcast-explicit", "家電"],
		], "one current explicit category wins; otherwise the stored source-domain precedence supplies exactly one category");
	}

	{
		const cursor: EvidenceScanCursor = {
			observedAt: "2026-08-28T12:00:00.000Z",
			subjectType: "product",
			subjectId: "product-a",
			evidenceId: "evidence-a",
		};
		const row = evidence({ id: "evidence-b", subjectId: "product-b", predicate: "price_jpy", value: 2_000, observedAt: "2026-08-28T11:00:00.000Z" });
		const orders: Array<[string, boolean]> = [];
		let cursorFilter = "";
		let requestedLimit = 0;
		const client = {
			from(table: string) {
				assert.equal(table, "evidence_items");
				const builder: any = {
					select: () => builder,
					in: () => builder,
					lte: () => builder,
					neq: () => builder,
					or(value: string) { cursorFilter = value; return builder; },
					order(column: string, options: { ascending: boolean }) { orders.push([column, options.ascending]); return builder; },
					limit(value: number) { requestedLimit = value; return Promise.resolve({ data: [databaseEvidenceRow(row)], error: null }); },
				};
				return builder;
			},
		};
		const page = await createInsightRefreshRepository(client as never).scanActiveEvidencePage(CUTOFF, cursor, 2);
		assert.deepEqual(page, { evidence: [row], reachedEnd: true });
		assert.equal(requestedLimit, 2);
		assert.deepEqual(orders.slice(-4), [["observed_at", false], ["subject_type", true], ["subject_id", true], ["id", true]]);
		assert.match(cursorFilter, /observed_at\.lt\.2026-08-28T12:00:00\.000Z/);
		assert.match(cursorFilter, /subject_id\.gt\.product-a/);
		assert.match(cursorFilter, /id\.gt\.evidence-a/);
	}

	{
		const storedState: EvidenceScanState = {
			v: 1,
			position: { observedAt: "2026-08-27T00:00:00.000Z", subjectType: "broadcast", subjectId: "broadcast-9", evidenceId: "evidence-9" },
		};
		let savedPayload: Record<string, unknown> | undefined;
		let excludedRun = "";
		const client = {
			from(table: string) {
				assert.equal(table, "data_pipeline_runs");
				const builder: any = {
					select: () => builder,
					eq: () => builder,
					not: () => builder,
					neq(_column: string, value: string) { excludedRun = value; return builder; },
					order: () => builder,
					limit: () => builder,
					maybeSingle: async () => ({ data: { cursor_json: storedState }, error: null }),
					update(payload: Record<string, unknown>) { savedPayload = payload; return builder; },
					single: async () => ({ data: { id: "current-run" }, error: null }),
				};
				return builder;
			},
		};
		const production = createInsightRefreshRepository(client as never);
		assert.deepEqual(await production.loadScanState("current-run"), storedState);
		await production.saveScanState("current-run", INITIAL_INSIGHT_SCAN_STATE);
		assert.equal(excludedRun, "current-run");
		assert.deepEqual(savedPayload, { cursor_json: INITIAL_INSIGHT_SCAN_STATE });
	}

	{
		const requestedTables: string[] = [];
		let exactBroadcastIds: string[] = [];
		const row = evidence({ id: "b-exact-date", subjectType: "broadcast", subjectId: "broadcast-exact", predicate: "air_date", value: "2026-08-20", sourceType: "qvc", sourceTable: "broadcast_speech_analyses", sourceRecordId: "broadcast-exact" });
		const client = {
			from(table: string) {
				requestedTables.push(table);
				const builder: any = {
					select: () => builder,
					in(column: string, values: string[]) { if (column === "subject_id") exactBroadcastIds = values; return builder; },
					lte: () => builder,
					neq: () => builder,
					or: () => builder,
					order: () => builder,
					range: async () => ({ data: [databaseEvidenceRow(row)], error: null }),
				};
				return builder;
			},
		};
		const loaded = await createInsightRefreshRepository(client as never).loadBroadcastEvidence(["broadcast-exact"], CUTOFF);
		assert.deepEqual(loaded, [row]);
		assert.deepEqual(exactBroadcastIds, ["broadcast-exact"]);
		assert.deepEqual(requestedTables, ["evidence_items"], "bounded category evidence loading never queries a whole source-domain category");
	}

	{
		const requestedIds = new Map<string, string[]>();
		const explicit = evidence({
			id: "explicit-category",
			subjectType: "broadcast",
			subjectId: "broadcast-resolved",
			predicate: "normalized_category",
			value: "明示分類",
			evidenceClass: "verified",
			sourceTable: "manual_category",
			sourceRecordId: "broadcast-resolved",
		});
		const domainData: Record<string, Array<Record<string, unknown>>> = {
			broadcast_speech_analyses: [{ broadcast_id: "broadcast-resolved", category: "音声分類" }],
			broadcasts: [{ id: "broadcast-resolved", category: "放送分類" }],
			historical_broadcasts: [{ id: "broadcast-resolved", category: "履歴分類" }],
		};
		const client = {
			from(table: string) {
				const builder: any = {
					select: () => builder,
					in(column: string, values: string[]) {
						if (column === "subject_id" || column === "broadcast_id" || column === "id") requestedIds.set(table, values);
						return builder;
					},
					lte: () => builder,
					neq: () => builder,
					or: () => builder,
					order: () => builder,
					range: async () => ({ data: [databaseEvidenceRow(explicit)], error: null }),
					then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
						return Promise.resolve({ data: domainData[table] ?? [], error: null }).then(resolve, reject);
					},
				};
				return builder;
			},
		};
		const resolved = await createInsightRefreshRepository(client as never)
			.resolveBroadcastCategories(["broadcast-resolved"], CUTOFF);
		assert.equal(resolved.get("broadcast-resolved"), "明示分類", "production resolution applies explicit-evidence precedence");
		for (const table of ["evidence_items", "broadcast_speech_analyses", "broadcasts", "historical_broadcasts"]) {
			assert.deepEqual(requestedIds.get(table), ["broadcast-resolved"], `${table} is constrained to the bounded broadcast IDs`);
		}
	}

	{
		const draft = buildProductMarketInsight(productEvidence, CUTOFF);
		let parentPayload: Record<string, unknown> | undefined;
		let linkedRows: Array<Record<string, unknown>> = [];
		let deletedParent = false;
		const client = {
			from(table: string) {
				const builder: any = {
					insert(payload: Record<string, unknown> | Array<Record<string, unknown>>) {
						if (table === "insight_snapshots") parentPayload = payload as Record<string, unknown>;
						else linkedRows = payload as Array<Record<string, unknown>>;
						return builder;
					},
					select() {
						if (table === "insight_snapshot_evidence") {
							return Promise.resolve({ data: linkedRows.map((row) => ({ evidence_item_id: row.evidence_item_id })), error: null });
						}
						return builder;
					},
					single: async () => ({ data: { id: "production-parent" }, error: null }),
					delete() { deletedParent = true; return builder; },
					eq: async () => ({ error: null }),
				};
				return builder;
			},
		};
		const snapshotId = await createInsightRefreshRepository(client as never).writeSnapshot(draft);
		assert.equal(snapshotId, "production-parent");
		assert.equal(parentPayload?.evidence_count, draft.evidenceIds.length);
		assert.deepEqual(
			linkedRows.map((row) => row.evidence_item_id),
			draft.evidenceIds,
			"the production adapter writes every and only used evidence ID",
		);
		assert.equal(deletedParent, false);
	}

	{
		const draft = buildProductMarketInsight(productEvidence, CUTOFF);
		let deletedParent = false;
		const client = {
			from(table: string) {
				const builder: any = {
					insert: () => builder,
					select() {
						return table === "insight_snapshot_evidence"
							? Promise.resolve({ data: [], error: null })
							: builder;
					},
					single: async () => ({ data: { id: "mismatch-parent" }, error: null }),
					delete() { deletedParent = true; return builder; },
					eq: async () => ({ error: null }),
				};
				return builder;
			},
		};
		await assert.rejects(
			createInsightRefreshRepository(client as never).writeSnapshot(draft),
			/evidence link count mismatch/,
		);
		assert.equal(deletedParent, true, "the production adapter deletes its parent after a returned link-count mismatch");
	}

	{
		const stale = Array.from({ length: 201 }, (_, index) => evidence({
			id: `stale-${String(index).padStart(3, "0")}`,
			subjectId: `stale-${String(index).padStart(3, "0")}`,
			predicate: "price_jpy",
			value: 1_000,
			observedAt: new Date(Date.parse("2026-08-28T23:00:00.000Z") - index * 1_000).toISOString(),
		}));
		const eligibleOne = evidence({ id: "eligible-one", subjectId: "eligible-one", predicate: "price_jpy", value: 2_000, observedAt: "2026-08-27T00:00:00.000Z" });
		const eligibleTwo = evidence({ id: "eligible-two", subjectId: "eligible-two", predicate: "price_jpy", value: 3_000, observedAt: "2026-08-26T00:00:00.000Z" });
		const latest = new Map(stale.map((item) => [`product\u0000${item.subjectId}`, CUTOFF]));
		const memory = memoryRefreshRepository({ evidence: [...stale, eligibleOne, eligibleTwo], latest });
		const first = await refreshIntelligenceInsights({} as never, CUTOFF, 1, { repository: memory.repository, startPipelineRun: async () => pipelineHandle([]) });
		assert.deepEqual(memory.writes.map((write) => write.subjectId), ["eligible-one"], "the scan passes more than 200 ineligible heads to find an eligible subject");
		assert.equal(memory.state.position?.evidenceId, "eligible-one");
		assert.equal(first.scannedEvidenceRows, 202);
		const second = await refreshIntelligenceInsights({} as never, CUTOFF, 1, { repository: memory.repository, startPipelineRun: async () => pipelineHandle([]) });
		assert.deepEqual(memory.writes.map((write) => write.subjectId), ["eligible-one", "eligible-two"], "the next run resumes strictly after the persisted cursor");
		assert.equal(memory.state.position?.evidenceId, "eligible-two");

		const eligibleAfterWrap = evidence({ id: "eligible-after-wrap", subjectId: "eligible-after-wrap", predicate: "price_jpy", value: 4_000, observedAt: "2026-08-28T23:30:00.000Z" });
		memory.repository.scanActiveEvidencePage = async (_cutoff, cursor, pageSize) => {
			const rows = [eligibleAfterWrap, ...stale, eligibleOne, eligibleTwo];
			const start = cursor ? rows.findIndex((item) => item.id === cursor.evidenceId) + 1 : 0;
			const page = rows.slice(start, start + pageSize);
			return { evidence: page, reachedEnd: start + page.length >= rows.length };
		};
		const third = await refreshIntelligenceInsights({} as never, CUTOFF, 1, { repository: memory.repository, startPipelineRun: async () => pipelineHandle([]) });
		assert.equal(third.scanWrapped, true);
		assert.deepEqual(memory.writes.map((write) => write.subjectId), ["eligible-one", "eligible-two", "eligible-after-wrap"], "an end cursor wraps once and reaches newly inserted evidence at the front");
	}

	{
		const rows = [
			evidence({ id: "cycle-a", subjectId: "cycle-a", predicate: "price_jpy", value: 1_000, observedAt: "2026-08-28T03:00:00.000Z" }),
			evidence({ id: "cycle-b", subjectId: "cycle-b", predicate: "price_jpy", value: 1_000, observedAt: "2026-08-28T02:00:00.000Z" }),
			evidence({ id: "cycle-c", subjectId: "cycle-c", predicate: "price_jpy", value: 1_000, observedAt: "2026-08-28T01:00:00.000Z" }),
		];
		const boundary: EvidenceScanState = { v: 1, position: {
			observedAt: rows[1].observedAt,
			subjectType: "product",
			subjectId: rows[1].subjectId,
			evidenceId: rows[1].id,
		} };
		const latest = new Map(rows.map((item) => [`product\u0000${item.subjectId}`, CUTOFF]));
		const memory = memoryRefreshRepository({ evidence: rows, latest, state: boundary });
		const first = await refreshIntelligenceInsights({} as never, CUTOFF, 200, {
			repository: memory.repository,
			startPipelineRun: async () => pipelineHandle([]),
		});
		assert.equal(first.scanWrapped, true);
		assert.equal(first.scannedEvidenceRows, 2, "resuming at B scans tail C then wrapped head A, never B/C again");
		assert.deepEqual(memory.latestRequests.flat(), ["cycle-c", "cycle-a"]);
		assert.deepEqual(memory.state, boundary, "a no-eligible full cycle retains its original safe resume boundary");

		const inserted = evidence({ id: "cycle-new", subjectId: "cycle-new", predicate: "price_jpy", value: 2_000, observedAt: "2026-08-28T04:00:00.000Z" });
		rows.unshift(inserted);
		const second = await refreshIntelligenceInsights({} as never, CUTOFF, 1, {
			repository: memory.repository,
			startPipelineRun: async () => pipelineHandle([]),
		});
		assert.deepEqual(memory.writes.map((write) => write.subjectId), ["cycle-new"], "the retained boundary still discovers a newly inserted head on the next wrap");
		assert.equal(second.scanWrapped, true);
	}

	{
		const boundary: EvidenceScanCursor = {
			observedAt: "2026-08-28T02:00:00.000Z",
			subjectType: "internal_product",
			subjectId: "middle",
			evidenceId: "deleted-boundary",
		};
		const headNewer = evidence({ id: "mixed-newer", subjectId: "mixed-newer", predicate: "price_jpy", value: 1_000, observedAt: "2026-08-28T03:00:00.000Z" });
		const headSameTime = evidence({ id: "mixed-broadcast", subjectType: "broadcast", subjectId: "mixed-broadcast", predicate: "segment_pattern", value: [], observedAt: boundary.observedAt });
		const headSameSubject = evidence({ id: "aaa-before-deleted", subjectType: "internal_product", subjectId: boundary.subjectId, predicate: "gross_profit_jpy", value: 1_000, evidenceClass: "internal_input", observedAt: boundary.observedAt });
		const tailSameType = evidence({ id: "mixed-internal-z", subjectType: "internal_product", subjectId: "z-last", predicate: "gross_profit_jpy", value: 1_000, evidenceClass: "internal_input", observedAt: boundary.observedAt });
		const tailLaterType = evidence({ id: "mixed-product", subjectId: "mixed-product", predicate: "price_jpy", value: 1_000, observedAt: boundary.observedAt });
		const latest = new Map([
			["product\u0000mixed-newer", CUTOFF],
			["product\u0000middle", CUTOFF],
			["product\u0000z-last", CUTOFF],
			["product\u0000mixed-product", CUTOFF],
		]);
		let calls = 0;
		const latestRequests: string[] = [];
		const repo = repository({
			async loadScanState() { return { v: 1, position: boundary }; },
			async scanActiveEvidencePage(_cutoff: string, cursor: EvidenceScanCursor | null) {
				calls += 1;
				return cursor
					? { evidence: [tailSameType, tailLaterType], reachedEnd: true }
					: { evidence: [headNewer, headSameTime, headSameSubject, tailSameType, tailLaterType], reachedEnd: true };
			},
			async resolveBroadcastCategories(ids: string[]) { return new Map(ids.map((id) => [id, null])); },
			async loadLatestInsightCutoffs(subjects: Array<{ subjectId: string }>) {
				latestRequests.push(...subjects.map((subject) => subject.subjectId));
				return new Map(subjects.flatMap((subject) => {
					const productCutoff = latest.get(`product\u0000${subject.subjectId}`);
					return productCutoff ? [[`product\u0000${subject.subjectId}`, productCutoff] as const] : [];
				}));
			},
		});
		let saved: EvidenceScanState | undefined;
		repo.saveScanState = async (_runId, state) => { saved = state; };
		const result = await refreshIntelligenceInsights({} as never, CUTOFF, 200, {
			repository: repo,
			startPipelineRun: async () => pipelineHandle([]),
		});
		assert.equal(calls, 2);
		assert.equal(result.scannedEvidenceRows, 5, "a deleted boundary is crossed by tuple order without rescanning the tail");
		assert.deepEqual(latestRequests, ["z-last", "mixed-product", "mixed-newer", "middle"]);
		assert.deepEqual(saved, { v: 1, position: boundary }, "mixed-direction tuple comparison retains the deleted resume boundary after a full cycle");
	}

	{
		const rows = Array.from({ length: 205 }, (_, index) => evidence({
			id: `bounded-${String(index).padStart(3, "0")}`,
			subjectId: `bounded-${String(index).padStart(3, "0")}`,
			predicate: "price_jpy",
			value: 1_000,
			observedAt: new Date(Date.parse("2026-08-28T23:00:00.000Z") - index * 1_000).toISOString(),
		}));
		const memory = memoryRefreshRepository({ evidence: rows });
		const result = await refreshIntelligenceInsights({} as never, CUTOFF, 999, { repository: memory.repository, startPipelineRun: async () => pipelineHandle([]) });
		assert.equal(memory.writes.length, 200);
		assert.equal(result.productSnapshots, 200);
		assert.equal(result.counts.processed, 200);
		assert.equal(result.counts.processed, result.counts.new + result.counts.duplicate + result.counts.failed);
		assert.equal(memory.state.position?.evidenceId, rows[199].id);
	}

	{
		const rows = Array.from({ length: 10_001 }, (_, index) => evidence({
			id: `scan-cap-${String(index).padStart(5, "0")}`,
			subjectId: `scan-cap-${String(index).padStart(5, "0")}`,
			predicate: "price_jpy",
			value: 1_000,
			observedAt: new Date(Date.parse("2026-08-28T23:59:59.000Z") - index).toISOString(),
		}));
		const latest = new Map(rows.map((item) => [`product\u0000${item.subjectId}`, CUTOFF]));
		const memory = memoryRefreshRepository({ evidence: rows, latest });
		const result = await refreshIntelligenceInsights({} as never, CUTOFF, 200, {
			repository: memory.repository,
			startPipelineRun: async () => pipelineHandle([]),
		});
		assert.equal(result.scannedEvidenceRows, 10_000, "a run never scans more than the ruled evidence-row cap");
		assert.equal(result.scanTruncated, true);
		assert.equal(memory.state.position?.evidenceId, rows[9_999].id);
		assert.equal(memory.writes.length, 0);
		assert.deepEqual(result.counts, { new: 0, updated: 0, duplicate: 10_000, failed: 0, processed: 10_000 });
	}

	{
		const rows = Array.from({ length: 10_001 }, (_, index) => evidence({
			id: `wrapped-cap-${String(index).padStart(5, "0")}`,
			subjectId: `wrapped-cap-${String(index).padStart(5, "0")}`,
			predicate: "price_jpy",
			value: 1_000,
			observedAt: new Date(Date.parse("2026-08-28T23:59:59.000Z") - index).toISOString(),
		}));
		const boundaryRow = rows[5_000];
		const latest = new Map(rows.map((item) => [`product\u0000${item.subjectId}`, CUTOFF]));
		const memory = memoryRefreshRepository({
			evidence: rows,
			latest,
			state: { v: 1, position: {
				observedAt: boundaryRow.observedAt,
				subjectType: "product",
				subjectId: boundaryRow.subjectId,
				evidenceId: boundaryRow.id,
			} },
		});
		const result = await refreshIntelligenceInsights({} as never, CUTOFF, 200, {
			repository: memory.repository,
			startPipelineRun: async () => pipelineHandle([]),
		});
		const requestedSubjects = memory.latestRequests.flat();
		assert.equal(result.scannedEvidenceRows, 10_000);
		assert.equal(requestedSubjects.length, 10_000);
		assert.equal(new Set(requestedSubjects).size, 10_000, "the 10,000-row allowance contains only unique rows across a wrap");
		assert.equal(memory.state.position?.evidenceId, rows[4_999].id);
	}

	{
		const scanEvidence = [
			evidence({ id: "scan-b1", subjectType: "broadcast", subjectId: "broadcast-1", predicate: "segment_pattern", value: [{ label: "open" }], sourceType: "qvc", sourceTable: "broadcast_speech_analyses", sourceRecordId: "broadcast-1", observedAt: "2026-08-28T03:00:00.000Z" }),
			evidence({ id: "scan-b2", subjectType: "broadcast", subjectId: "broadcast-2", predicate: "segment_pattern", value: [{ label: "open" }], sourceType: "shopch", sourceTable: "broadcast_speech_analyses", sourceRecordId: "broadcast-2", observedAt: "2026-08-28T02:00:00.000Z" }),
			evidence({ id: "scan-missing", subjectType: "broadcast", subjectId: "missing", predicate: "segment_pattern", value: [{ label: "open" }], sourceType: "qvc", sourceTable: "broadcast_speech_analyses", sourceRecordId: "missing", observedAt: "2026-08-28T01:00:00.000Z" }),
		];
		const memory = memoryRefreshRepository({
			evidence: scanEvidence,
			categories: new Map([["broadcast-1", "家電"], ["broadcast-2", "家電"], ["missing", null]]),
		});
		const events: Array<{ status: string; counts?: Partial<PipelineRunCounts> }> = [];
		const result = await refreshIntelligenceInsights({} as never, CUTOFF, 200, { repository: memory.repository, startPipelineRun: async () => pipelineHandle(events) });
		assert.deepEqual(memory.loadedBroadcastGroups, [["broadcast-1", "broadcast-2"]]);
		assert.equal(memory.writes.length, 1);
		assert.equal(memory.writes[0].subjectId, "家電");
		assert.deepEqual(result.unresolvedBroadcastIds, ["missing"]);
		assert.deepEqual(result.counts, { new: 1, updated: 0, duplicate: 0, failed: 1, processed: 2 });
		assert.equal(result.counts.processed, result.counts.new + result.counts.duplicate + result.counts.failed);
		assert.ok(events.some((event) => event.status === "running"), "normal candidate progress emits a heartbeat");
		assert.equal(events.at(-1)?.status, "partial");
	}

	{
		const missing = evidence({ id: "missing-first", subjectType: "broadcast", subjectId: "missing-first", predicate: "segment_pattern", value: [{ label: "open" }], observedAt: "2026-08-28T03:00:00.000Z" });
		const eligible = evidence({ id: "eligible-after-missing", subjectId: "eligible-after-missing", predicate: "price_jpy", value: 1_000, observedAt: "2026-08-28T02:00:00.000Z" });
		const memory = memoryRefreshRepository({ evidence: [missing, eligible], categories: new Map([["missing-first", null]]) });
		const result = await refreshIntelligenceInsights({} as never, CUTOFF, 1, {
			repository: memory.repository,
			startPipelineRun: async () => pipelineHandle([]),
		});
		assert.deepEqual(memory.writes.map((write) => write.subjectId), ["eligible-after-missing"], "an unresolved broadcast does not consume the eligible-candidate bound");
		assert.deepEqual(result.unresolvedBroadcastIds, ["missing-first"]);
	}

	{
		const unchanged = evidence({ id: "unchanged", subjectId: "unchanged", predicate: "price_jpy", value: 1_000, observedAt: "2026-08-28T00:00:00.000Z" });
		const memory = memoryRefreshRepository({ evidence: [unchanged], latest: new Map([["product\u0000unchanged", CUTOFF]]) });
		const result = await refreshIntelligenceInsights({} as never, CUTOFF, 1, { repository: memory.repository, startPipelineRun: async () => pipelineHandle([]) });
		assert.deepEqual(result.counts, { new: 0, updated: 0, duplicate: 1, failed: 0, processed: 1 });
		assert.equal(result.counts.processed, result.counts.new + result.counts.duplicate + result.counts.failed);
		assert.equal(result.scannedEvidenceRows, 1, "a scan beginning at the head does not re-read the same cycle");
		assert.equal(result.scanWrapped, false, "only a resumed tail scan needs the one allowed wrap");
	}

	{
		const row = evidence({ id: "write-failure", subjectId: "write-failure", predicate: "price_jpy", value: 1_000 });
		const memory = memoryRefreshRepository({ evidence: [row] });
		memory.repository.writeSnapshot = async () => { throw new Error("snapshot unavailable"); };
		const events: Array<{ status: string; counts?: Partial<PipelineRunCounts> }> = [];
		const result = await refreshIntelligenceInsights({} as never, CUTOFF, 1, {
			repository: memory.repository,
			startPipelineRun: async () => pipelineHandle(events),
		});
		assert.deepEqual(result.counts, { new: 0, updated: 0, duplicate: 0, failed: 1, processed: 1 });
		assert.equal(result.status, "partial");
		assert.equal(events.at(-1)?.status, "partial", "a terminal candidate failure settles the pipeline run as partial");
	}

	{
		const events: Array<{ status: string; counts?: Partial<PipelineRunCounts> }> = [];
		await assert.rejects(
			refreshIntelligenceInsights({} as never, CUTOFF, 1, {
				repository: repository({ async loadScanState() { throw new Error("fatal repository failure"); } }),
				startPipelineRun: async () => pipelineHandle(events),
				reportTelemetryFailure: () => {},
			}),
			/fatal repository failure/,
		);
		assert.equal(events.at(-1)?.status, "failed", "a fatal data error settles the pipeline run as failed");
	}

	{
		const row = evidence({ id: "telemetry-product", subjectId: "telemetry-product", predicate: "price_jpy", value: 5_000, observedAt: "2026-08-28T00:00:00.000Z" });
		const originalWarn = console.warn;
		const fallbackWarnings: string[] = [];
		const reportedPhases: string[] = [];
		const unhandledRejections: unknown[] = [];
		const rejectReporter = async (phase: string): Promise<void> => {
			reportedPhases.push(phase);
			await Promise.resolve();
			throw new Error(`async reporter unavailable during ${phase}`);
		};
		const onUnhandledRejection = (reason: unknown): void => { unhandledRejections.push(reason); };
		process.on("unhandledRejection", onUnhandledRejection);
		console.warn = (...values: unknown[]) => { fallbackWarnings.push(values.map(String).join(" ")); };
		try {
			const startFailure = memoryRefreshRepository({ evidence: [row] });
			const startResult = await refreshIntelligenceInsights({} as never, CUTOFF, 1, {
				repository: startFailure.repository,
				startPipelineRun: async () => { throw new Error("start unavailable"); },
				reportTelemetryFailure: rejectReporter,
			});
			assert.equal(startResult.productSnapshots, 1);
			assert.equal(startResult.cursorPersisted, false);
			assert.ok(startResult.telemetryFailures.some((failure) => failure.phase === "start"));
			assert.ok(startResult.telemetryFailures.some((failure) => failure.phase === "cursor-save"));

			const telemetryRepository = memoryRefreshRepository({ evidence: [row] });
			telemetryRepository.repository.saveScanState = async () => { throw new Error("cursor save unavailable"); };
			const telemetryResult = await refreshIntelligenceInsights({} as never, CUTOFF, 1, {
				repository: telemetryRepository.repository,
				startPipelineRun: async () => ({
					...pipelineHandle([]),
					async heartbeat() { throw new Error("heartbeat unavailable"); },
					async succeed() { throw new Error("terminal unavailable"); },
					async partial() { throw new Error("terminal unavailable"); },
				}),
				reportTelemetryFailure: rejectReporter,
			});
			assert.equal(telemetryResult.productSnapshots, 1, "throwing telemetry and reporter paths never replace the completed data write");
			assert.equal(telemetryResult.cursorPersisted, false);
			for (const phase of ["cursor-save", "heartbeat", "settle"]) {
				assert.ok(telemetryResult.telemetryFailures.some((failure) => failure.phase === phase), `missing explicit ${phase} telemetry failure`);
			}

			const primary = repository({
				async loadScanState() { throw new Error("cursor state corrupt"); },
			});
			await assert.rejects(
				refreshIntelligenceInsights({} as never, CUTOFF, 1, {
					repository: primary,
					startPipelineRun: async () => ({
						...pipelineHandle([]),
						async heartbeat() { throw new Error("heartbeat unavailable"); },
						async fail() { throw new Error("terminal unavailable"); },
					}),
					reportTelemetryFailure: rejectReporter,
				}),
				/cursor state corrupt/,
				"throwing heartbeat, terminal telemetry, and reporter paths never replace the primary data error",
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			for (const phase of ["start", "heartbeat", "cursor-save", "settle", "cursor-load"]) {
				assert.ok(reportedPhases.includes(phase), `async rejection coverage did not reach ${phase}`);
			}
			assert.deepEqual(unhandledRejections, [], "async telemetry reporter rejections are awaited and contained");
			assert.ok(fallbackWarnings.length >= 1, "throwing telemetry reporters are isolated and fall back to diagnostics");
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
			console.warn = originalWarn;
		}
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
			acquireRun: async () => ({ status: "acquired", invocationBucket: CUTOFF, run: pipelineHandle([]) }),
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
					scannedEvidenceRows: 2,
					scanWrapped: false,
					scanTruncated: false,
					scanState: INITIAL_INSIGHT_SCAN_STATE,
					cursorPersisted: true,
					telemetryFailures: [],
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
		scannedEvidenceRows: 2,
		scanWrapped: false,
		scanTruncated: false,
		scanState: INITIAL_INSIGHT_SCAN_STATE,
		cursorPersisted: true,
		telemetryFailures: [],
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

	const firstBucket = refreshInsightsInvocationBucket(new Date("2026-08-29T00:14:59.999Z"));
	assert.equal(firstBucket, "2026-08-29T00:00:00.000Z");
	assert.equal(refreshInsightsInvocationBucket(new Date("2026-08-29T00:15:00.000Z")), "2026-08-29T00:15:00.000Z", "a later bounded window can retry instead of suppressing the whole day");

	const reserved = new Set<string>();
	let insertedRuns = 0;
	const lockRepository = {
		async insert(input: { externalRunId: string }) {
			if (reserved.has(input.externalRunId)) throw Object.assign(new Error("duplicate invocation"), { code: "23505" });
			reserved.add(input.externalRunId);
			insertedRuns++;
			return { id: `lock-${insertedRuns}` };
		},
		async update() {},
	};
	let concurrentRefreshCalls = 0;
	let reusedRunIds: string[] = [];
	const concurrentDependencies = {
		secret: "secret",
		now: () => new Date(CUTOFF),
		getClient: () => ({} as never),
		acquireRun: (_sb: unknown, cutoff: string, limit: number) => acquireRefreshInsightsInvocation(lockRepository, cutoff, limit),
		refresh: async (_sb: unknown, cutoff: string, limit: number, dependencies: { startPipelineRun(): Promise<PipelineRunHandle | null> }) => {
			concurrentRefreshCalls++;
			const run = await dependencies.startPipelineRun();
			reusedRunIds.push(run?.id ?? "missing");
			return {
				status: "succeeded" as const,
				cutoff,
				limit,
				consideredSubjects: 0,
				eligibleInsightSubjects: 0,
				productSnapshots: 0,
				categorySnapshots: 0,
				skippedNoNewEvidence: 0,
				unresolvedBroadcastIds: [],
				errors: [],
				counts: { new: 0, updated: 0, duplicate: 0, failed: 0, processed: 0 },
				scannedEvidenceRows: 0,
				scanWrapped: false,
				scanTruncated: false,
				scanState: INITIAL_INSIGHT_SCAN_STATE,
				cursorPersisted: true,
				telemetryFailures: [],
			};
		},
	} as any;
	const concurrentRequest = () => runRefreshInsightsCron(
		new Request("https://example.test/api/cron/refresh-intelligence-insights", { headers: { authorization: "Bearer secret" } }),
		concurrentDependencies,
	);
	const concurrentResponses = await Promise.all([concurrentRequest(), concurrentRequest()]);
	assert.deepEqual(concurrentResponses.map((item) => item.status), [200, 200]);
	assert.equal(concurrentRefreshCalls, 1, "only the unique-lock winner may scan or write");
	assert.deepEqual(reusedRunIds, ["lock-1"], "the winner passes the acquired run into refresh instead of starting a second owner");
	const concurrentBodies = await Promise.all(concurrentResponses.map((item) => item.json()));
	assert.equal(concurrentBodies.filter((body) => body.skipped === "duplicate-invocation").length, 1, "the duplicate receives an explicit successful skipped response");

	let refreshAfterLockFailure = false;
	const lockFailure = await runRefreshInsightsCron(
		new Request("https://example.test/api/cron/refresh-intelligence-insights", { headers: { authorization: "Bearer secret" } }),
		{
			secret: "secret",
			now: () => new Date(CUTOFF),
			getClient: () => ({} as never),
			acquireRun: async () => { throw Object.assign(new Error("lock database unavailable"), { code: "08006" }); },
			refresh: async () => { refreshAfterLockFailure = true; throw new Error("must not refresh"); },
		} as any,
	);
	assert.equal(lockFailure.status, 500);
	assert.equal(refreshAfterLockFailure, false, "a non-duplicate acquisition failure fails closed before scanning or writing");

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

testRefreshRound1()
	.then(testCronRoute)
	.then(() => console.log("PASS: bounded incremental insight refresh and cron route"))
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
