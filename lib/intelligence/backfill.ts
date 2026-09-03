import { EXCLUDED_DISCOVERY_SLUGS, TV_CHANNELS } from "@/lib/discovery/tv-channels";
import { buildEvidenceDraft } from "./evidence";
import type { PipelineRunCounts, PipelineRunHandle } from "./pipeline-run";
import type { EvidenceClass, EvidenceDraft, EvidenceValueState } from "./types";

export type { PipelineRunHandle } from "./pipeline-run";

const DEFAULT_LIMIT = 200;
export const MAX_BACKFILL_LIMIT = 2_000;
const DEFAULT_LOOKBACK_DAYS = 30;

export interface DiscoveredProductBackfillRow {
	id: string;
	canonicalProductId?: string;
	name: string | null;
	category: string | null;
	normalizedCategory?: string | null;
	productUrl: string | null;
	priceJpy: number | null;
	reviewCount: number | null;
	tvEvidence: { airing_count?: unknown; matched_at?: unknown } | null;
	tvEvidenceAt?: string | null;
	observedAt: string;
	sourceType?: string;
	sourceTable?: string;
}

export interface BroadcastAnalysisBackfillRow {
	broadcastId: string;
	channel: string | null;
	airDate: string | null;
	durationSec: number | null;
	segments: unknown[] | null;
	sellingPoints: unknown[] | null;
	evidenceCues: unknown[] | null;
	objectionHandlings: unknown[] | null;
	offerTimeline: Record<string, unknown> | null;
	observedAt: string;
	sourceUrl?: string | null;
}

export interface BackfillCursorPosition {
	observedAt: string;
	id: string;
}

export interface BackfillSourceCursor {
	done: boolean;
	position?: BackfillCursorPosition;
}

export interface BackfillCursor {
	products: BackfillSourceCursor;
	broadcasts: BackfillSourceCursor;
}

export interface BackfillArgs {
	since: string;
	limit: number;
	cursor?: string;
	apply: boolean;
}

export interface BackfillReviewNeeded {
	missingNormalizedCategory: number;
	missingProductName: number;
	missingProductSourceUrl: number;
	missingBroadcastSourceUrl: number;
}

export interface BackfillPageSummary {
	productEvidenceCount: number;
	broadcastEvidenceCount: number;
	productRowsWritten: number;
	broadcastRowsWritten: number;
	reviewNeeded: BackfillReviewNeeded;
	reviewNeededCategories: string[];
}

export interface BackfillPageInput {
	products: DiscoveredProductBackfillRow[];
	broadcasts: BroadcastAnalysisBackfillRow[];
	normalizeCategories(rawCategories: string[]): Promise<Map<string, string[]>>;
	write: boolean;
	applyProduct?(row: DiscoveredProductBackfillRow, evidence: EvidenceDraft[]): Promise<void>;
	applyBroadcast?(row: BroadcastAnalysisBackfillRow, evidence: EvidenceDraft[]): Promise<void>;
}

function nonEmptyString(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function hasValidCalendarDate(year: number, month: number, day: number): boolean {
	if (month < 1 || month > 12 || day < 1 || day > 31) return false;
	const candidate = new Date(Date.UTC(year, month - 1, day));
	return candidate.getUTCFullYear() === year
		&& candidate.getUTCMonth() === month - 1
		&& candidate.getUTCDate() === day;
}

export function isStrictIsoDateOrTimestamp(value: string): boolean {
	const dateOnly = value.match(DATE_ONLY);
	if (dateOnly) {
		return hasValidCalendarDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
	}
	const timestamp = value.match(RFC3339);
	if (!timestamp) return false;
	const [, year, month, day, hour, minute, second, offset] = timestamp;
	if (!hasValidCalendarDate(Number(year), Number(month), Number(day))) return false;
	if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
	if (offset !== "Z") {
		const [, offsetHour, offsetMinute] = offset.match(/^([+-])(\d{2}):(\d{2})$/) ?? [];
		if (Number(offsetHour) > 23 || Number(offsetMinute) > 59) return false;
	}
	return Number.isFinite(Date.parse(value));
}

function requireObservedAt(observedAt: string): string {
	if (!isStrictIsoDateOrTimestamp(observedAt)) {
		throw new Error("backfill evidence requires a source observation timestamp");
	}
	return observedAt;
}

function tvObservedAt(row: DiscoveredProductBackfillRow): string {
	const candidates = [
		row.tvEvidenceAt,
		typeof row.tvEvidence?.matched_at === "string" ? row.tvEvidence.matched_at : undefined,
		row.observedAt,
	];
	const observedAt = candidates.find((candidate): candidate is string =>
		typeof candidate === "string" && isStrictIsoDateOrTimestamp(candidate),
	);
	if (!observedAt) throw new Error("backfill TV evidence requires an observation timestamp");
	return observedAt;
}

function evidenceDraft(input: {
	subjectType: "product" | "broadcast";
	subjectId: string;
	predicate: string;
	value: unknown;
	evidenceClass: EvidenceClass;
	sourceType: string;
	sourceTable: string;
	sourceRecordId: string;
	sourceUrl?: string;
	observedAt: string;
	unit?: string;
	confidence: number;
}): EvidenceDraft {
	const known = input.value !== undefined;
	return buildEvidenceDraft({
		subjectType: input.subjectType,
		subjectId: input.subjectId,
		predicate: input.predicate,
		...(known ? { value: input.value } : {}),
		...(input.unit ? { unit: input.unit } : {}),
		valueState: (known ? "known" : "unknown") as EvidenceValueState,
		evidenceClass: input.evidenceClass,
		sourceType: input.sourceType,
		sourceTable: input.sourceTable,
		sourceRecordId: input.sourceRecordId,
		...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
		observedAt: requireObservedAt(input.observedAt),
		confidence: input.confidence,
	});
}

/**
 * Maps an existing discovery row into evidence. `canonicalProductId` is set
 * by the apply path after its exact source link has been created or reused.
 * Dry-run callers may leave it absent; they never persist those drafts.
 */
export function mapDiscoveredProductEvidence(row: DiscoveredProductBackfillRow): EvidenceDraft[] {
	const sourceType = row.sourceType ?? "discovery";
	const sourceTable = row.sourceTable ?? "discovered_products";
	const sourceUrl = nonEmptyString(row.productUrl);
	const subjectId = row.canonicalProductId ?? row.id;
	const tvAiringCount = finiteNumber(row.tvEvidence?.airing_count);

	return [
		evidenceDraft({
			subjectType: "product",
			subjectId,
			predicate: "name",
			value: nonEmptyString(row.name),
			evidenceClass: "source_claim",
			sourceType,
			sourceTable,
			sourceRecordId: row.id,
			sourceUrl,
			observedAt: row.observedAt,
			confidence: 0.8,
		}),
		evidenceDraft({
			subjectType: "product",
			subjectId,
			predicate: "normalized_category",
			value: nonEmptyString(row.normalizedCategory),
			evidenceClass: "inferred",
			sourceType,
			sourceTable,
			sourceRecordId: row.id,
			sourceUrl,
			observedAt: row.observedAt,
			confidence: 0.7,
		}),
		evidenceDraft({
			subjectType: "product",
			subjectId,
			predicate: "price_jpy",
			value: finiteNumber(row.priceJpy),
			unit: "JPY",
			evidenceClass: "verified",
			sourceType,
			sourceTable,
			sourceRecordId: row.id,
			sourceUrl,
			observedAt: row.observedAt,
			confidence: 1,
		}),
		evidenceDraft({
			subjectType: "product",
			subjectId,
			predicate: "review_count",
			value: finiteNumber(row.reviewCount),
			unit: "reviews",
			evidenceClass: "proxy",
			sourceType,
			sourceTable,
			sourceRecordId: row.id,
			sourceUrl,
			observedAt: row.observedAt,
			confidence: 0.7,
		}),
		evidenceDraft({
			subjectType: "product",
			subjectId,
			predicate: "tv_airing_count",
			value: tvAiringCount,
			unit: "airings",
			evidenceClass: "proxy",
			sourceType,
			sourceTable,
			sourceRecordId: row.id,
			sourceUrl,
			observedAt: tvObservedAt(row),
			confidence: 0.8,
		}),
	];
}

export function mapBroadcastAnalysisEvidence(row: BroadcastAnalysisBackfillRow): EvidenceDraft[] {
	const sourceType = nonEmptyString(row.channel) ?? "oa";
	const sourceUrl = nonEmptyString(row.sourceUrl);
	const common = {
		subjectType: "broadcast" as const,
		subjectId: row.broadcastId,
		sourceType,
		sourceTable: "broadcast_speech_analyses",
		sourceRecordId: row.broadcastId,
		sourceUrl,
		observedAt: row.observedAt,
	};

	return [
		evidenceDraft({ ...common, predicate: "air_date", value: nonEmptyString(row.airDate), evidenceClass: "verified", confidence: 1 }),
		evidenceDraft({ ...common, predicate: "duration_sec", value: finiteNumber(row.durationSec), unit: "seconds", evidenceClass: "verified", confidence: 1 }),
		evidenceDraft({ ...common, predicate: "segment_pattern", value: row.segments ?? undefined, evidenceClass: "inferred", confidence: 0.8 }),
		evidenceDraft({ ...common, predicate: "selling_points", value: row.sellingPoints ?? undefined, evidenceClass: "inferred", confidence: 0.8 }),
		evidenceDraft({ ...common, predicate: "evidence_cues", value: row.evidenceCues ?? undefined, evidenceClass: "inferred", confidence: 0.8 }),
		evidenceDraft({ ...common, predicate: "objection_handlings", value: row.objectionHandlings ?? undefined, evidenceClass: "inferred", confidence: 0.8 }),
		evidenceDraft({ ...common, predicate: "offer_timing", value: row.offerTimeline ?? undefined, evidenceClass: "inferred", confidence: 0.8 }),
	];
}

function normalizeSince(value: string): string {
	if (!isStrictIsoDateOrTimestamp(value)) throw new Error("--since must be an ISO date or timestamp");
	return new Date(value).toISOString();
}

function defaultSince(): string {
	return new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000).toISOString();
}

function singleOption(args: string[], name: string): string | undefined {
	const values = args.filter((arg) => arg.startsWith(`--${name}=`));
	if (values.length > 1) throw new Error(`--${name} may only be provided once`);
	return values[0]?.slice(name.length + 3);
}

export function parseBackfillArgs(args: string[]): BackfillArgs {
	for (const arg of args) {
		if (arg === "--apply" || arg.startsWith("--since=") || arg.startsWith("--limit=") || arg.startsWith("--cursor=")) continue;
		throw new Error(`unknown argument: ${arg}`);
	}
	const rawLimit = singleOption(args, "limit");
	const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);
	if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
	if (limit > MAX_BACKFILL_LIMIT) throw new Error(`--limit must not exceed ${MAX_BACKFILL_LIMIT}`);
	const rawCursor = singleOption(args, "cursor");
	if (rawCursor !== undefined) parseBackfillCursor(rawCursor);
	return {
		since: normalizeSince(singleOption(args, "since") ?? defaultSince()),
		limit,
		...(rawCursor ? { cursor: rawCursor } : {}),
		apply: args.includes("--apply"),
	};
}

function parseCursorPosition(value: unknown): BackfillCursorPosition | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.observedAt !== "string" || !isStrictIsoDateOrTimestamp(record.observedAt)) return undefined;
	if (typeof record.id !== "string" || !record.id) return undefined;
	return { observedAt: record.observedAt, id: record.id };
}

function parseSourceCursor(value: unknown): BackfillSourceCursor | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.done !== "boolean") return undefined;
	const position = parseCursorPosition(record.position);
	if (record.done) {
		if (record.position !== undefined) return undefined;
		return { done: true };
	}
	if (record.position === undefined) return { done: false };
	return position ? { done: false, position } : undefined;
}

export function initialBackfillCursor(): BackfillCursor {
	return { products: { done: false }, broadcasts: { done: false } };
}

export function parseBackfillCursor(cursor: string): BackfillCursor {
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
		if (parsed.v !== 2) throw new Error("unsupported cursor version");
		const products = parseSourceCursor(parsed.products);
		const broadcasts = parseSourceCursor(parsed.broadcasts);
		if (!products || !broadcasts) throw new Error("source cursor state is incomplete");
		return { products, broadcasts };
	} catch {
		throw new Error("invalid cursor");
	}
}

export function buildBackfillCursor(cursor: BackfillCursor): string {
	const products = parseSourceCursor(cursor.products);
	const broadcasts = parseSourceCursor(cursor.broadcasts);
	if (!products || !broadcasts) throw new Error("cursor requires both source states");
	const payload = { v: 2, products, broadcasts };
	return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * Derived from the discovery registry, not restated.
 *
 * This was a hand-kept copy of eleven slugs and had fallen four behind:
 * ropping, kachimo, kaidoki and uranoura are all real discovery sources whose
 * products `isConnectedProductSource` was silently rejecting, so they never
 * received a canonical identity or a row of evidence — and nothing logged the
 * rejection, so the loss looked like those channels simply producing nothing.
 *
 * `txd` stays out because `EXCLUDED_DISCOVERY_SLUGS` excludes it by operator
 * policy (2026-06-02) and its rows were purged; taking the exclusion from that
 * set rather than from a second literal means the next policy change reaches
 * here on its own.
 */
export const CONNECTED_PRODUCT_SOURCE_CHANNELS: ReadonlySet<string> = new Set(
	TV_CHANNELS.map((channel) => channel.slug).filter((slug) => !EXCLUDED_DISCOVERY_SLUGS.has(slug)),
);

export function isConnectedProductSource(value: string | null | undefined): boolean {
	return (value ?? "")
		.split(",")
		.map((channel) => channel.trim())
		.some((channel) => CONNECTED_PRODUCT_SOURCE_CHANNELS.has(channel));
}

export type BackfillSource = "products" | "broadcasts";

export interface BackfillSourcePageQuery {
	table: "discovered_products" | "broadcast_speech_analyses";
	select: string;
	dateColumn: "created_at" | "analyzed_at";
	filters: Array<{ kind: "eq" | "gte" | "in"; column: string; value: string | string[] }>;
	orderBy: Array<{ column: string; ascending: false }>;
	limit: number;
	cursorFilter?: string;
}

function cursorFilter(column: string, idColumn: string, position: BackfillCursorPosition): string {
	return `${column}.lt.${position.observedAt},and(${column}.eq.${position.observedAt},${idColumn}.lt.${position.id})`;
}

export function buildSourcePageQuery(
	source: BackfillSource,
	args: Pick<BackfillArgs, "since" | "limit">,
	state: BackfillSourceCursor,
): BackfillSourcePageQuery {
	if (state.done) throw new Error(`cannot query exhausted ${source} source`);
	if (source === "products") {
		return {
			table: "discovered_products",
			select: "id,name,category,product_url,price_jpy,review_count,tv_evidence,tv_evidence_at,created_at,tv_channel_source,user_action",
			dateColumn: "created_at",
			filters: [
				{ kind: "eq", column: "source", value: "tv_channel" },
				{ kind: "gte", column: "created_at", value: args.since },
			],
			orderBy: [{ column: "created_at", ascending: false }, { column: "id", ascending: false }],
			limit: args.limit,
			...(state.position ? { cursorFilter: cursorFilter("created_at", "id", state.position) } : {}),
		};
	}
	return {
		table: "broadcast_speech_analyses",
		select: "broadcast_id,channel,air_date,duration_sec,segments,selling_points,evidence_cues,objection_handlings,offer_timeline,analyzed_at,broadcasts(source_url)",
		dateColumn: "analyzed_at",
		filters: [
			{ kind: "in", column: "channel", value: ["qvc", "shopch"] },
			{ kind: "gte", column: "analyzed_at", value: args.since },
		],
		orderBy: [{ column: "analyzed_at", ascending: false }, { column: "broadcast_id", ascending: false }],
		limit: args.limit,
		...(state.position ? { cursorFilter: cursorFilter("analyzed_at", "broadcast_id", state.position) } : {}),
	};
}

function emptyReviewNeeded(): BackfillReviewNeeded {
	return {
		missingNormalizedCategory: 0,
		missingProductName: 0,
		missingProductSourceUrl: 0,
		missingBroadcastSourceUrl: 0,
	};
}

export async function executeBackfillPage(input: BackfillPageInput): Promise<BackfillPageSummary> {
	if (input.write && (!input.applyProduct || !input.applyBroadcast)) {
		throw new Error("write mode requires product and broadcast apply callbacks");
	}

	const rawCategories = [...new Set(
		input.products
			.map((row) => nonEmptyString(row.category))
			.filter((category): category is string => Boolean(category)),
	)];
	const normalized = await input.normalizeCategories(rawCategories);
	const reviewNeeded = emptyReviewNeeded();
	const reviewNeededCategories = new Set<string>();
	let productEvidenceCount = 0;
	let broadcastEvidenceCount = 0;
	let productRowsWritten = 0;
	let broadcastRowsWritten = 0;

	for (const product of input.products) {
		const rawCategory = nonEmptyString(product.category);
		const normalizedCategory = rawCategory ? nonEmptyString(normalized.get(rawCategory)?.[0]) : undefined;
		const mapped = { ...product, normalizedCategory: normalizedCategory ?? null };
		const drafts = mapDiscoveredProductEvidence(mapped);
		productEvidenceCount += drafts.length;
		if (!normalizedCategory) {
			reviewNeeded.missingNormalizedCategory += 1;
			if (rawCategory) reviewNeededCategories.add(rawCategory);
		}
		if (!nonEmptyString(product.name)) reviewNeeded.missingProductName += 1;
		if (!nonEmptyString(product.productUrl)) reviewNeeded.missingProductSourceUrl += 1;
		if (input.write && nonEmptyString(product.name)) {
			await input.applyProduct!(mapped, drafts);
			productRowsWritten += 1;
		}
	}

	for (const broadcast of input.broadcasts) {
		const drafts = mapBroadcastAnalysisEvidence(broadcast);
		broadcastEvidenceCount += drafts.length;
		if (!nonEmptyString(broadcast.sourceUrl)) reviewNeeded.missingBroadcastSourceUrl += 1;
		if (input.write) {
			await input.applyBroadcast!(broadcast, drafts);
			broadcastRowsWritten += 1;
		}
	}

	return {
		productEvidenceCount,
		broadcastEvidenceCount,
		productRowsWritten,
		broadcastRowsWritten,
		reviewNeeded,
		reviewNeededCategories: [...reviewNeededCategories].sort(),
	};
}

export interface FoundationSourcePage<Row> {
	rows: Row[];
	/** True only when the bounded query returned fewer than its requested limit. */
	exhausted: boolean;
	/** Count returned by the database before in-memory scope filtering. */
	readCount: number;
	/** Required for a non-exhausted source so equal timestamps can resume by ID. */
	next?: BackfillCursorPosition;
}

export interface FoundationWriteOutcome {
	/** Durable rows inserted by this operation. */
	new: number;
	/** Durable rows updated by this operation; source-link reuse is not an update. */
	updated?: number;
	/** Exact links/evidence already present and therefore reused/deduped. */
	duplicate: number;
}

export interface FoundationBackfillDependencies {
	args: Pick<BackfillArgs, "since" | "limit" | "apply">;
	cursor: BackfillCursor;
	fetchProducts(state: BackfillSourceCursor): Promise<FoundationSourcePage<DiscoveredProductBackfillRow>>;
	fetchBroadcasts(state: BackfillSourceCursor): Promise<FoundationSourcePage<BroadcastAnalysisBackfillRow>>;
	/** Read-only resolver used exclusively by dry-run. */
	loadCachedCategories(rawCategories: string[]): Promise<Map<string, string[]>>;
	/** Existing mutating normalizer, called exclusively by --apply. */
	normalizeCategories(rawCategories: string[]): Promise<Map<string, string[]>>;
	/** Must create a running attempt before any apply-mode source query. */
	startPipelineRun(): Promise<PipelineRunHandle>;
	writeProduct(row: DiscoveredProductBackfillRow, evidence: EvidenceDraft[]): Promise<FoundationWriteOutcome>;
	writeBroadcast(row: BroadcastAnalysisBackfillRow, evidence: EvidenceDraft[]): Promise<FoundationWriteOutcome>;
	/** Best-effort operational reporting for non-terminal recorder failures. */
	reportTelemetryFailure?(phase: "heartbeat", error: unknown): void;
}

export interface FoundationBackfillResult {
	/** Sources whose page could not be read; their cursors are unchanged. */
	failedSources?: BackfillSource[];
	sourceFailureSummary?: string;
	summary: BackfillPageSummary;
	productPage: FoundationSourcePage<DiscoveredProductBackfillRow>;
	broadcastPage: FoundationSourcePage<BroadcastAnalysisBackfillRow>;
	nextCursor: BackfillCursor;
	counts?: PipelineRunCounts;
}

function emptyCounts(processed = 0): PipelineRunCounts {
	return { new: 0, updated: 0, duplicate: 0, failed: 0, processed };
}

function addWriteOutcome(counts: PipelineRunCounts, outcome: FoundationWriteOutcome): void {
	counts.new += outcome.new;
	counts.updated += outcome.updated ?? 0;
	counts.duplicate += outcome.duplicate;
}

function nextSourceCursor(
	previous: BackfillSourceCursor,
	page: FoundationSourcePage<unknown>,
	source: BackfillSource,
): BackfillSourceCursor {
	if (previous.done) return { done: true };
	if (page.exhausted) return { done: true };
	if (!page.next) throw new Error(`${source} page omitted a cursor position before exhaustion`);
	return { done: false, position: page.next };
}

async function retryTerminalSettlement(action: () => Promise<void>): Promise<void> {
	let firstError: unknown;
	try {
		await action();
		return;
	} catch (error) {
		firstError = error;
	}
	try {
		await action();
	} catch (retryError) {
		throw new Error(`initial attempt: ${errorText(firstError)}; retry: ${errorText(retryError)}`);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function unqueriedPage<Row>(): FoundationSourcePage<Row> {
	return { rows: [], exhausted: true, readCount: 0 };
}

interface LoadedPages {
	productPage?: FoundationSourcePage<DiscoveredProductBackfillRow>;
	broadcastPage?: FoundationSourcePage<BroadcastAnalysisBackfillRow>;
	errors: Array<{ source: BackfillSource; error: unknown }>;
}

/**
 * Let one source fail without discarding the other's page.
 *
 * The cursor has always been per-source, but failure handling was not: a single
 * timeout on `broadcast_speech_analyses` threw away a healthy 200-row product
 * page that had already been read, and — because the throw skipped the summary
 * — took the operator's `nextCursor` with it, leaving them to recover the
 * resume point by hand from a previous run's output.
 *
 * A failed source now contributes nothing and keeps its own cursor exactly
 * where it was, so re-running retries only that source. Both failing is still
 * a hard error: there is no work to do and no progress to record.
 */
function resolveLoadedPages(loaded: LoadedPages): {
	productPage: FoundationSourcePage<DiscoveredProductBackfillRow>;
	broadcastPage: FoundationSourcePage<BroadcastAnalysisBackfillRow>;
	failedSources: BackfillSource[];
	failureSummary?: string;
} {
	if (loaded.errors.length >= 2) {
		throw new Error(loaded.errors.map(({ source, error }) => `${source}: ${errorText(error)}`).join("; "));
	}
	if (loaded.errors.length === 0 && (!loaded.productPage || !loaded.broadcastPage)) {
		throw new Error("source page query completed without both source results");
	}
	const failedSources = loaded.errors.map(({ source }) => source);
	return {
		// `unqueriedPage()` reports `exhausted: true`, which would mark the source
		// done. `nextSourceCursor` is given the untouched previous cursor for a
		// failed source instead, so this page only supplies "no rows".
		productPage: loaded.productPage ?? unqueriedPage<DiscoveredProductBackfillRow>(),
		broadcastPage: loaded.broadcastPage ?? unqueriedPage<BroadcastAnalysisBackfillRow>(),
		failedSources,
		...(loaded.errors.length > 0
			? { failureSummary: loaded.errors.map(({ source, error }) => `${source}: ${errorText(error)}`).join("; ") }
			: {}),
	};
}

/** A source that failed to load keeps its cursor; only a read can advance it. */
function nextCursorForSources(
	previous: BackfillCursor,
	productPage: FoundationSourcePage<unknown>,
	broadcastPage: FoundationSourcePage<unknown>,
	failedSources: readonly BackfillSource[],
): BackfillCursor {
	return {
		products: failedSources.includes("products")
			? previous.products
			: nextSourceCursor(previous.products, productPage, "products"),
		broadcasts: failedSources.includes("broadcasts")
			? previous.broadcasts
			: nextSourceCursor(previous.broadcasts, broadcastPage, "broadcasts"),
	};
}

async function heartbeatBestEffort(
	run: PipelineRunHandle,
	counts: PipelineRunCounts,
	reportTelemetryFailure: FoundationBackfillDependencies["reportTelemetryFailure"],
): Promise<void> {
	try {
		await run.heartbeat(counts);
	} catch (error) {
		try {
			reportTelemetryFailure?.("heartbeat", error);
		} catch {
			// Observability must never turn a recorder heartbeat failure into data failure.
		}
	}
}

/**
 * Dependency-injected orchestration boundary for the CLI. It is intentionally
 * the only place that decides source querying, dry-run write suppression,
 * heartbeat order, and terminal pipeline-run status.
 */
export async function runFoundationBackfill(
	input: FoundationBackfillDependencies,
): Promise<FoundationBackfillResult> {
	const loadPages = async (): Promise<LoadedPages> => {
		const [productResult, broadcastResult] = await Promise.allSettled([
			input.cursor.products.done ? Promise.resolve(unqueriedPage<DiscoveredProductBackfillRow>()) : input.fetchProducts(input.cursor.products),
			input.cursor.broadcasts.done ? Promise.resolve(unqueriedPage<BroadcastAnalysisBackfillRow>()) : input.fetchBroadcasts(input.cursor.broadcasts),
		]);
		return {
			...(productResult.status === "fulfilled" ? { productPage: productResult.value } : {}),
			...(broadcastResult.status === "fulfilled" ? { broadcastPage: broadcastResult.value } : {}),
			errors: [
				...(productResult.status === "rejected" ? [{ source: "products" as const, error: productResult.reason }] : []),
				...(broadcastResult.status === "rejected" ? [{ source: "broadcasts" as const, error: broadcastResult.reason }] : []),
			],
		};
	};

	if (!input.args.apply) {
		const { productPage, broadcastPage, failedSources } = resolveLoadedPages(await loadPages());
		const nextCursor = nextCursorForSources(input.cursor, productPage, broadcastPage, failedSources);
		const summary = await executeBackfillPage({
			products: productPage.rows,
			broadcasts: broadcastPage.rows,
			normalizeCategories: input.loadCachedCategories,
			write: false,
		});
		return {
			summary,
			productPage,
			broadcastPage,
			nextCursor,
		};
	}

	let run: PipelineRunHandle;
	try {
		run = await input.startPipelineRun();
	} catch (error) {
		throw new Error(`pipeline recorder start failed; no source query or durable write was attempted: ${errorText(error)}`);
	}

	let counts = emptyCounts();
	let writeAttempted = false;
	let failedSources: BackfillSource[] = [];
	let sourceFailureSummary: string | undefined;
	let pages: { productPage: FoundationSourcePage<DiscoveredProductBackfillRow>; broadcastPage: FoundationSourcePage<BroadcastAnalysisBackfillRow> } | undefined;
	let summary: BackfillPageSummary | undefined;
	let nextCursor: BackfillCursor | undefined;
	try {
		const loaded = await loadPages();
		counts = emptyCounts((loaded.productPage?.readCount ?? 0) + (loaded.broadcastPage?.readCount ?? 0));
		await heartbeatBestEffort(run, counts, input.reportTelemetryFailure);
		const resolved = resolveLoadedPages(loaded);
		pages = { productPage: resolved.productPage, broadcastPage: resolved.broadcastPage };
		failedSources = resolved.failedSources;
		sourceFailureSummary = resolved.failureSummary;
		nextCursor = nextCursorForSources(input.cursor, pages.productPage, pages.broadcastPage, failedSources);
		summary = await executeBackfillPage({
			products: pages.productPage.rows,
			broadcasts: pages.broadcastPage.rows,
			normalizeCategories: async (rawCategories) => {
				if (rawCategories.length > 0) writeAttempted = true;
				return input.normalizeCategories(rawCategories);
			},
			write: true,
			applyProduct: async (row, evidence) => {
				writeAttempted = true;
				addWriteOutcome(counts, await input.writeProduct(row, evidence));
				await heartbeatBestEffort(run, counts, input.reportTelemetryFailure);
			},
			applyBroadcast: async (row, evidence) => {
				writeAttempted = true;
				addWriteOutcome(counts, await input.writeBroadcast(row, evidence));
				await heartbeatBestEffort(run, counts, input.reportTelemetryFailure);
			},
		});
	} catch (dataError) {
		counts.failed += 1;
		const failure = errorText(dataError);
		if (writeAttempted) {
			try {
				await retryTerminalSettlement(() => run.partial(counts, "intelligence_foundation_backfill_partial", failure));
			} catch (telemetryError) {
				throw new Error(`backfill data failure after possible durable writes: ${failure}; partial telemetry settlement failed: ${errorText(telemetryError)}`);
			}
			throw new Error(`backfill data failure after possible durable writes; pipeline run recorded as partial: ${failure}`);
		}
		await heartbeatBestEffort(run, counts, input.reportTelemetryFailure);
		try {
			await retryTerminalSettlement(() => run.fail("intelligence_foundation_backfill_failed", failure));
		} catch (telemetryError) {
			throw new Error(`backfill data failure before durable writes: ${failure}; failed telemetry settlement failed: ${errorText(telemetryError)}`);
		}
		throw new Error(`backfill data failure before durable writes; pipeline run recorded as failed: ${failure}`);
	}

	try {
		// One source failing is degraded, not clean: its rows were never read and
		// its cursor has not moved, so the run has more to do than it looks.
		await retryTerminalSettlement(() => (sourceFailureSummary
			? run.partial(counts, "intelligence_foundation_backfill_source_failed", sourceFailureSummary)
			: run.succeed(counts)));
	} catch (telemetryError) {
		throw new Error(`data writes succeeded, but success telemetry settlement failed: ${errorText(telemetryError)}`);
	}

	return {
		summary: summary!,
		productPage: pages!.productPage,
		broadcastPage: pages!.broadcastPage,
		nextCursor: nextCursor!,
		counts,
		failedSources,
		...(sourceFailureSummary ? { sourceFailureSummary } : {}),
	};
}

export interface ExactSourceLink {
	canonicalProductId: string;
}

export interface CanonicalBackfillRepository {
	findExactSourceLink(row: DiscoveredProductBackfillRow): Promise<ExactSourceLink | null>;
	insertCanonical(row: DiscoveredProductBackfillRow): Promise<string>;
	insertExactSourceLink(input: { canonicalProductId: string; row: DiscoveredProductBackfillRow }): Promise<void>;
	deleteCanonical(canonicalProductId: string): Promise<void>;
	repairCanonicalCategory?(canonicalProductId: string, normalizedCategory: string): Promise<boolean>;
}

export interface ExactCanonicalResolution {
	canonicalProductId: string;
	/** This invocation inserted a canonical row that still durably exists. */
	canonicalProductCreated: boolean;
	/** This invocation inserted (or definitively completed) the exact source link. */
	exactSourceLinkCreated: boolean;
	/** An exact source link created by another operation was reused. */
	exactSourceLinkReused: boolean;
	/** A null/blank canonical category was conditionally repaired by this invocation. */
	canonicalCategoryUpdated: boolean;
}

async function repairResolvedCategory(
	repository: CanonicalBackfillRepository,
	resolution: Omit<ExactCanonicalResolution, "canonicalCategoryUpdated">,
	row: DiscoveredProductBackfillRow,
	eligible: boolean,
): Promise<ExactCanonicalResolution> {
	const normalizedCategory = row.normalizedCategory?.trim();
	const canonicalCategoryUpdated = Boolean(
		eligible
		&& normalizedCategory
		&& repository.repairCanonicalCategory
		&& await repository.repairCanonicalCategory(resolution.canonicalProductId, normalizedCategory),
	);
	return { ...resolution, canonicalCategoryUpdated };
}

function isRestrictProtectedCleanup(error: unknown): boolean {
	return /foreign[ -]?key|on delete restrict|\brestrict\b/i.test(errorText(error));
}

async function cleanupCreatedCanonical(
	repository: CanonicalBackfillRepository,
	canonicalProductId: string,
	row: DiscoveredProductBackfillRow,
	primaryError: unknown,
): Promise<ExactCanonicalResolution> {
	try {
		await repository.deleteCanonical(canonicalProductId);
	} catch (cleanupError) {
		if (isRestrictProtectedCleanup(cleanupError)) {
			try {
				const winner = await repository.findExactSourceLink(row);
				if (winner) {
					return repairResolvedCategory(
						repository,
						winner.canonicalProductId === canonicalProductId
							? { canonicalProductId, canonicalProductCreated: true, exactSourceLinkCreated: true, exactSourceLinkReused: false }
							: { canonicalProductId: winner.canonicalProductId, canonicalProductCreated: true, exactSourceLinkCreated: false, exactSourceLinkReused: true },
						row,
						winner.canonicalProductId !== canonicalProductId,
					);
				}
			} catch (lookupError) {
				throw new Error(`${errorText(primaryError)}; orphan canonical cleanup protected (local canonical was not deleted): ${errorText(cleanupError)}; source-link race lookup failed: ${errorText(lookupError)}`);
			}
			throw new Error(`${errorText(primaryError)}; orphan canonical cleanup protected (local canonical was not deleted): ${errorText(cleanupError)}`);
		}
		throw new Error(`${errorText(primaryError)}; orphan canonical cleanup failed: ${errorText(cleanupError)}`);
	}
	throw primaryError;
}

/** Exact-only canonical/source-link creation with race-safe orphan cleanup. */
export async function resolveExactCanonicalProduct(
	repository: CanonicalBackfillRepository,
	row: DiscoveredProductBackfillRow,
): Promise<ExactCanonicalResolution> {
	const existing = await repository.findExactSourceLink(row);
	if (existing) {
		return repairResolvedCategory(repository, {
			canonicalProductId: existing.canonicalProductId,
			canonicalProductCreated: false,
			exactSourceLinkCreated: false,
			exactSourceLinkReused: true,
		}, row, true);
	}
	const canonicalProductId = await repository.insertCanonical(row);
	try {
		await repository.insertExactSourceLink({ canonicalProductId, row });
		return { canonicalProductId, canonicalProductCreated: true, exactSourceLinkCreated: true, exactSourceLinkReused: false, canonicalCategoryUpdated: false };
	} catch (linkError) {
		let winner: ExactSourceLink | null = null;
		let lookupError: unknown;
		try {
			winner = await repository.findExactSourceLink(row);
		} catch (error) {
			lookupError = error;
		}
		if (winner) {
			if (winner.canonicalProductId === canonicalProductId) {
				return { canonicalProductId, canonicalProductCreated: true, exactSourceLinkCreated: true, exactSourceLinkReused: false, canonicalCategoryUpdated: false };
			}
			try {
				await repository.deleteCanonical(canonicalProductId);
			} catch (cleanupError) {
				if (isRestrictProtectedCleanup(cleanupError)) {
					// A different source may now legitimately reference the local
					// canonical. RESTRICT preserves that shared identity; the exact
					// winning source link remains the truthful product resolution.
					return repairResolvedCategory(repository, {
						canonicalProductId: winner.canonicalProductId,
						canonicalProductCreated: true,
						exactSourceLinkCreated: false,
						exactSourceLinkReused: true,
					}, row, true);
				}
				throw new Error(`${errorText(linkError)}; winning exact source link resolved to ${winner.canonicalProductId}; orphan canonical cleanup failed: ${errorText(cleanupError)}`);
			}
			return repairResolvedCategory(repository, {
				canonicalProductId: winner.canonicalProductId,
				canonicalProductCreated: false,
				exactSourceLinkCreated: false,
				exactSourceLinkReused: true,
			}, row, true);
		}
		return cleanupCreatedCanonical(repository, canonicalProductId, row, lookupError
			? new Error(`${errorText(linkError)}; source-link race lookup failed: ${errorText(lookupError)}`)
			: linkError);
	}
}
