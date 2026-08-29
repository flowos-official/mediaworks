import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
	BROADCAST_CATEGORY_FORMULA_VERSION,
	BROADCAST_CATEGORY_INSIGHT_TYPE,
	CATEGORY_INSIGHT_PREDICATES,
	PRODUCT_INSIGHT_PREDICATES,
	PRODUCT_MARKET_FORMULA_VERSION,
	PRODUCT_MARKET_INSIGHT_TYPE,
	buildBroadcastCategoryInsight,
	buildProductMarketInsight,
	selectActiveEvidence,
	type InsightDraft,
} from "./insights";
import { createPipelineRunRepository, startPipelineRun, type PipelineRunCounts, type PipelineRunHandle } from "./pipeline-run";
import type { EvidenceItem } from "./types";

export const MAX_INSIGHT_REFRESH_SUBJECTS = 200;

const EVIDENCE_PAGE_SIZE = 500;
const MAX_SUBJECT_SCAN_PAGES = 20;
const DATABASE_CHUNK_SIZE = 100;

const EVIDENCE_COLUMNS = [
	"id",
	"subject_type",
	"subject_id",
	"predicate",
	"value_json",
	"unit",
	"value_state",
	"evidence_class",
	"source_type",
	"source_table",
	"source_record_id",
	"source_url",
	"source_locator",
	"observed_at",
	"valid_from",
	"valid_until",
	"confidence",
	"raw_hash",
	"dedupe_key",
].join(",");

export interface EvidenceSubjectHead {
	subjectType: "product" | "broadcast";
	subjectId: string;
	newestObservedAt: string;
}

export interface LatestInsightSubject {
	subjectType: "product" | "category";
	subjectId: string;
}

export interface InsightRefreshRepository {
	listActiveSubjectHeads(cutoff: string, limit: number): Promise<EvidenceSubjectHead[]>;
	resolveBroadcastCategories(broadcastIds: string[], cutoff: string): Promise<Map<string, string | null>>;
	loadLatestInsightCutoffs(subjects: LatestInsightSubject[]): Promise<Map<string, string>>;
	loadProductEvidence(productId: string, cutoff: string): Promise<EvidenceItem[]>;
	loadCategoryEvidence(category: string, cutoff: string): Promise<EvidenceItem[]>;
	writeSnapshot(draft: InsightDraft): Promise<string>;
}

export interface SnapshotPersistence {
	insertParent(draft: InsightDraft): Promise<string>;
	insertEvidenceLinks(snapshotId: string, evidenceIds: string[]): Promise<number>;
	deleteParent(snapshotId: string): Promise<void>;
}

export interface StoredBroadcastCategoryRow {
	broadcastId: string;
	category: string | null;
	source: "broadcast_speech_analyses" | "broadcasts" | "historical_broadcasts";
}

export interface RefreshIntelligenceInsightsResult {
	status: "succeeded" | "partial";
	cutoff: string;
	limit: number;
	consideredSubjects: number;
	eligibleInsightSubjects: number;
	productSnapshots: number;
	categorySnapshots: number;
	skippedNoNewEvidence: number;
	unresolvedBroadcastIds: string[];
	errors: Array<{ subjectType: "product" | "category"; subjectId: string; error: string }>;
	counts: PipelineRunCounts;
}

export interface RefreshInsightsDependencies {
	repository?: InsightRefreshRepository;
	startPipelineRun?: () => Promise<PipelineRunHandle | null>;
	reportTelemetryFailure?: (phase: "start" | "settle", error: unknown) => void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: typeof error === "object" && error !== null && "message" in error
			? String(error.message)
			: String(error);
}

function ensureTimestamp(value: string, label: string): string {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO date or timestamp`);
	return new Date(parsed).toISOString();
}

function compareHeads(left: EvidenceSubjectHead, right: EvidenceSubjectHead): number {
	return right.newestObservedAt.localeCompare(left.newestObservedAt)
		|| left.subjectType.localeCompare(right.subjectType)
		|| left.subjectId.localeCompare(right.subjectId);
}

export function refreshSubjectKey(subject: LatestInsightSubject): string {
	return `${subject.subjectType}\u0000${subject.subjectId}`;
}

function provenanceKey(item: EvidenceItem): string {
	return [
		item.subjectType,
		item.subjectId,
		item.predicate,
		item.sourceType,
		item.sourceTable,
		item.sourceRecordId,
		item.sourceLocator ?? "",
	].join("\u0000");
}

function mapEvidenceRow(row: Record<string, unknown>): EvidenceItem {
	return {
		id: String(row.id),
		dedupeKey: String(row.dedupe_key),
		subjectType: row.subject_type as EvidenceItem["subjectType"],
		subjectId: String(row.subject_id),
		predicate: String(row.predicate),
		...(row.value_state === "known" ? { value: row.value_json } : {}),
		...(typeof row.unit === "string" ? { unit: row.unit } : {}),
		valueState: row.value_state as EvidenceItem["valueState"],
		evidenceClass: row.evidence_class as EvidenceItem["evidenceClass"],
		sourceType: String(row.source_type),
		sourceTable: String(row.source_table),
		sourceRecordId: String(row.source_record_id),
		...(typeof row.source_url === "string" ? { sourceUrl: row.source_url } : {}),
		...(typeof row.source_locator === "string" ? { sourceLocator: row.source_locator } : {}),
		observedAt: String(row.observed_at),
		...(typeof row.valid_from === "string" ? { validFrom: row.valid_from } : {}),
		...(typeof row.valid_until === "string" ? { validUntil: row.valid_until } : {}),
		confidence: Number(row.confidence),
		...(typeof row.raw_hash === "string" ? { rawHash: row.raw_hash } : {}),
	};
}

function applyActiveFilters(query: any, cutoff: string): any {
	return query
		.lte("observed_at", cutoff)
		.neq("value_state", "stale")
		.or(`valid_from.is.null,valid_from.lte.${cutoff}`)
		.or(`valid_until.is.null,valid_until.gte.${cutoff}`);
}

function chunks<T>(values: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
	return result;
}

async function loadEvidenceRows(
	sb: SupabaseClient,
	input: {
		subjectTypes: Array<"product" | "internal_product" | "broadcast">;
		subjectIds: string[];
		predicates: readonly string[];
		cutoff: string;
	},
): Promise<EvidenceItem[]> {
	if (input.subjectIds.length === 0) return [];
	const rows: EvidenceItem[] = [];
	for (const subjectIds of chunks([...new Set(input.subjectIds)].sort(), DATABASE_CHUNK_SIZE)) {
		for (let from = 0; ; from += EVIDENCE_PAGE_SIZE) {
			let query: any = (sb as any)
				.from("evidence_items")
				.select(EVIDENCE_COLUMNS)
				.in("subject_type", input.subjectTypes)
				.in("subject_id", subjectIds)
				.in("predicate", [...input.predicates]);
			query = applyActiveFilters(query, input.cutoff)
				.order("observed_at", { ascending: false })
				.order("id", { ascending: true })
				.range(from, from + EVIDENCE_PAGE_SIZE - 1);
			const { data, error } = await query;
			if (error) throw new Error(`active evidence query failed: ${error.message}`);
			const page = (data ?? []) as Array<Record<string, unknown>>;
			rows.push(...page.map(mapEvidenceRow));
			if (page.length < EVIDENCE_PAGE_SIZE) break;
		}
	}
	return rows;
}

/** Explicit current category evidence wins, then exact stored domain rows. */
export function resolveStoredBroadcastCategories(
	broadcastIds: string[],
	categoryEvidence: EvidenceItem[],
	domainRows: StoredBroadcastCategoryRow[],
	cutoff: string,
): Map<string, string | null> {
	const wanted = [...new Set(broadcastIds)].sort();
	const active = selectActiveEvidence(categoryEvidence, cutoff)
		.filter((item) => item.subjectType === "broadcast"
			&& (item.predicate === "normalized_category" || item.predicate === "category")
			&& item.valueState === "known"
			&& typeof item.value === "string"
			&& item.value.trim());
	const explicit = new Map<string, string>();
	for (const item of [...active].sort((left, right) =>
		right.observedAt.localeCompare(left.observedAt)
		|| Number(right.predicate === "normalized_category") - Number(left.predicate === "normalized_category")
		|| left.id.localeCompare(right.id))) {
		if (!explicit.has(item.subjectId)) explicit.set(item.subjectId, String(item.value).trim());
	}

	const sourceRank: Record<StoredBroadcastCategoryRow["source"], number> = {
		broadcast_speech_analyses: 0,
		broadcasts: 1,
		historical_broadcasts: 2,
	};
	const domain = new Map<string, string>();
	for (const row of [...domainRows].sort((left, right) =>
		sourceRank[left.source] - sourceRank[right.source] || left.broadcastId.localeCompare(right.broadcastId))) {
		const category = row.category?.trim();
		if (category && !domain.has(row.broadcastId)) domain.set(row.broadcastId, category);
	}

	return new Map(wanted.map((broadcastId) => [broadcastId, explicit.get(broadcastId) ?? domain.get(broadcastId) ?? null]));
}

export async function persistInsightSnapshot(
	persistence: SnapshotPersistence,
	draft: InsightDraft,
): Promise<string> {
	if (new Set(draft.evidenceIds).size !== draft.evidenceIds.length) {
		throw new Error("insight evidence IDs must be unique");
	}
	const snapshotId = await persistence.insertParent(draft);
	let primaryError: unknown;
	try {
		const linked = await persistence.insertEvidenceLinks(snapshotId, draft.evidenceIds);
		if (linked !== draft.evidenceIds.length) {
			throw new Error(`evidence link count mismatch: expected ${draft.evidenceIds.length}, observed ${linked}`);
		}
		return snapshotId;
	} catch (error) {
		primaryError = error;
	}

	try {
		await persistence.deleteParent(snapshotId);
	} catch (cleanupError) {
		throw new Error(`${errorMessage(primaryError)}; snapshot cleanup failed: ${errorMessage(cleanupError)}`);
	}
	throw new Error(errorMessage(primaryError));
}

function snapshotPersistence(sb: SupabaseClient): SnapshotPersistence {
	return {
		async insertParent(draft) {
			const { data, error } = await (sb as any)
				.from("insight_snapshots")
				.insert({
					insight_type: draft.insightType,
					subject_type: draft.subjectType,
					subject_id: draft.subjectId,
					input_from: draft.inputFrom,
					input_until: draft.inputUntil,
					result: draft.result,
					evidence_count: draft.evidenceIds.length,
					coverage: draft.coverage,
					formula_version: draft.formulaVersion,
					model_version: draft.modelVersion ?? null,
					confidence: draft.confidence,
					valid_until: draft.validUntil ?? null,
				})
				.select("id")
				.single();
			if (error) throw new Error(`insight snapshot parent insert failed: ${error.message}`);
			if (!data?.id) throw new Error("insight snapshot parent insert returned no id");
			return String(data.id);
		},
		async insertEvidenceLinks(snapshotId, evidenceIds) {
			if (evidenceIds.length === 0) return 0;
			const { data, error } = await (sb as any)
				.from("insight_snapshot_evidence")
				.insert(evidenceIds.map((evidenceItemId) => ({
					insight_snapshot_id: snapshotId,
					evidence_item_id: evidenceItemId,
				})))
				.select("evidence_item_id");
			if (error) throw new Error(`insight snapshot evidence insert failed: ${error.message}`);
			return (data ?? []).length;
		},
		async deleteParent(snapshotId) {
			const { error } = await (sb as any).from("insight_snapshots").delete().eq("id", snapshotId);
			if (error) throw new Error(`insight snapshot parent cleanup failed: ${error.message}`);
		},
	};
}

async function loadDomainRowsForIds(sb: SupabaseClient, broadcastIds: string[]): Promise<StoredBroadcastCategoryRow[]> {
	const rows: StoredBroadcastCategoryRow[] = [];
	for (const ids of chunks([...new Set(broadcastIds)].sort(), DATABASE_CHUNK_SIZE)) {
		for (const source of ["broadcast_speech_analyses", "broadcasts", "historical_broadcasts"] as const) {
			const idColumn = source === "broadcast_speech_analyses" ? "broadcast_id" : "id";
			const { data, error } = await (sb as any)
				.from(source)
				.select(`${idColumn},category`)
				.in(idColumn, ids);
			if (error) throw new Error(`${source} category query failed: ${error.message}`);
			for (const row of data ?? []) {
				rows.push({ broadcastId: String(row[idColumn]), category: typeof row.category === "string" ? row.category : null, source });
			}
		}
	}
	return rows;
}

async function loadCategoryBroadcastIds(sb: SupabaseClient, category: string, cutoff: string): Promise<string[]> {
	const ids = new Set<string>();
	for (const source of ["broadcast_speech_analyses", "broadcasts", "historical_broadcasts"] as const) {
		const idColumn = source === "broadcast_speech_analyses" ? "broadcast_id" : "id";
		for (let from = 0; ; from += EVIDENCE_PAGE_SIZE) {
			const { data, error } = await (sb as any)
				.from(source)
				.select(idColumn)
				.eq("category", category)
				.order(idColumn, { ascending: true })
				.range(from, from + EVIDENCE_PAGE_SIZE - 1);
			if (error) throw new Error(`${source} category membership query failed: ${error.message}`);
			const page = data ?? [];
			for (const row of page) ids.add(String(row[idColumn]));
			if (page.length < EVIDENCE_PAGE_SIZE) break;
		}
	}

	for (let from = 0; ; from += EVIDENCE_PAGE_SIZE) {
		let query: any = (sb as any)
			.from("evidence_items")
			.select(EVIDENCE_COLUMNS)
			.eq("subject_type", "broadcast")
			.in("predicate", ["category", "normalized_category"])
			.eq("value_state", "known")
			.eq("value_json", JSON.stringify(category));
		query = applyActiveFilters(query, cutoff)
			.order("observed_at", { ascending: false })
			.order("id", { ascending: true })
			.range(from, from + EVIDENCE_PAGE_SIZE - 1);
		const { data, error } = await query;
		if (error) throw new Error(`explicit category membership query failed: ${error.message}`);
		const page = data ?? [];
		for (const row of page) ids.add(String(row.subject_id));
		if (page.length < EVIDENCE_PAGE_SIZE) break;
	}
	return [...ids].sort();
}

export function createInsightRefreshRepository(sb: SupabaseClient): InsightRefreshRepository {
	return {
		async listActiveSubjectHeads(cutoff, limit) {
			const predicates = [...new Set([...PRODUCT_INSIGHT_PREDICATES, ...CATEGORY_INSIGHT_PREDICATES])].sort();
			const currentProvenance = new Set<string>();
			const heads = new Map<string, EvidenceSubjectHead>();
			for (let pageIndex = 0; pageIndex < MAX_SUBJECT_SCAN_PAGES && heads.size < limit; pageIndex += 1) {
				const from = pageIndex * EVIDENCE_PAGE_SIZE;
				let query: any = (sb as any)
					.from("evidence_items")
					.select(EVIDENCE_COLUMNS)
					.in("subject_type", ["product", "internal_product", "broadcast"])
					.in("predicate", predicates);
				query = applyActiveFilters(query, cutoff)
					.order("observed_at", { ascending: false })
					.order("subject_type", { ascending: true })
					.order("subject_id", { ascending: true })
					.order("id", { ascending: true })
					.range(from, from + EVIDENCE_PAGE_SIZE - 1);
				const { data, error } = await query;
				if (error) throw new Error(`incremental evidence head query failed: ${error.message}`);
				const page = ((data ?? []) as Array<Record<string, unknown>>).map(mapEvidenceRow);
				for (const item of page) {
					if (selectActiveEvidence([item], cutoff).length === 0) continue;
					const provenance = provenanceKey(item);
					if (currentProvenance.has(provenance)) continue;
					currentProvenance.add(provenance);
					const subjectType = item.subjectType === "internal_product" ? "product" : item.subjectType as "product" | "broadcast";
					const key = `${subjectType}\u0000${item.subjectId}`;
					const previous = heads.get(key);
					if (!previous || item.observedAt > previous.newestObservedAt) {
						heads.set(key, { subjectType, subjectId: item.subjectId, newestObservedAt: item.observedAt });
					}
				}
				if (page.length < EVIDENCE_PAGE_SIZE) break;
			}
			return [...heads.values()].sort(compareHeads).slice(0, limit);
		},

		async resolveBroadcastCategories(broadcastIds, cutoff) {
			const categoryEvidence = await loadEvidenceRows(sb, {
				subjectTypes: ["broadcast"],
				subjectIds: broadcastIds,
				predicates: ["category", "normalized_category"],
				cutoff,
			});
			const domainRows = await loadDomainRowsForIds(sb, broadcastIds);
			return resolveStoredBroadcastCategories(broadcastIds, categoryEvidence, domainRows, cutoff);
		},

		async loadLatestInsightCutoffs(subjects) {
			const result = new Map<string, string>();
			for (const subjectType of ["product", "category"] as const) {
				const ids = subjects.filter((subject) => subject.subjectType === subjectType).map((subject) => subject.subjectId);
				const insightType = subjectType === "product" ? PRODUCT_MARKET_INSIGHT_TYPE : BROADCAST_CATEGORY_INSIGHT_TYPE;
				const formulaVersion = subjectType === "product" ? PRODUCT_MARKET_FORMULA_VERSION : BROADCAST_CATEGORY_FORMULA_VERSION;
				for (const subjectIds of chunks([...new Set(ids)].sort(), DATABASE_CHUNK_SIZE)) {
					if (subjectIds.length === 0) continue;
					const { data, error } = await (sb as any)
						.from("insight_snapshots")
						.select("subject_id,input_until")
						.eq("insight_type", insightType)
						.eq("subject_type", subjectType)
						.eq("formula_version", formulaVersion)
						.in("subject_id", subjectIds)
						.order("input_until", { ascending: false });
					if (error) throw new Error(`latest ${subjectType} insight query failed: ${error.message}`);
					for (const row of data ?? []) {
						const key = refreshSubjectKey({ subjectType, subjectId: String(row.subject_id) });
						const inputUntil = String(row.input_until);
						if (!result.has(key) || inputUntil > result.get(key)!) result.set(key, inputUntil);
					}
				}
			}
			return result;
		},

		async loadProductEvidence(productId, cutoff) {
			return loadEvidenceRows(sb, {
				subjectTypes: ["product", "internal_product"],
				subjectIds: [productId],
				predicates: PRODUCT_INSIGHT_PREDICATES,
				cutoff,
			});
		},

		async loadCategoryEvidence(category, cutoff) {
			const broadcastIds = await loadCategoryBroadcastIds(sb, category, cutoff);
			return loadEvidenceRows(sb, {
				subjectTypes: ["broadcast"],
				subjectIds: broadcastIds,
				predicates: CATEGORY_INSIGHT_PREDICATES,
				cutoff,
			});
		},

		async writeSnapshot(draft) {
			return persistInsightSnapshot(snapshotPersistence(sb), draft);
		},
	};
}

async function startRunBestEffort(
	start: () => Promise<PipelineRunHandle | null>,
	report: (phase: "start" | "settle", error: unknown) => void,
): Promise<PipelineRunHandle | null> {
	try {
		return await start();
	} catch (error) {
		report("start", error);
		return null;
	}
}

async function settleBestEffort(
	run: PipelineRunHandle | null,
	settle: (run: PipelineRunHandle) => Promise<void>,
	report: (phase: "start" | "settle", error: unknown) => void,
): Promise<void> {
	if (!run) return;
	try {
		await settle(run);
	} catch (error) {
		report("settle", error);
	}
}

export async function refreshIntelligenceInsights(
	sb: SupabaseClient,
	cutoff: string,
	limit: number,
	dependencies: RefreshInsightsDependencies = {},
): Promise<RefreshIntelligenceInsightsResult> {
	const normalizedCutoff = ensureTimestamp(cutoff, "cutoff");
	if (!Number.isInteger(limit) || limit <= 0) throw new Error("insight refresh limit must be a positive integer");
	const boundedLimit = Math.min(limit, MAX_INSIGHT_REFRESH_SUBJECTS);
	const repository = dependencies.repository ?? createInsightRefreshRepository(sb);
	const report = dependencies.reportTelemetryFailure ?? ((phase, error) => {
		console.warn(`[intelligence insights] pipeline run ${phase} failed:`, errorMessage(error));
	});
	const run = await startRunBestEffort(
		dependencies.startPipelineRun ?? (() => startPipelineRun(
			createPipelineRunRepository(sb),
			{
				sourceType: "evidence_items",
				jobType: "insight_refresh",
				externalRunId: `insight-refresh:${normalizedCutoff}:${randomUUID()}`,
				targetScope: { cutoff: normalizedCutoff, limit: boundedLimit },
			},
		)),
		report,
	);

	let counts: PipelineRunCounts = { new: 0, updated: 0, duplicate: 0, failed: 0, processed: 0 };
	try {
		const heads = (await repository.listActiveSubjectHeads(normalizedCutoff, boundedLimit))
			.sort(compareHeads)
			.slice(0, boundedLimit);
		const productCandidates = heads
			.filter((head): head is EvidenceSubjectHead & { subjectType: "product" } => head.subjectType === "product")
			.map((head) => ({ subjectType: "product" as const, subjectId: head.subjectId, newestObservedAt: head.newestObservedAt }));
		const broadcastHeads = heads.filter((head) => head.subjectType === "broadcast");
		const categories = await repository.resolveBroadcastCategories(broadcastHeads.map((head) => head.subjectId), normalizedCutoff);
		const unresolvedBroadcastIds = broadcastHeads
			.filter((head) => !categories.get(head.subjectId))
			.map((head) => head.subjectId)
			.sort();
		const categoryNewest = new Map<string, string>();
		for (const head of broadcastHeads) {
			const category = categories.get(head.subjectId);
			if (!category) continue;
			const previous = categoryNewest.get(category);
			if (!previous || head.newestObservedAt > previous) categoryNewest.set(category, head.newestObservedAt);
		}
		const categoryCandidates = [...categoryNewest.entries()].map(([subjectId, newestObservedAt]) => ({
			subjectType: "category" as const,
			subjectId,
			newestObservedAt,
		}));
		const candidates = [...productCandidates, ...categoryCandidates]
			.sort((left, right) => right.newestObservedAt.localeCompare(left.newestObservedAt)
				|| left.subjectType.localeCompare(right.subjectType)
				|| left.subjectId.localeCompare(right.subjectId));
		const latestCutoffs = await repository.loadLatestInsightCutoffs(candidates);
		const eligible = candidates.filter((candidate) => {
			const latest = latestCutoffs.get(refreshSubjectKey(candidate));
			return !latest || candidate.newestObservedAt > latest;
		});
		const skippedNoNewEvidence = candidates.length - eligible.length;
		const errors: RefreshIntelligenceInsightsResult["errors"] = [];
		let productSnapshots = 0;
		let categorySnapshots = 0;

		for (const candidate of eligible) {
			try {
				const draft = candidate.subjectType === "product"
					? buildProductMarketInsight(await repository.loadProductEvidence(candidate.subjectId, normalizedCutoff), normalizedCutoff)
					: buildBroadcastCategoryInsight(await repository.loadCategoryEvidence(candidate.subjectId, normalizedCutoff), candidate.subjectId, normalizedCutoff);
				await repository.writeSnapshot(draft);
				if (candidate.subjectType === "product") productSnapshots += 1;
				else categorySnapshots += 1;
			} catch (error) {
				errors.push({ subjectType: candidate.subjectType, subjectId: candidate.subjectId, error: errorMessage(error) });
			}
		}

		counts = {
			new: productSnapshots + categorySnapshots,
			updated: 0,
			duplicate: skippedNoNewEvidence,
			failed: unresolvedBroadcastIds.length + errors.length,
			processed: heads.length,
		};
		const status = counts.failed > 0 ? "partial" as const : "succeeded" as const;
		await settleBestEffort(
			run,
			(handle) => status === "partial"
				? handle.partial(counts, "insight_refresh_partial", `${counts.failed} insight subject(s) skipped or failed`)
				: handle.succeed(counts),
			report,
		);
		return {
			status,
			cutoff: normalizedCutoff,
			limit: boundedLimit,
			consideredSubjects: heads.length,
			eligibleInsightSubjects: eligible.length,
			productSnapshots,
			categorySnapshots,
			skippedNoNewEvidence,
			unresolvedBroadcastIds,
			errors,
			counts,
		};
	} catch (error) {
		await settleBestEffort(run, async (handle) => {
			try {
				await handle.heartbeat(counts);
			} catch (telemetryError) {
				report("settle", telemetryError);
			}
			await handle.fail("insight_refresh_failed", errorMessage(error));
		}, report);
		throw error;
	}
}
