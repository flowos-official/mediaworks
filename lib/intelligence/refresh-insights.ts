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
import {
	createPipelineRunRepository,
	startPipelineRun,
	type PipelineRunCounts,
	type PipelineRunHandle,
} from "./pipeline-run";
import type { EvidenceItem } from "./types";

export const MAX_INSIGHT_REFRESH_SUBJECTS = 200;
export const MAX_INSIGHT_SCAN_ROWS = 10_000;

const EVIDENCE_PAGE_SIZE = 500;
/** Comfortably inside the staleness threshold readiness and the reaper use. */
const HEARTBEAT_INTERVAL_MS = 15_000;
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

export interface EvidenceScanCursor {
	observedAt: string;
	subjectType: "product" | "internal_product" | "broadcast";
	subjectId: string;
	evidenceId: string;
}

export interface EvidenceScanState {
	v: 1;
	position: EvidenceScanCursor | null;
}

export const INITIAL_INSIGHT_SCAN_STATE: EvidenceScanState = { v: 1, position: null };

export interface EvidenceScanPage {
	evidence: EvidenceItem[];
	reachedEnd: boolean;
}

export interface LatestInsightSubject {
	subjectType: "product" | "category";
	subjectId: string;
}

export interface InsightRefreshRepository {
	loadScanState(currentRunId: string | null): Promise<EvidenceScanState>;
	scanActiveEvidencePage(cutoff: string, cursor: EvidenceScanCursor | null, pageSize: number): Promise<EvidenceScanPage>;
	saveScanState(runId: string, state: EvidenceScanState): Promise<void>;
	resolveBroadcastCategories(broadcastIds: string[], cutoff: string): Promise<Map<string, string | null>>;
	loadLatestInsightCutoffs(subjects: LatestInsightSubject[]): Promise<Map<string, string>>;
	loadProductEvidence(productId: string, cutoff: string): Promise<EvidenceItem[]>;
	loadBroadcastEvidence(broadcastIds: string[], cutoff: string): Promise<EvidenceItem[]>;
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

export type InsightTelemetryPhase = "start" | "cursor-load" | "cursor-save" | "heartbeat" | "settle";

export interface InsightTelemetryFailure {
	phase: InsightTelemetryPhase;
	error: string;
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
	scannedEvidenceRows: number;
	scanWrapped: boolean;
	scanTruncated: boolean;
	deadlineExceeded: boolean;
	scanState: EvidenceScanState;
	cursorPersisted: boolean;
	telemetryFailures: InsightTelemetryFailure[];
}

export interface RefreshInsightsDependencies {
	repository?: InsightRefreshRepository;
	startPipelineRun?: () => Promise<PipelineRunHandle | null>;
	reportTelemetryFailure?: (phase: InsightTelemetryPhase, error: unknown) => void | Promise<void>;
	/**
	 * Absolute epoch-ms budget for productive work. Every other cron in this
	 * repo carries one (`BUDGET_MS = 240_000`); this job shipped without any and
	 * can issue on the order of a thousand round trips, so a slow database was
	 * enough to run past `maxDuration` and leave the run orphaned in `running`.
	 * Omit to run unbounded, which is what the smoke tests want.
	 */
	deadlineAtMs?: number;
	now?: () => number;
}

interface RefreshCandidate {
	subjectType: "product" | "category";
	subjectId: string;
	newestObservedAt: string;
	broadcastIds: Set<string>;
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

function compareCandidates(left: RefreshCandidate, right: RefreshCandidate): number {
	return right.newestObservedAt.localeCompare(left.newestObservedAt)
		|| left.subjectType.localeCompare(right.subjectType)
		|| left.subjectId.localeCompare(right.subjectId);
}

export function refreshSubjectKey(subject: LatestInsightSubject): string {
	return `${subject.subjectType}\u0000${subject.subjectId}`;
}

function evidenceSubjectKey(item: EvidenceItem): string {
	const subjectType = item.subjectType === "internal_product" ? "product" : item.subjectType;
	return `${subjectType}\u0000${item.subjectId}`;
}

function cursorForEvidence(item: EvidenceItem): EvidenceScanCursor {
	if (item.subjectType !== "product" && item.subjectType !== "internal_product" && item.subjectType !== "broadcast") {
		throw new Error(`unsupported refresh evidence subject type: ${item.subjectType}`);
	}
	return {
		observedAt: item.observedAt,
		subjectType: item.subjectType,
		subjectId: item.subjectId,
		evidenceId: item.id,
	};
}

/** Negative means the evidence row sorts before the cursor in refresh order. */
function compareEvidenceToCursor(item: EvidenceItem, cursor: EvidenceScanCursor): number {
	return cursor.observedAt.localeCompare(item.observedAt)
		|| item.subjectType.localeCompare(cursor.subjectType)
		|| item.subjectId.localeCompare(cursor.subjectId)
		|| item.id.localeCompare(cursor.evidenceId);
}

function parseScanState(value: unknown): EvidenceScanState {
	if (!value || typeof value !== "object") throw new Error("invalid insight scan cursor state");
	const record = value as Record<string, unknown>;
	if (record.v !== 1) throw new Error("unsupported insight scan cursor version");
	if (record.position === null) return { v: 1, position: null };
	if (!record.position || typeof record.position !== "object") throw new Error("invalid insight scan cursor position");
	const position = record.position as Record<string, unknown>;
	if (typeof position.observedAt !== "string" || !Number.isFinite(Date.parse(position.observedAt))) {
		throw new Error("invalid insight scan cursor observation time");
	}
	if (position.subjectType !== "product" && position.subjectType !== "internal_product" && position.subjectType !== "broadcast") {
		throw new Error("invalid insight scan cursor subject type");
	}
	if (typeof position.subjectId !== "string" || !position.subjectId) throw new Error("invalid insight scan cursor subject ID");
	if (typeof position.evidenceId !== "string" || !position.evidenceId) throw new Error("invalid insight scan cursor evidence ID");
	return {
		v: 1,
		position: {
			observedAt: position.observedAt,
			subjectType: position.subjectType,
			subjectId: position.subjectId,
			evidenceId: position.evidenceId,
		},
	};
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

export function buildEvidenceScanCursorFilter(cursor: EvidenceScanCursor): string {
	return [
		`observed_at.lt.${cursor.observedAt}`,
		`and(observed_at.eq.${cursor.observedAt},subject_type.gt.${cursor.subjectType})`,
		`and(observed_at.eq.${cursor.observedAt},subject_type.eq.${cursor.subjectType},subject_id.gt.${cursor.subjectId})`,
		`and(observed_at.eq.${cursor.observedAt},subject_type.eq.${cursor.subjectType},subject_id.eq.${cursor.subjectId},id.gt.${cursor.evidenceId})`,
	].join(",");
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
	if (new Set(draft.evidenceIds).size !== draft.evidenceIds.length) throw new Error("insight evidence IDs must be unique");
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

export function createSnapshotPersistence(sb: SupabaseClient): SnapshotPersistence {
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
				.insert(evidenceIds.map((evidenceItemId) => ({ insight_snapshot_id: snapshotId, evidence_item_id: evidenceItemId })))
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
			const { data, error } = await (sb as any).from(source).select(`${idColumn},category`).in(idColumn, ids);
			if (error) throw new Error(`${source} category query failed: ${error.message}`);
			for (const row of data ?? []) {
				rows.push({ broadcastId: String(row[idColumn]), category: typeof row.category === "string" ? row.category : null, source });
			}
		}
	}
	return rows;
}

export function createInsightRefreshRepository(sb: SupabaseClient): InsightRefreshRepository {
	return {
		async loadScanState(currentRunId) {
			let query: any = (sb as any)
				.from("data_pipeline_runs")
				.select("cursor_json")
				.eq("source_type", "evidence_items")
				.eq("job_type", "insight_refresh")
				// Only a run that reached a terminal status is trusted. A run still
				// marked `running` is either genuinely in flight or was killed at
				// `maxDuration` with nothing to distinguish the two, and resuming
				// from a dead run's cursor silently skipped every subject between
				// where it stopped and where it had claimed to reach.
				.in("status", ["succeeded", "partial"])
				.not("cursor_json", "is", null);
			if (currentRunId) query = query.neq("id", currentRunId);
			const { data, error } = await query.order("started_at", { ascending: false }).limit(1).maybeSingle();
			if (error) throw new Error(`insight scan cursor load failed: ${error.message}`);
			return data?.cursor_json ? parseScanState(data.cursor_json) : { ...INITIAL_INSIGHT_SCAN_STATE };
		},

		async scanActiveEvidencePage(cutoff, cursor, pageSize) {
			const predicates = [...new Set([...PRODUCT_INSIGHT_PREDICATES, ...CATEGORY_INSIGHT_PREDICATES])].sort();
			let query: any = (sb as any)
				.from("evidence_items")
				.select(EVIDENCE_COLUMNS)
				.in("subject_type", ["product", "internal_product", "broadcast"])
				.in("predicate", predicates);
			query = applyActiveFilters(query, cutoff);
			if (cursor) query = query.or(buildEvidenceScanCursorFilter(cursor));
			query = query
				.order("observed_at", { ascending: false })
				.order("subject_type", { ascending: true })
				.order("subject_id", { ascending: true })
				.order("id", { ascending: true });
			const { data, error } = await query.limit(pageSize);
			if (error) throw new Error(`incremental evidence scan failed: ${error.message}`);
			const evidence = ((data ?? []) as Array<Record<string, unknown>>).map(mapEvidenceRow)
				.filter((item) => selectActiveEvidence([item], cutoff).length > 0);
			return { evidence, reachedEnd: (data ?? []).length < pageSize };
		},

		async saveScanState(runId, state) {
			const validated = parseScanState(state);
			const { data, error } = await (sb as any)
				.from("data_pipeline_runs")
				.update({ cursor_json: validated })
				.eq("id", runId)
				.select("id")
				.single();
			if (error) throw new Error(`insight scan cursor save failed: ${error.message}`);
			if (!data?.id) throw new Error("insight scan cursor save returned no run");
		},

		async resolveBroadcastCategories(broadcastIds, cutoff) {
			const categoryEvidence = await loadEvidenceRows(sb, {
				subjectTypes: ["broadcast"],
				subjectIds: broadcastIds,
				predicates: ["category", "normalized_category"],
				cutoff,
			});
			return resolveStoredBroadcastCategories(
				broadcastIds,
				categoryEvidence,
				await loadDomainRowsForIds(sb, broadcastIds),
				cutoff,
			);
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

		async loadBroadcastEvidence(broadcastIds, cutoff) {
			return loadEvidenceRows(sb, {
				subjectTypes: ["broadcast"],
				subjectIds: [...new Set(broadcastIds)].sort(),
				predicates: CATEGORY_INSIGHT_PREDICATES,
				cutoff,
			});
		},

		async writeSnapshot(draft) {
			return persistInsightSnapshot(createSnapshotPersistence(sb), draft);
		},
	};
}

function candidateIsEligible(candidate: RefreshCandidate, latestCutoffs: Map<string, string | null>): boolean {
	const latest = latestCutoffs.get(refreshSubjectKey(candidate));
	return latest === null || latest === undefined || candidate.newestObservedAt > latest;
}

function observedCounts(input: { created: number; duplicate: number; failed: number }): PipelineRunCounts {
	return {
		new: input.created,
		updated: 0,
		duplicate: input.duplicate,
		failed: input.failed,
		processed: input.created + input.duplicate + input.failed,
	};
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
	const telemetryFailures: InsightTelemetryFailure[] = [];
	const reporter = dependencies.reportTelemetryFailure ?? ((phase: InsightTelemetryPhase, error: unknown) => {
		console.warn(`[intelligence insights] pipeline run ${phase} failed:`, errorMessage(error));
	});
	const recordTelemetryFailure = async (phase: InsightTelemetryPhase, error: unknown): Promise<void> => {
		telemetryFailures.push({ phase, error: errorMessage(error) });
		try {
			await Promise.resolve(reporter(phase, error));
		} catch (reporterError) {
			console.warn(`[intelligence insights] telemetry reporter failed during ${phase}:`, errorMessage(reporterError));
		}
	};

	let run: PipelineRunHandle | null = null;
	try {
		run = await (dependencies.startPipelineRun ?? (() => startPipelineRun(
			createPipelineRunRepository(sb),
			{
				sourceType: "evidence_items",
				jobType: "insight_refresh",
				externalRunId: `insight-refresh:${normalizedCutoff}:${randomUUID()}`,
				targetScope: { cutoff: normalizedCutoff, limit: boundedLimit, scanRowLimit: MAX_INSIGHT_SCAN_ROWS },
			},
		)))();
	} catch (error) {
		await recordTelemetryFailure("start", error);
	}

	const now = dependencies.now ?? (() => Date.now());
	const outOfBudget = (): boolean =>
		dependencies.deadlineAtMs !== undefined && now() >= dependencies.deadlineAtMs;
	let deadlineExceeded = false;

	let counts = observedCounts({ created: 0, duplicate: 0, failed: 0 });
	// One UPDATE per candidate meant up to 200 extra writes per run, which is
	// budget spent on saying we are alive rather than on being alive. The
	// heartbeat only has to beat the staleness threshold that readiness and the
	// reaper use.
	let lastHeartbeatAtMs = 0;
	const heartbeat = async (force = false): Promise<void> => {
		if (!run) return;
		const at = now();
		if (!force && at - lastHeartbeatAtMs < HEARTBEAT_INTERVAL_MS) return;
		lastHeartbeatAtMs = at;
		try {
			await run.heartbeat(counts);
		} catch (error) {
			await recordTelemetryFailure("heartbeat", error);
		}
	};

	try {
		let loadedState: EvidenceScanState;
		try {
			loadedState = await repository.loadScanState(run?.id ?? null);
		} catch (error) {
			await recordTelemetryFailure("cursor-load", error);
			throw error;
		}
		let cursor = loadedState.position;
		const originalResumeBoundary = loadedState.position;
		const canWrap = originalResumeBoundary !== null;
		let scanWrapped = false;
		let scanFinishedCycle = false;
		let scannedEvidenceRows = 0;
		let stoppedAtLimit = false;
		const seenEvidenceSubjects = new Set<string>();
		const candidates = new Map<string, RefreshCandidate>();
		const eligibleCandidateKeys = new Set<string>();
		const latestCutoffs = new Map<string, string | null>();
		const unresolved = new Set<string>();

		while (scannedEvidenceRows < MAX_INSIGHT_SCAN_ROWS && !stoppedAtLimit) {
			if (outOfBudget()) {
				deadlineExceeded = true;
				break;
			}
			const pageSize = Math.min(EVIDENCE_PAGE_SIZE, MAX_INSIGHT_SCAN_ROWS - scannedEvidenceRows);
			const page = await repository.scanActiveEvidencePage(normalizedCutoff, cursor, pageSize);
			if (page.evidence.length === 0) {
				if (cursor && canWrap && !scanWrapped) {
					cursor = null;
					scanWrapped = true;
					continue;
				}
				cursor = scanWrapped ? originalResumeBoundary : null;
				scanFinishedCycle = true;
				break;
			}
			let cycleBoundaryReached = false;
			let pageEvidence = page.evidence;
			if (scanWrapped && originalResumeBoundary) {
				const boundaryIndex = pageEvidence.findIndex((item) => compareEvidenceToCursor(item, originalResumeBoundary) >= 0);
				if (boundaryIndex >= 0) {
					pageEvidence = pageEvidence.slice(0, boundaryIndex);
					cycleBoundaryReached = true;
				}
			}
			if (pageEvidence.length === 0 && cycleBoundaryReached) {
				cursor = originalResumeBoundary;
				scanFinishedCycle = true;
				break;
			}

			const potentialProducts = new Set<string>();
			const potentialBroadcasts = new Set<string>();
			for (const item of pageEvidence) {
				if (seenEvidenceSubjects.has(evidenceSubjectKey(item))) continue;
				if (item.subjectType === "broadcast") potentialBroadcasts.add(item.subjectId);
				else potentialProducts.add(item.subjectId);
			}
			const resolvedCategories = await repository.resolveBroadcastCategories([...potentialBroadcasts].sort(), normalizedCutoff);
			const potentialSubjects: LatestInsightSubject[] = [
				...[...potentialProducts].map((subjectId) => ({ subjectType: "product" as const, subjectId })),
				...[...new Set([...resolvedCategories.values()].filter((value): value is string => Boolean(value)))]
					.map((subjectId) => ({ subjectType: "category" as const, subjectId })),
			];
			const missingLatest = potentialSubjects.filter((subject) => !latestCutoffs.has(refreshSubjectKey(subject)));
			const loadedLatest = await repository.loadLatestInsightCutoffs(missingLatest);
			for (const subject of missingLatest) {
				const key = refreshSubjectKey(subject);
				latestCutoffs.set(key, loadedLatest.get(key) ?? null);
			}

			for (const item of pageEvidence) {
				cursor = cursorForEvidence(item);
				scannedEvidenceRows += 1;
				const rawSubjectKey = evidenceSubjectKey(item);
				if (seenEvidenceSubjects.has(rawSubjectKey)) continue;
				seenEvidenceSubjects.add(rawSubjectKey);

				if (item.subjectType === "broadcast") {
					const category = resolvedCategories.get(item.subjectId);
					if (!category) {
						unresolved.add(item.subjectId);
					} else {
						const key = refreshSubjectKey({ subjectType: "category", subjectId: category });
						const existing = candidates.get(key);
						if (existing) {
							existing.broadcastIds.add(item.subjectId);
							if (item.observedAt > existing.newestObservedAt) existing.newestObservedAt = item.observedAt;
						} else {
							candidates.set(key, {
								subjectType: "category",
								subjectId: category,
								newestObservedAt: item.observedAt,
								broadcastIds: new Set([item.subjectId]),
							});
						}
						const candidate = candidates.get(key)!;
						if (candidateIsEligible(candidate, latestCutoffs)) eligibleCandidateKeys.add(key);
						else eligibleCandidateKeys.delete(key);
					}
				} else {
					const key = refreshSubjectKey({ subjectType: "product", subjectId: item.subjectId });
					if (!candidates.has(key)) {
						candidates.set(key, {
							subjectType: "product",
							subjectId: item.subjectId,
							newestObservedAt: item.observedAt,
							broadcastIds: new Set(),
						});
					}
					const candidate = candidates.get(key)!;
					if (candidateIsEligible(candidate, latestCutoffs)) eligibleCandidateKeys.add(key);
					else eligibleCandidateKeys.delete(key);
				}

				if (eligibleCandidateKeys.size >= boundedLimit) {
					stoppedAtLimit = true;
					break;
				}
				if (scannedEvidenceRows >= MAX_INSIGHT_SCAN_ROWS) break;
			}

			if (stoppedAtLimit) break;
			if (cycleBoundaryReached) {
				cursor = originalResumeBoundary;
				scanFinishedCycle = true;
				break;
			}
			if (scannedEvidenceRows >= MAX_INSIGHT_SCAN_ROWS) break;
			if (page.reachedEnd) {
				if (cursor && canWrap && !scanWrapped) {
					cursor = null;
					scanWrapped = true;
					continue;
				}
				cursor = scanWrapped ? originalResumeBoundary : null;
				scanFinishedCycle = true;
				break;
			}
		}

		const scanTruncated = scannedEvidenceRows >= MAX_INSIGHT_SCAN_ROWS && !scanFinishedCycle && !stoppedAtLimit;
		const scanState: EvidenceScanState = { v: 1, position: scanFinishedCycle ? originalResumeBoundary : cursor };

		const orderedCandidates = [...candidates.values()].sort(compareCandidates);
		const eligible = orderedCandidates.filter((candidate) => candidateIsEligible(candidate, latestCutoffs)).slice(0, boundedLimit);
		const skippedNoNewEvidence = orderedCandidates.length - eligible.length;
		const unresolvedBroadcastIds = [...unresolved].sort();
		const errors: RefreshIntelligenceInsightsResult["errors"] = [];
		let productSnapshots = 0;
		let categorySnapshots = 0;
		// A broadcast whose category cannot be resolved is a coverage gap, not a
		// failure: roughly one archived broadcast in six has no category at all,
		// so counting them as failures made this job permanently `partial` and
		// taught the operator to ignore the badge. `failed` is reserved for work
		// that was attempted and did not succeed.
		counts = observedCounts({ created: 0, duplicate: skippedNoNewEvidence + unresolvedBroadcastIds.length, failed: 0 });
		await heartbeat(true);

		for (const candidate of eligible) {
			if (outOfBudget()) {
				deadlineExceeded = true;
				break;
			}
			try {
				const draft = candidate.subjectType === "product"
					? buildProductMarketInsight(await repository.loadProductEvidence(candidate.subjectId, normalizedCutoff), normalizedCutoff)
					: buildBroadcastCategoryInsight(
						await repository.loadBroadcastEvidence([...candidate.broadcastIds].sort(), normalizedCutoff),
						candidate.subjectId,
						normalizedCutoff,
					);
				await repository.writeSnapshot(draft);
				if (candidate.subjectType === "product") productSnapshots += 1;
				else categorySnapshots += 1;
			} catch (error) {
				errors.push({ subjectType: candidate.subjectType, subjectId: candidate.subjectId, error: errorMessage(error) });
			}
			counts = observedCounts({
				created: productSnapshots + categorySnapshots,
				duplicate: skippedNoNewEvidence + unresolvedBroadcastIds.length,
				failed: errors.length,
			});
			await heartbeat();
		}

		// The cursor is saved only now, and only for a run that finished its
		// candidates. Saving it before the snapshot loop advanced scan progress
		// past subjects whose output was never written, so a mid-loop death
		// silently skipped them until the scan wrapped all the way around.
		// Re-doing the work instead is safe: `candidateIsEligible` skips a
		// subject that already has a snapshot at this cutoff.
		let cursorPersisted = false;
		if (deadlineExceeded) {
			// Leave the previous cursor authoritative — the next run repeats this
			// window rather than stepping over the part it never reached.
			await recordTelemetryFailure(
				"cursor-save",
				new Error("insight refresh stopped at its deadline; scan cursor intentionally left unchanged"),
			);
		} else if (!run) {
			await recordTelemetryFailure("cursor-save", new Error("pipeline run unavailable; insight scan cursor was not persisted"));
		} else {
			try {
				await repository.saveScanState(run.id, scanState);
				cursorPersisted = true;
			} catch (error) {
				await recordTelemetryFailure("cursor-save", error);
			}
		}

		const status = counts.failed > 0 || !cursorPersisted ? "partial" as const : "succeeded" as const;
		if (run) {
			try {
				if (status === "partial") {
					const errorCode = deadlineExceeded
						? "deadline_exceeded"
						: cursorPersisted
							? "insight_refresh_partial"
							: "insight_refresh_cursor_not_persisted";
					const errorSummary = deadlineExceeded
						? `stopped at the run deadline after ${counts.new} snapshot(s); scan cursor left unchanged for the next run`
						: cursorPersisted
							? `${counts.failed} insight candidate(s) failed`
							: "data refresh completed but the scan cursor was not persisted";
					await run.partial(counts, errorCode, errorSummary);
				} else {
					await run.succeed(counts);
				}
			} catch (error) {
				await recordTelemetryFailure("settle", error);
			}
		}

		return {
			status,
			cutoff: normalizedCutoff,
			limit: boundedLimit,
			consideredSubjects: orderedCandidates.length + unresolvedBroadcastIds.length,
			eligibleInsightSubjects: eligible.length,
			productSnapshots,
			categorySnapshots,
			skippedNoNewEvidence,
			unresolvedBroadcastIds,
			errors,
			counts,
			scannedEvidenceRows,
			scanWrapped,
			scanTruncated,
			deadlineExceeded,
			scanState,
			cursorPersisted,
			telemetryFailures,
		};
	} catch (error) {
		await heartbeat();
		if (run) {
			try {
				await run.fail("insight_refresh_failed", errorMessage(error));
			} catch (settleError) {
				await recordTelemetryFailure("settle", settleError);
			}
		}
		throw error;
	}
}
