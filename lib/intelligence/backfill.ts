import { buildEvidenceDraft } from "./evidence";
import type { EvidenceClass, EvidenceDraft, EvidenceValueState } from "./types";

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
	tvEvidence: { airing_count?: unknown } | null;
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

export interface BackfillCursor {
	products?: BackfillCursorPosition;
	broadcasts?: BackfillCursorPosition;
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

function requireObservedAt(observedAt: string): string {
	if (!Number.isFinite(Date.parse(observedAt))) {
		throw new Error("backfill evidence requires a source observation timestamp");
	}
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
			observedAt: row.observedAt,
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
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) throw new Error("--since must be an ISO date or timestamp");
	return date.toISOString();
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
	if (typeof record.observedAt !== "string" || !Number.isFinite(Date.parse(record.observedAt))) return undefined;
	if (typeof record.id !== "string" || !record.id) return undefined;
	return { observedAt: record.observedAt, id: record.id };
}

export function parseBackfillCursor(cursor: string): BackfillCursor {
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
		if (parsed.v !== 1) throw new Error("unsupported cursor version");
		const products = parseCursorPosition(parsed.products);
		const broadcasts = parseCursorPosition(parsed.broadcasts);
		if (!products && !broadcasts) throw new Error("empty cursor");
		return { ...(products ? { products } : {}), ...(broadcasts ? { broadcasts } : {}) };
	} catch {
		throw new Error("invalid cursor");
	}
}

export function buildBackfillCursor(cursor: BackfillCursor): string {
	const payload = {
		v: 1,
		...(cursor.products ? { products: cursor.products } : {}),
		...(cursor.broadcasts ? { broadcasts: cursor.broadcasts } : {}),
	};
	if (!cursor.products && !cursor.broadcasts) throw new Error("cannot build an empty cursor");
	return Buffer.from(JSON.stringify(payload)).toString("base64url");
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
