import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeCategoriesBatch } from "../lib/discovery/category-normalize";
import {
	buildBackfillCursor,
	executeBackfillPage,
	mapBroadcastAnalysisEvidence,
	mapDiscoveredProductEvidence,
	parseBackfillArgs,
	parseBackfillCursor,
	type BackfillArgs,
	type BackfillCursor,
	type BackfillCursorPosition,
	type BroadcastAnalysisBackfillRow,
	type DiscoveredProductBackfillRow,
} from "../lib/intelligence/backfill";
import { upsertEvidence } from "../lib/intelligence/repository";
import {
	createPipelineRunRepository,
	startPipelineRun,
	type PipelineRunCounts,
} from "../lib/intelligence/pipeline-run";
import { getServiceClient } from "../lib/supabase";

const PRODUCT_SOURCE_TABLE = "discovered_products";
const PRODUCT_SOURCE_TYPE = "discovery";
const CONNECTED_SOURCE_CHANNELS = new Set([
	"qvc",
	"shopch",
	"japanet",
	"junsanpo",
	"ntv",
	"tbs",
	"dinos",
	"senobura",
	"kantv",
	"rakuraku",
	"ichiban",
]);

interface RawProductRow {
	id: string;
	name: string | null;
	category: string | null;
	product_url: string | null;
	price_jpy: number | null;
	review_count: number | null;
	tv_evidence: { airing_count?: unknown } | null;
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

interface ProductPage {
	rows: DiscoveredProductBackfillRow[];
	next?: BackfillCursorPosition;
}

interface BroadcastPage {
	rows: BroadcastAnalysisBackfillRow[];
	next?: BackfillCursorPosition;
}

interface CanonicalResolution {
	canonicalProductId: string;
	created: boolean;
	reusedLink: boolean;
}

interface EvidenceWriteCounts {
	attempted: number;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sourceChannels(value: string | null | undefined): string[] {
	return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function isConnectedProductSource(value: string | null | undefined): boolean {
	return sourceChannels(value).some((channel) => CONNECTED_SOURCE_CHANNELS.has(channel));
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
		// discovered_products has no updated_at. created_at is the stable
		// source observation timestamp and keyset field available to this job.
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

function afterCursorFilter(column: string, cursor: BackfillCursorPosition): string {
	return `${column}.lt.${cursor.observedAt},and(${column}.eq.${cursor.observedAt},id.lt.${cursor.id})`;
}

async function loadProductPage(
	sb: SupabaseClient,
	args: BackfillArgs,
	cursor: BackfillCursor,
): Promise<ProductPage> {
	let query = sb
		.from(PRODUCT_SOURCE_TABLE)
		.select("id,name,category,product_url,price_jpy,review_count,tv_evidence,created_at,tv_channel_source,user_action")
		.eq("source", "tv_channel")
		.gte("created_at", args.since)
		.order("created_at", { ascending: false })
		.order("id", { ascending: false })
		.limit(args.limit);
	if (cursor.products) query = query.or(afterCursorFilter("created_at", cursor.products));

	const { data, error } = await query;
	if (error) throw new Error(`discovered_products page query failed: ${error.message}`);
	const fetched = (data ?? []) as RawProductRow[];
	const last = fetched.at(-1);
	return {
		rows: fetched
			.filter((row) => isActiveProduct(row) && isConnectedProductSource(row.tv_channel_source))
			.map(asProductRow),
		...(last && fetched.length === args.limit
			? { next: { observedAt: last.created_at, id: last.id } }
			: {}),
	};
}

async function loadBroadcastPage(
	sb: SupabaseClient,
	args: BackfillArgs,
	cursor: BackfillCursor,
): Promise<BroadcastPage> {
	let query = sb
		.from("broadcast_speech_analyses")
		.select("broadcast_id,channel,air_date,duration_sec,segments,selling_points,evidence_cues,objection_handlings,offer_timeline,analyzed_at,broadcasts(source_url)")
		.in("channel", ["qvc", "shopch"])
		.gte("analyzed_at", args.since)
		.order("analyzed_at", { ascending: false })
		.order("broadcast_id", { ascending: false })
		.limit(args.limit);
	if (cursor.broadcasts) {
		query = query.or(
			`analyzed_at.lt.${cursor.broadcasts.observedAt},and(analyzed_at.eq.${cursor.broadcasts.observedAt},broadcast_id.lt.${cursor.broadcasts.id})`,
		);
	}

	const { data, error } = await query;
	if (error) throw new Error(`broadcast_speech_analyses page query failed: ${error.message}`);
	const fetched = (data ?? []) as RawBroadcastAnalysisRow[];
	const last = fetched.at(-1);
	return {
		rows: fetched.map(asBroadcastRow),
		...(last && fetched.length === args.limit
			? { next: { observedAt: last.analyzed_at, id: last.broadcast_id } }
			: {}),
	};
}

/** Read only already-cached mappings; never classify or cache in dry-run mode. */
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

async function resolveCanonicalProduct(
	sb: SupabaseClient,
	row: DiscoveredProductBackfillRow,
): Promise<CanonicalResolution> {
	const { data: existing, error: existingError } = await sb
		.from("product_source_links")
		.select("canonical_product_id")
		.eq("source_type", PRODUCT_SOURCE_TYPE)
		.eq("source_table", PRODUCT_SOURCE_TABLE)
		.eq("source_record_id", row.id)
		.maybeSingle();
	if (existingError) throw new Error(`product source-link lookup failed: ${existingError.message}`);
	if (existing?.canonical_product_id) {
		return { canonicalProductId: String(existing.canonical_product_id), created: false, reusedLink: true };
	}

	const displayName = row.name?.trim();
	if (!displayName) throw new Error(`cannot create a canonical product for ${row.id}: product name is missing`);
	const { data: canonical, error: canonicalError } = await sb
		.from("canonical_products")
		.insert({
			display_name: displayName,
			normalized_category: row.normalizedCategory ?? null,
			attributes: { source_table: PRODUCT_SOURCE_TABLE, source_record_id: row.id },
		})
		.select("id")
		.single();
	if (canonicalError) throw new Error(`canonical product insert failed: ${canonicalError.message}`);
	if (!canonical?.id) throw new Error("canonical product insert returned no id");

	const { data: linked, error: linkError } = await sb
		.from("product_source_links")
		.insert({
			canonical_product_id: canonical.id,
			source_type: PRODUCT_SOURCE_TYPE,
			source_table: PRODUCT_SOURCE_TABLE,
			source_record_id: row.id,
			source_product_id: null,
			raw_name: displayName,
			match_method: "exact_id",
			confidence: 1,
			confirmed: false,
		})
		.select("canonical_product_id")
		.single();
	if (!linkError && linked?.canonical_product_id) {
		return { canonicalProductId: String(linked.canonical_product_id), created: true, reusedLink: false };
	}

	// A concurrent apply can win after the first lookup. Reuse only that exact
	// source link; no similarity matching or implicit product merging occurs.
	const { data: concurrent, error: concurrentError } = await sb
		.from("product_source_links")
		.select("canonical_product_id")
		.eq("source_type", PRODUCT_SOURCE_TYPE)
		.eq("source_table", PRODUCT_SOURCE_TABLE)
		.eq("source_record_id", row.id)
		.maybeSingle();
	if (concurrentError || !concurrent?.canonical_product_id) {
		throw new Error(`product source-link insert failed: ${linkError?.message ?? "no canonical product id returned"}`);
	}
	return { canonicalProductId: String(concurrent.canonical_product_id), created: false, reusedLink: true };
}

async function writeProductEvidence(
	sb: SupabaseClient,
	row: DiscoveredProductBackfillRow,
): Promise<EvidenceWriteCounts & CanonicalResolution> {
	const canonical = await resolveCanonicalProduct(sb, row);
	const drafts = mapDiscoveredProductEvidence({ ...row, canonicalProductId: canonical.canonicalProductId });
	await upsertEvidence(sb, drafts);
	return { ...canonical, attempted: drafts.length };
}

async function writeBroadcastEvidence(
	sb: SupabaseClient,
	row: BroadcastAnalysisBackfillRow,
): Promise<EvidenceWriteCounts> {
	const drafts = mapBroadcastAnalysisEvidence(row);
	await upsertEvidence(sb, drafts);
	return { attempted: drafts.length };
}

function printSummary(input: {
	args: BackfillArgs;
	productPage: ProductPage;
	broadcastPage: BroadcastPage;
	summary: Awaited<ReturnType<typeof executeBackfillPage>>;
	write: boolean;
	canonicalCreated?: number;
	sourceLinksReused?: number;
	evidenceAttempted?: number;
}): void {
	const nextCursor = buildNextCursor(input.productPage.next, input.broadcastPage.next);
	console.log(JSON.stringify({
		event: "intelligence_foundation_backfill.summary",
		write: input.write,
		since: input.args.since,
		limitPerSource: input.args.limit,
		productRecencyField: "created_at",
		productsRead: input.productPage.rows.length,
		broadcastAnalysesRead: input.broadcastPage.rows.length,
		canonicalProductsProposed: input.productPage.rows.filter((row) => Boolean(row.name?.trim())).length,
		sourceLinksProposed: input.productPage.rows.filter((row) => Boolean(row.name?.trim())).length,
		evidenceProposed: input.summary.productEvidenceCount + input.summary.broadcastEvidenceCount,
		canonicalProductsCreated: input.canonicalCreated,
		sourceLinksReused: input.sourceLinksReused,
		evidenceAttempted: input.evidenceAttempted,
		productRowsWritten: input.summary.productRowsWritten,
		broadcastRowsWritten: input.summary.broadcastRowsWritten,
		reviewNeeded: input.summary.reviewNeeded,
		reviewNeededCategories: input.summary.reviewNeededCategories,
		nextCursor,
	}, null, 2));
}

function buildNextCursor(
	products: BackfillCursorPosition | undefined,
	broadcasts: BackfillCursorPosition | undefined,
): string | null {
	return products || broadcasts ? buildBackfillCursor({ ...(products ? { products } : {}), ...(broadcasts ? { broadcasts } : {}) }) : null;
}

function runCounts(input: {
	processed: number;
	created: number;
	reused: number;
}): PipelineRunCounts {
	return {
		new: input.created,
		updated: input.reused,
		duplicate: 0,
		failed: 0,
		processed: input.processed,
	};
}

async function main(): Promise<void> {
	const args = parseBackfillArgs(process.argv.slice(2));
	const cursor = args.cursor ? parseBackfillCursor(args.cursor) : {};
	const sb = getServiceClient();
	const [productPage, broadcastPage] = await Promise.all([
		loadProductPage(sb, args, cursor),
		loadBroadcastPage(sb, args, cursor),
	]);

	if (!args.apply) {
		const summary = await executeBackfillPage({
			products: productPage.rows,
			broadcasts: broadcastPage.rows,
			normalizeCategories: (rawCategories) => loadCachedCategories(sb, rawCategories),
			write: false,
		});
		printSummary({ args, productPage, broadcastPage, summary, write: false });
		return;
	}

	const externalRunId = `intelligence-foundation-backfill:${randomUUID()}`;
	let pipelineRun;
	try {
		pipelineRun = await startPipelineRun(createPipelineRunRepository(sb), {
			sourceType: "intelligence_foundation",
			jobType: "intelligence_foundation_backfill",
			externalRunId,
			targetScope: {
				since: args.since,
				limit_per_source: args.limit,
				cursor: cursor,
				sources: ["qvc", "shopch", "oa"],
			},
		});
	} catch (error) {
		throw new Error(`pipeline recorder start failed; no canonical/source-link/evidence writes were attempted: ${message(error)}`);
	}

	let canonicalCreated = 0;
	let sourceLinksReused = 0;
	let evidenceAttempted = 0;
	try {
		const summary = await executeBackfillPage({
			products: productPage.rows,
			broadcasts: broadcastPage.rows,
			normalizeCategories: (rawCategories) => normalizeCategoriesBatch(sb, rawCategories),
			write: true,
			applyProduct: async (row) => {
				const outcome = await writeProductEvidence(sb, row);
				canonicalCreated += Number(outcome.created);
				sourceLinksReused += Number(outcome.reusedLink);
				evidenceAttempted += outcome.attempted;
			},
			applyBroadcast: async (row) => {
				const outcome = await writeBroadcastEvidence(sb, row);
				evidenceAttempted += outcome.attempted;
			},
		});
		const counts = runCounts({
			processed: summary.productRowsWritten + summary.broadcastRowsWritten,
			created: canonicalCreated,
			reused: sourceLinksReused,
		});
		await pipelineRun.succeed(counts);
		printSummary({
			args,
			productPage,
			broadcastPage,
			summary,
			write: true,
			canonicalCreated,
			sourceLinksReused,
			evidenceAttempted,
		});
	} catch (error) {
		const writeFailure = message(error);
		try {
			await pipelineRun.fail("intelligence_foundation_backfill_failed", writeFailure);
		} catch (recorderError) {
			throw new Error(
				`backfill failed after possible partial writes: ${writeFailure}; pipeline recorder failed to settle the run: ${message(recorderError)}`,
			);
		}
		throw new Error(`backfill failed after possible partial writes; pipeline run recorded as failed: ${writeFailure}`);
	}
}

main().catch((error) => {
	console.error(`FATAL: ${message(error)}`);
	process.exitCode = 1;
});
