/**
 * The only place in this feature that reaches the internet.
 *
 * Everything about the product finder's stored-only guarantee rests on this
 * file being importable from exactly one direction: the supplemental run
 * service imports it, and nothing under lib/product-finder/ does. A static test
 * asserts that, because the failure mode is not an error — it is a per-request
 * bill and a label that has quietly stopped being true.
 *
 * Providers are injected. That is not ceremony: it is what lets the gap
 * routing, the caps and the classification be tested without spending a search
 * quota, and what lets the run service prove in a test that asking for one gap
 * calls exactly one provider.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import type { BraveWebResult } from "@/lib/brave";
import type { RakutenRankingResult } from "@/lib/rakuten";
import { classifyObservation, type SupplementGap, type SupplementObservation } from "./types";
import { isFetchableUrl, safeFetchSourcePage } from "./safe-fetch";

/** Per gap. A cap, not a target — most gaps return far fewer. */
export const MAX_OBSERVATIONS_PER_GAP = 10;
/** A snippet is context, not content. Anything longer is someone else's page. */
export const MAX_SNIPPET_CHARS = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;

export interface SupplementProduct {
	id: string;
	name: string;
	category: string | null;
}

export interface SupplementProviderDeps {
	braveSearch: (query: string, count?: number) => Promise<BraveWebResult[]>;
	rakutenSearch: (keyword: string, sort?: "-reviewCount" | "-reviewAverage" | "-updateTimestamp", limit?: number) => Promise<RakutenRankingResult>;
	fetchPage?: typeof safeFetchSourcePage;
	now?: () => Date;
}

/** Phrases a Japanese seller uses when claiming cumulative sales. Matching one
 *  does not make the number true — it makes it findable, so it can be stored
 *  AS A CLAIM instead of being paraphrased into a fact later. */
const SALES_CLAIM_PATTERN =
	/(累計|シリーズ累計|出荷|販売実績|突破|完売|売上No\.?1|売れ筋No\.?1)/;

function clip(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, MAX_SNIPPET_CHARS);
}

function decodeEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&apos;/g, "'")
		.replace(/&nbsp;/g, " ");
}

/** og:description, meta description, or the first paragraph. Deliberately
 *  crude: this is read for values, and a heavier parser would only widen what
 *  a hostile page can reach. */
export function extractPageFacts(html: string): { title: string; description: string } {
	const meta = (property: string): string => {
		const pattern = new RegExp(
			`<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`,
			"i",
		);
		return decodeEntities(html.match(pattern)?.[1] ?? "");
	};
	const title =
		meta("og:title") || decodeEntities(html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1] ?? "");
	const description = meta("og:description") || meta("description");
	return { title: clip(title), description: clip(description) };
}

function observation(over: SupplementObservation): SupplementObservation {
	return { ...over, sourceTitle: clip(over.sourceTitle), sourceUrl: over.sourceUrl };
}

async function researchOfficialFacts(
	product: SupplementProduct,
	deps: SupplementProviderDeps,
	observedAt: string,
): Promise<SupplementObservation[]> {
	const fetchPage = deps.fetchPage ?? safeFetchSourcePage;
	const results = (await deps.braveSearch(`${product.name} 公式 商品情報 仕様`, 5)).filter((r) =>
		isFetchableUrl(r.url),
	);

	const out: SupplementObservation[] = [];
	for (const result of results.slice(0, 3)) {
		try {
			const page = await fetchPage(result.url, { timeoutMs: REQUEST_TIMEOUT_MS });
			const facts = extractPageFacts(page.text);
			if (!facts.description) continue;
			out.push(
				observation({
					gap: "official_product_facts",
					predicate: "official_product_description",
					value: facts.description,
					// Read off the page itself, which is the only route to verified.
					evidenceClass: classifyObservation({
						sourceKind: "official",
						metric: "product_spec",
						readFromPage: true,
					}),
					sourceType: "official_site",
					sourceUrl: page.finalUrl,
					sourceTitle: facts.title || result.title,
					observedAt,
					confidence: 0.8,
				}),
			);
		} catch {
			// A page we could not safely read is not an error in the run — it is
			// one fewer observation. The gap's status reflects that on its own.
			continue;
		}
		if (out.length >= MAX_OBSERVATIONS_PER_GAP) break;
	}

	// Nothing fetchable: the snippets still say something, but only as claims.
	if (out.length === 0) {
		for (const result of results.slice(0, MAX_OBSERVATIONS_PER_GAP)) {
			if (!result.description) continue;
			out.push(
				observation({
					gap: "official_product_facts",
					predicate: "official_product_description",
					value: clip(result.description),
					evidenceClass: classifyObservation({ sourceKind: "official", metric: "product_spec" }),
					sourceType: "brave_result",
					sourceUrl: result.url,
					sourceTitle: result.title,
					observedAt,
					confidence: 0.4,
				}),
			);
		}
	}
	return out;
}

async function researchSellerClaim(
	product: SupplementProduct,
	deps: SupplementProviderDeps,
	observedAt: string,
): Promise<SupplementObservation[]> {
	const results = await deps.braveSearch(`${product.name} 累計 販売実績 突破`, 10);
	return results
		.filter((r) => isFetchableUrl(r.url) && SALES_CLAIM_PATTERN.test(`${r.title} ${r.description}`))
		.slice(0, MAX_OBSERVATIONS_PER_GAP)
		.map((r) =>
			observation({
				gap: "seller_sales_claim",
				// The predicate carries the caveat. There is no path from here to a
				// field named for a measured sale.
				predicate: "seller_claim",
				value: clip(r.description || r.title),
				evidenceClass: classifyObservation({ sourceKind: "seller", metric: "claimed_units" }),
				sourceType: "brave_result",
				sourceUrl: r.url,
				sourceTitle: r.title,
				observedAt,
				confidence: 0.3,
			}),
		);
}

async function researchMarketplace(
	product: SupplementProduct,
	gap: Extract<SupplementGap, "current_price" | "review_signal" | "ranking_signal">,
	deps: SupplementProviderDeps,
	observedAt: string,
): Promise<SupplementObservation[]> {
	const sort = gap === "review_signal" ? "-reviewCount" : "-updateTimestamp";
	const { items } = await deps.rakutenSearch(product.name, sort, MAX_OBSERVATIONS_PER_GAP);
	const out: SupplementObservation[] = [];

	for (const [index, item] of items.slice(0, MAX_OBSERVATIONS_PER_GAP).entries()) {
		if (!isFetchableUrl(item.itemUrl)) continue;
		const base = {
			gap,
			sourceType: "rakuten" as const,
			sourceUrl: item.itemUrl,
			sourceTitle: item.itemName,
			sourceLocator: item.shopName,
			observedAt,
		};

		if (gap === "current_price") {
			if (!Number.isFinite(item.itemPrice) || item.itemPrice <= 0) continue;
			out.push(
				observation({
					...base,
					predicate: "marketplace_price_jpy",
					value: item.itemPrice,
					unit: "JPY",
					evidenceClass: classifyObservation({ sourceKind: "marketplace", metric: "price" }),
					confidence: 0.7,
				}),
			);
			continue;
		}

		if (gap === "review_signal") {
			// Zero reviews is a real observation; a missing field is not. Only the
			// second is skipped.
			if (!Number.isFinite(item.reviewCount)) continue;
			out.push(
				observation({
					...base,
					predicate: "marketplace_review_count",
					value: item.reviewCount,
					unit: "件",
					evidenceClass: classifyObservation({ sourceKind: "marketplace", metric: "review_count" }),
					confidence: 0.5,
				}),
			);
			continue;
		}

		out.push(
			observation({
				...base,
				predicate: "marketplace_ranking_position",
				value: Number.isFinite(item.rank) && item.rank > 0 ? item.rank : index + 1,
				evidenceClass: classifyObservation({ sourceKind: "marketplace", metric: "ranking_position" }),
				confidence: 0.4,
			}),
		);
	}
	return out;
}

/**
 * One gap, one provider. Rakuten answers price/review/ranking; Brave only ever
 * LOCATES a page, and what makes something verified is having read that page.
 */
export async function researchGap(
	product: SupplementProduct,
	gap: SupplementGap,
	deps: SupplementProviderDeps,
): Promise<SupplementObservation[]> {
	const observedAt = (deps.now?.() ?? new Date()).toISOString();
	const results =
		gap === "official_product_facts"
			? await researchOfficialFacts(product, deps, observedAt)
			: gap === "seller_sales_claim"
				? await researchSellerClaim(product, deps, observedAt)
				: await researchMarketplace(product, gap, deps, observedAt);
	return results.slice(0, MAX_OBSERVATIONS_PER_GAP);
}
