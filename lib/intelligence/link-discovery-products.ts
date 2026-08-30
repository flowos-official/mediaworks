import type { SupabaseClient } from "@supabase/supabase-js";

import {
	isConnectedProductSource,
	mapDiscoveredProductEvidence,
	resolveExactCanonicalProduct,
	type DiscoveredProductBackfillRow,
} from "./backfill";
import { upsertEvidenceDetailed } from "./repository";

const PRODUCT_SOURCE_TABLE = "discovered_products";
const PRODUCT_SOURCE_TYPE = "discovery";

/**
 * Identity resolution and evidence capture for discovered products.
 *
 * Extracted from scripts/backfill-intelligence-foundation.ts so the nightly
 * discovery crons can reach it too. Previously the only caller was that CLI, so
 * `product_source_links` was written exclusively by hand — while the readiness
 * denominator is the newest discovery session, which the cron replaces every
 * night. Canonical-link and category coverage were therefore structurally
 * pinned at 0%: the numerator only ever moved when an operator remembered to
 * run a script, and the denominator moved on its own every day.
 */
export function createCanonicalProductRepository(sb: SupabaseClient) {
	return {
		async findExactSourceLink(row: DiscoveredProductBackfillRow) {
			const { data, error } = await sb
				.from("product_source_links")
				.select("canonical_product_id")
				.eq("source_type", PRODUCT_SOURCE_TYPE)
				.eq("source_table", PRODUCT_SOURCE_TABLE)
				.eq("source_record_id", row.id)
				.maybeSingle();
			if (error) throw new Error(`product source-link lookup failed: ${error.message}`);
			return data?.canonical_product_id ? { canonicalProductId: String(data.canonical_product_id) } : null;
		},
		async insertCanonical(row: DiscoveredProductBackfillRow) {
			const displayName = row.name?.trim();
			if (!displayName) throw new Error(`cannot create a canonical product for ${row.id}: product name is missing`);
			const { data, error } = await sb
				.from("canonical_products")
				.insert({
					display_name: displayName,
					normalized_category: row.normalizedCategory ?? null,
					attributes: { source_table: PRODUCT_SOURCE_TABLE, source_record_id: row.id },
				})
				.select("id")
				.single();
			if (error) throw new Error(`canonical product insert failed: ${error.message}`);
			if (!data?.id) throw new Error("canonical product insert returned no id");
			return String(data.id);
		},
		async insertExactSourceLink(input: { canonicalProductId: string; row: DiscoveredProductBackfillRow }) {
			const displayName = input.row.name?.trim();
			if (!displayName) throw new Error(`cannot link a canonical product for ${input.row.id}: product name is missing`);
			const { error } = await sb.from("product_source_links").insert({
				canonical_product_id: input.canonicalProductId,
				source_type: PRODUCT_SOURCE_TYPE,
				source_table: PRODUCT_SOURCE_TABLE,
				source_record_id: input.row.id,
				source_product_id: null,
				raw_name: displayName,
				match_method: "exact_id",
				confidence: 1,
				confirmed: false,
			});
			if (error) throw new Error(`product source-link insert failed: ${error.message}`);
		},
		async deleteCanonical(canonicalProductId: string) {
			const { error } = await sb.from("canonical_products").delete().eq("id", canonicalProductId);
			if (error) throw new Error(`orphan canonical cleanup failed: ${error.message}`);
		},
		async repairCanonicalCategory(canonicalProductId: string, normalizedCategory: string) {
			const { data: current, error: readError } = await sb
				.from("canonical_products")
				.select("id,normalized_category")
				.eq("id", canonicalProductId)
				.maybeSingle();
			if (readError) throw new Error(`canonical category read failed: ${readError.message}`);
			if (!current?.id) throw new Error(`canonical category read returned no product for ${canonicalProductId}`);
			const currentCategory = typeof current.normalized_category === "string" ? current.normalized_category : null;
			if (currentCategory?.trim()) return false;
			let update = sb
				.from("canonical_products")
				.update({ normalized_category: normalizedCategory })
				.eq("id", canonicalProductId);
			update = currentCategory === null
				? update.is("normalized_category", null)
				: update.eq("normalized_category", currentCategory);
			const { data, error } = await update.select("id");
			if (error) throw new Error(`canonical category update failed: ${error.message}`);
			return (data ?? []).length > 0;
		},
	};
}

export interface LinkDiscoveryProductsResult {
	considered: number;
	linked: number;
	alreadyLinked: number;
	skipped: number;
	failed: number;
	evidenceWritten: number;
	/** Rows whose raw category is not in the normalization cache yet. */
	categoryUnresolved: number;
}

export interface LinkDiscoveryProductsOptions {
	/** Absolute epoch-ms budget. The cron owns the clock; this stops on it. */
	deadlineAtMs?: number;
	now?: () => number;
	/**
	 * Resolve raw categories to whitelist categories. Defaults to a read of the
	 * `discovered_category_normalization` cache.
	 *
	 * Deliberately not the Gemini-backed normalizer the CLI uses: this runs
	 * inside the discovery cron's save budget, and a classifier call per session
	 * is neither affordable there nor safe to fail on. An uncached category
	 * therefore resolves to null, which is the truthful answer — and a later run
	 * repairs it through `repairCanonicalCategory` once the cache warms.
	 */
	resolveNormalizedCategories?: (rawCategories: string[]) => Promise<Map<string, string | null>>;
}

/**
 * Read-only category resolution. A column named `normalized_category` must
 * never receive a raw value: 114 of the 135 canonical rows were normalized
 * against the whitelist by the CLI, and mixing unnormalized values in would
 * make the coverage metric read as satisfied while being wrong.
 */
export async function loadCachedNormalizedCategories(
	sb: SupabaseClient,
	rawCategories: string[],
): Promise<Map<string, string | null>> {
	const resolved = new Map<string, string | null>(rawCategories.map((category) => [category, null]));
	if (rawCategories.length === 0) return resolved;
	const { data, error } = await sb
		.from("discovered_category_normalization")
		.select("raw_category,whitelist_categories")
		.in("raw_category", rawCategories);
	if (error) throw new Error(`category cache query failed: ${error.message}`);
	for (const item of data ?? []) {
		const row = item as { raw_category: string; whitelist_categories: string[] | null };
		const first = Array.isArray(row.whitelist_categories) ? row.whitelist_categories[0] : undefined;
		resolved.set(row.raw_category, typeof first === "string" && first.trim() ? first.trim() : null);
	}
	return resolved;
}

interface SessionProductRow {
	id: string;
	name: string | null;
	category: string | null;
	price_jpy: number | null;
	review_count: number | null;
	product_url: string | null;
	source: string | null;
	tv_channel_source: string | null;
	tv_evidence: unknown;
	tv_evidence_at: string | null;
	created_at: string;
}

const SESSION_PRODUCT_COLUMNS =
	"id,name,category,price_jpy,review_count,product_url,source,tv_channel_source,tv_evidence,tv_evidence_at,created_at";

/**
 * Give one discovery session's products a canonical identity and evidence.
 *
 * Deliberately narrow: it resolves identity for rows the session just produced
 * and writes their evidence. It does not scan history, and it never throws at
 * the caller — the discovery cron treats it as an optional stage, because
 * failing to record telemetry-grade identity is not a reason to lose a night's
 * candidates.
 */
export async function linkDiscoverySessionProducts(
	sb: SupabaseClient,
	sessionId: string,
	options: LinkDiscoveryProductsOptions = {},
): Promise<LinkDiscoveryProductsResult> {
	const now = options.now ?? (() => Date.now());
	const outOfBudget = () => options.deadlineAtMs !== undefined && now() >= options.deadlineAtMs;
	const result: LinkDiscoveryProductsResult = {
		considered: 0,
		linked: 0,
		alreadyLinked: 0,
		skipped: 0,
		failed: 0,
		evidenceWritten: 0,
		categoryUnresolved: 0,
	};

	const { data, error } = await sb
		.from("discovered_products")
		.select(SESSION_PRODUCT_COLUMNS)
		.eq("session_id", sessionId)
		.order("id", { ascending: true });
	if (error) throw new Error(`discovery session products read failed: ${error.message}`);

	const sessionRows = (data ?? []) as unknown as SessionProductRow[];
	const rawCategories = [...new Set(
		sessionRows
			.map((row) => row.category?.trim())
			.filter((category): category is string => Boolean(category)),
	)];
	const resolveCategories = options.resolveNormalizedCategories
		?? ((categories: string[]) => loadCachedNormalizedCategories(sb, categories));
	const normalizedByRaw = await resolveCategories(rawCategories);

	const repository = createCanonicalProductRepository(sb);
	for (const raw of sessionRows) {
		if (outOfBudget()) break;
		result.considered += 1;

		// The same eligibility the CLI backfill applies: only sources this
		// foundation actually covers, and only rows with a usable name.
		const name = raw.name?.trim();
		if (!name || raw.source !== "tv_channel" || !isConnectedProductSource(raw.tv_channel_source)) {
			result.skipped += 1;
			continue;
		}

		try {
			const rawCategory = raw.category?.trim() || null;
			const normalizedCategory = rawCategory ? normalizedByRaw.get(rawCategory) ?? null : null;
			if (rawCategory && !normalizedCategory) result.categoryUnresolved += 1;
			const row: DiscoveredProductBackfillRow = {
				id: raw.id,
				name,
				category: rawCategory,
				normalizedCategory: normalizedCategory ?? null,
				priceJpy: raw.price_jpy,
				reviewCount: raw.review_count,
				productUrl: raw.product_url,
				tvEvidence: raw.tv_evidence,
				tvEvidenceAt: raw.tv_evidence_at,
				observedAt: raw.created_at,
			} as DiscoveredProductBackfillRow;

			const resolved = await resolveExactCanonicalProduct(repository, row);
			if (resolved.exactSourceLinkCreated) result.linked += 1;
			else result.alreadyLinked += 1;

			const evidence = await upsertEvidenceDetailed(
				sb,
				mapDiscoveredProductEvidence({ ...row, canonicalProductId: resolved.canonicalProductId }),
			);
			result.evidenceWritten += evidence.insertedDedupeKeys.length;
		} catch (err) {
			result.failed += 1;
			console.warn(
				`[intelligence] canonical link failed for ${raw.id}:`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	return result;
}
