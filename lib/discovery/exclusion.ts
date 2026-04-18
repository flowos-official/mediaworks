/**
 * Exclusion filters for discovery pool.
 * Ref: spec §4.2 단계 4.
 *
 * 3 filter layers:
 *  1. Own sourcing history (product_summaries) — fuzzy prefix match
 *  2. Last 7 days URLs + cross-session rakuten_item_code
 *  3. Rejected seeds from learning_state (urls / brands / terms)
 */

import { getServiceClient } from "@/lib/supabase";
import type {
	ExclusionContext,
	LearningState,
	PoolItem,
} from "./types";

const OWN_NAME_PREFIX_LEN = 8;
const RECENT_WINDOW_DAYS = 7;

/**
 * Normalize a product name for fuzzy comparison: lowercase, strip whitespace,
 * punctuation, brackets, and common separators. Truncate to 80 chars.
 */
export function normalizeName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[\s\u3000【】\[\]（）()「」『』・,．.、。!?！？]/g, "")
		.slice(0, 80);
}

/**
 * Load exclusion data from DB + learning state.
 */
export async function loadExclusionContext(
	learning: LearningState,
): Promise<ExclusionContext> {
	const sb = getServiceClient();

	const [ownRes, recentRes, codesRes, feedbackRes] = await Promise.all([
		sb.from("product_summaries").select("product_name").limit(5000),
		sb
			.from("discovered_products")
			.select("product_url")
			.gte(
				"created_at",
				new Date(
					Date.now() - RECENT_WINDOW_DAYS * 24 * 3600 * 1000,
				).toISOString(),
			),
		sb
			.from("discovered_products")
			.select("rakuten_item_code")
			.not("rakuten_item_code", "is", null),
		sb
			.from("discovered_products")
			.select("product_url, rakuten_item_code")
			.in("user_action", ["sourced", "duplicate"]),
	]);

	if (ownRes.error) {
		console.warn(
			"[exclusion] product_summaries query failed:",
			ownRes.error.message,
		);
	}
	if (recentRes.error) {
		console.warn(
			"[exclusion] discovered_products (7d) query failed:",
			recentRes.error.message,
		);
	}
	if (codesRes.error) {
		console.warn(
			"[exclusion] discovered_products (codes) query failed:",
			codesRes.error.message,
		);
	}
	if (feedbackRes.error) {
		console.warn(
			"[exclusion] discovered_products (feedback sourced) query failed:",
			feedbackRes.error.message,
		);
	}

	const ownSourcedNames = (ownRes.data ?? [])
		.map((r: { product_name: string | null }) =>
			r.product_name ? normalizeName(r.product_name) : "",
		)
		.filter((s) => s.length >= OWN_NAME_PREFIX_LEN);

	const recentDiscoveredUrls = new Set(
		(recentRes.data ?? []).map(
			(r: { product_url: string }) => r.product_url,
		),
	);

	const crossSessionRakutenCodes = new Set(
		(codesRes.data ?? [])
			.map((r: { rakuten_item_code: string | null }) => r.rakuten_item_code)
			.filter((c): c is string => !!c),
	);

	const feedbackRows = (feedbackRes.data ?? []) as Array<{
		product_url: string;
		rakuten_item_code: string | null;
	}>;
	const feedbackSourcedUrls = new Set(feedbackRows.map((r) => r.product_url));
	const feedbackSourcedCodes = new Set(
		feedbackRows.map((r) => r.rakuten_item_code).filter((c): c is string => !!c),
	);

	return {
		ownSourcedNames,
		recentDiscoveredUrls,
		crossSessionRakutenCodes,
		rejectedUrls: new Set(learning.rejected_seeds.urls),
		rejectedBrands: new Set(learning.rejected_seeds.brands),
		rejectedTerms: learning.rejected_seeds.terms,
		feedbackSourcedUrls,
		feedbackSourcedCodes,
	};
}

/**
 * Apply exclusion filters to pool items. Returns kept items.
 */
export function applyExclusions(
	pool: PoolItem[],
	ctx: ExclusionContext,
): PoolItem[] {
	return pool.filter((item) => {
		const normalized = normalizeName(item.name);

		// 1. own sourcing history (fuzzy prefix)
		for (const own of ctx.ownSourcedNames) {
			if (normalized.includes(own.slice(0, OWN_NAME_PREFIX_LEN))) return false;
		}

		// 2. last 7 days
		if (ctx.recentDiscoveredUrls.has(item.productUrl)) return false;

		// 3. cross-session rakuten code
		if (
			item.rakutenItemCode &&
			ctx.crossSessionRakutenCodes.has(item.rakutenItemCode)
		)
			return false;

		// 4. user feedback sourced/duplicate (permanent exclusion)
		if (ctx.feedbackSourcedUrls.has(item.productUrl)) return false;
		if (
			item.rakutenItemCode &&
			ctx.feedbackSourcedCodes.has(item.rakutenItemCode)
		)
			return false;

		// 5. rejected seeds
		if (ctx.rejectedUrls.has(item.productUrl)) return false;
		if (item.sellerName && ctx.rejectedBrands.has(item.sellerName)) return false;
		for (const term of ctx.rejectedTerms) {
			if (term && item.name.includes(term)) return false;
		}

		return true;
	});
}

export const __test = {
	OWN_NAME_PREFIX_LEN,
	RECENT_WINDOW_DAYS,
};
