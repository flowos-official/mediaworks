import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeCategoriesBatch } from "../lib/discovery/category-normalize";
import {
	buildBackfillCursor,
	buildSourcePageQuery,
	initialBackfillCursor,
	isConnectedProductSource,
	mapBroadcastAnalysisEvidence,
	mapDiscoveredProductEvidence,
	parseBackfillArgs,
	parseBackfillCursor,
	resolveExactCanonicalProduct,
	runFoundationBackfill,
	type BackfillArgs,
	type BackfillSourceCursor,
	type BackfillSourcePageQuery,
	type BroadcastAnalysisBackfillRow,
	type DiscoveredProductBackfillRow,
	type FoundationBackfillResult,
	type FoundationSourcePage,
	type FoundationWriteOutcome,
} from "../lib/intelligence/backfill";
import { upsertEvidenceDetailed } from "../lib/intelligence/repository";
// Identity resolution moved to lib so the discovery crons resolve it the same
// way this CLI does; re-exported because the smoke test reaches for it here.
import { createCanonicalProductRepository } from "../lib/intelligence/link-discovery-products";

export { createCanonicalProductRepository as canonicalRepository };
import { createPipelineRunRepository, startPipelineRun, type PipelineRunHandle } from "../lib/intelligence/pipeline-run";
import { getServiceClient } from "../lib/supabase";

const PRODUCT_SOURCE_TABLE = "discovered_products";
const PRODUCT_SOURCE_TYPE = "discovery";

interface RawProductRow {
	id: string;
	name: string | null;
	category: string | null;
	product_url: string | null;
	price_jpy: number | null;
	review_count: number | null;
	tv_evidence: { airing_count?: unknown; matched_at?: unknown } | null;
	tv_evidence_at: string | null;
	created_at: string;
	tv_channel_source: string | null;
	user_action: "sourced" | "interested" | "rejected" | "duplicate" | null;
}

interface RawBroadcastAnalysisRow {
	broadcast_id: string;
	channel: string | null;
	air_date: string | null;
	duration_sec: number | null;
	segments: unknown[] | null;
	selling_points: unknown[] | null;
	evidence_cues: unknown[] | null;
	objection_handlings: unknown[] | null;
	offer_timeline: Record<string, unknown> | null;
	analyzed_at: string;
	broadcasts: { source_url: string | null } | Array<{ source_url: string | null }> | null;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isActiveProduct(row: RawProductRow): boolean {
	return row.user_action === null || row.user_action === "sourced" || row.user_action === "interested";
}

function asProductRow(row: RawProductRow): DiscoveredProductBackfillRow {
	return {
		id: row.id,
		name: row.name,
		category: row.category,
		productUrl: row.product_url,
		priceJpy: row.price_jpy,
		reviewCount: row.review_count,
		tvEvidence: row.tv_evidence,
		tvEvidenceAt: row.tv_evidence_at,
		// discovered_products has no updated_at. created_at remains the only
		// stable source-row recency and fallback observation time available.
		observedAt: row.created_at,
		sourceType: PRODUCT_SOURCE_TYPE,
		sourceTable: PRODUCT_SOURCE_TABLE,
	};
}

function broadcastSourceUrl(value: RawBroadcastAnalysisRow["broadcasts"]): string | null {
	if (Array.isArray(value)) return value[0]?.source_url ?? null;
	return value?.source_url ?? null;
}

function asBroadcastRow(row: RawBroadcastAnalysisRow): BroadcastAnalysisBackfillRow {
	return {
		broadcastId: row.broadcast_id,
		channel: row.channel,
		airDate: row.air_date,
		durationSec: row.duration_sec,
		segments: row.segments,
		sellingPoints: row.selling_points,
		evidenceCues: row.evidence_cues,
		objectionHandlings: row.objection_handlings,
		offerTimeline: row.offer_timeline,
		observedAt: row.analyzed_at,
		sourceUrl: broadcastSourceUrl(row.broadcasts),
	};
}

async function executePageQuery(
	sb: SupabaseClient,
	plan: BackfillSourcePageQuery,
): Promise<unknown[]> {
	let query: any = sb.from(plan.table).select(plan.select);
	for (const filter of plan.filters) {
		if (filter.kind === "eq") query = query.eq(filter.column, filter.value as string);
		if (filter.kind === "gte") query = query.gte(filter.column, filter.value as string);
		if (filter.kind === "in") query = query.in(filter.column, filter.value as string[]);
	}
	for (const order of plan.orderBy) query = query.order(order.column, { ascending: order.ascending });
	if (plan.cursorFilter) query = query.or(plan.cursorFilter);
	const { data, error } = await query.limit(plan.limit);
	if (error) throw new Error(`${plan.table} page query failed: ${error.message}`);
	return data ?? [];
}

async function loadProductPage(
	sb: SupabaseClient,
	args: BackfillArgs,
	state: BackfillSourceCursor,
): Promise<FoundationSourcePage<DiscoveredProductBackfillRow>> {
	const plan = buildSourcePageQuery("products", args, state);
	const fetched = await executePageQuery(sb, plan) as RawProductRow[];
	const last = fetched.at(-1);
	return {
		rows: fetched.filter((row) => isActiveProduct(row) && isConnectedProductSource(row.tv_channel_source)).map(asProductRow),
		readCount: fetched.length,
		exhausted: fetched.length < args.limit,
		...(last && fetched.length === args.limit ? { next: { observedAt: last.created_at, id: last.id } } : {}),
	};
}

async function loadBroadcastPage(
	sb: SupabaseClient,
	args: BackfillArgs,
	state: BackfillSourceCursor,
): Promise<FoundationSourcePage<BroadcastAnalysisBackfillRow>> {
	const plan = buildSourcePageQuery("broadcasts", args, state);
	const fetched = await executePageQuery(sb, plan) as RawBroadcastAnalysisRow[];
	const last = fetched.at(-1);
	return {
		rows: fetched.map(asBroadcastRow),
		readCount: fetched.length,
		exhausted: fetched.length < args.limit,
		...(last && fetched.length === args.limit ? { next: { observedAt: last.analyzed_at, id: last.broadcast_id } } : {}),
	};
}

/** Read only the category cache; dry runs never invoke the mutating normalizer. */
async function loadCachedCategories(
	sb: SupabaseClient,
	rawCategories: string[],
): Promise<Map<string, string[]>> {
	const result = new Map(rawCategories.map((category) => [category, [] as string[]]));
	if (rawCategories.length === 0) return result;
	const { data, error } = await sb
		.from("discovered_category_normalization")
		.select("raw_category,whitelist_categories")
		.in("raw_category", rawCategories);
	if (error) throw new Error(`category cache query failed: ${error.message}`);
	for (const item of data ?? []) {
		const row = item as { raw_category: string; whitelist_categories: string[] | null };
		result.set(row.raw_category, Array.isArray(row.whitelist_categories) ? row.whitelist_categories : []);
	}
	return result;
}


async function upsertEvidenceWithCounts(
	sb: SupabaseClient,
	drafts: import("../lib/intelligence/types").EvidenceDraft[],
): Promise<FoundationWriteOutcome> {
	const result = await upsertEvidenceDetailed(sb, drafts);
	return {
		new: result.insertedDedupeKeys.length,
		duplicate: result.duplicateDedupeKeys.length,
	};
}

async function writeProduct(
	sb: SupabaseClient,
	row: DiscoveredProductBackfillRow,
): Promise<FoundationWriteOutcome> {
	const resolved = await resolveExactCanonicalProduct(createCanonicalProductRepository(sb), row);
	const evidence = await upsertEvidenceWithCounts(
		sb,
		mapDiscoveredProductEvidence({ ...row, canonicalProductId: resolved.canonicalProductId }),
	);
	return {
		new: evidence.new
			+ Number(resolved.canonicalProductCreated)
			+ Number(resolved.exactSourceLinkCreated),
		updated: Number(resolved.canonicalCategoryUpdated),
		duplicate: evidence.duplicate + Number(resolved.exactSourceLinkReused),
	};
}

async function writeBroadcast(
	sb: SupabaseClient,
	row: BroadcastAnalysisBackfillRow,
): Promise<FoundationWriteOutcome> {
	return upsertEvidenceWithCounts(sb, mapBroadcastAnalysisEvidence(row));
}

function nextCursorText(result: FoundationBackfillResult): string | null {
	return result.nextCursor.products.done && result.nextCursor.broadcasts.done
		? null
		: buildBackfillCursor(result.nextCursor);
}

function printSummary(args: BackfillArgs, result: FoundationBackfillResult): void {
	console.log(JSON.stringify({
		event: "intelligence_foundation_backfill.summary",
		write: args.apply,
		since: args.since,
		limitPerSource: args.limit,
		productRecencyField: "created_at",
		productsRead: result.productPage.rows.length,
		broadcastAnalysesRead: result.broadcastPage.rows.length,
		canonicalProductsProposed: result.productPage.rows.filter((row) => Boolean(row.name?.trim())).length,
		sourceLinksProposed: result.productPage.rows.filter((row) => Boolean(row.name?.trim())).length,
		evidenceProposed: result.summary.productEvidenceCount + result.summary.broadcastEvidenceCount,
		pipelineCounts: result.counts,
		productRowsWritten: result.summary.productRowsWritten,
		broadcastRowsWritten: result.summary.broadcastRowsWritten,
		reviewNeeded: result.summary.reviewNeeded,
		reviewNeededCategories: result.summary.reviewNeededCategories,
		nextCursor: nextCursorText(result),
	}, null, 2));
}

/** Injectable seams used by focused orchestration tests; production uses defaults. */
export interface CliBackfillDependencies {
	normalizeCategories?(rawCategories: string[]): Promise<Map<string, string[]>>;
	startPipelineRun?(): Promise<PipelineRunHandle>;
	reportTelemetryFailure?(phase: "heartbeat", error: unknown): void;
}

export async function runCliBackfill(
	args: BackfillArgs,
	sb: SupabaseClient = getServiceClient(),
	dependencies: CliBackfillDependencies = {},
): Promise<FoundationBackfillResult> {
	const cursor = args.cursor ? parseBackfillCursor(args.cursor) : initialBackfillCursor();
	return runFoundationBackfill({
		args,
		cursor,
		fetchProducts: (state) => loadProductPage(sb, args, state),
		fetchBroadcasts: (state) => loadBroadcastPage(sb, args, state),
		loadCachedCategories: (rawCategories) => loadCachedCategories(sb, rawCategories),
		normalizeCategories: dependencies.normalizeCategories ?? ((rawCategories) => normalizeCategoriesBatch(sb, rawCategories)),
		startPipelineRun: dependencies.startPipelineRun ?? (() => startPipelineRun(createPipelineRunRepository(sb), {
			sourceType: "intelligence_foundation",
			jobType: "intelligence_foundation_backfill",
			externalRunId: `intelligence-foundation-backfill:${randomUUID()}`,
			targetScope: {
				since: args.since,
				limit_per_source: args.limit,
				cursor,
				sources: ["qvc", "shopch", "oa"],
			},
		})),
		writeProduct: (row) => writeProduct(sb, row),
		writeBroadcast: (row) => writeBroadcast(sb, row),
		reportTelemetryFailure: dependencies.reportTelemetryFailure ?? ((phase, error) => {
			console.error(JSON.stringify({
				event: "intelligence_foundation_backfill.telemetry_failure",
				phase,
				error: errorText(error),
			}));
		}),
	});
}

async function main(): Promise<void> {
	const args = parseBackfillArgs(process.argv.slice(2));
	const result = await runCliBackfill(args);
	printSummary(args, result);
}

if (require.main === module) {
	main().catch((error) => {
		console.error(`FATAL: ${errorText(error)}`);
		process.exitCode = 1;
	});
}
