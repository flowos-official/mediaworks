/**
 * Shop Channel review parser.
 *
 *   URL: https://www.shopch.jp/pc/product/review/list?reqPrNo={id}&page={N}
 *   No JSON API — reviews are server-rendered HTML, ~20/page.
 *
 * DOM:
 *   .mod-pager .pages           "1件〜20件 (全25件)"  → totalCount
 *   .itemKuchikomiComments      one per review, id="kuchikomi{externalId}"
 *     .count                    rating "4.0"
 *     .ttl                      review title (often empty)
 *     .user                     "（{nick} さん | 購入日：YYYY/MM/DD| 公開日：YYYY/MM/DD）"
 *     .txt                      review body
 *     .vote_comment             "5 人が「参考になった」と言っています" → helpful count
 */
import * as cheerio from "cheerio";
import { politeFetch, sleep } from "@/lib/broadcasts/fetch";
import { getServiceClient } from "@/lib/supabase";

const BASE = "https://www.shopch.jp";

export interface ShopchReview {
	external_id: string;
	rating: number | null;
	title: string | null;
	comment: string | null;
	reviewer_nickname: string | null;
	purchase_date: string | null; // YYYY-MM-DD
	publish_date: string | null;
	helpful_count: number | null;
}

export interface ShopchReviewParse {
	totalCount: number;
	reviews: ShopchReview[];
}

const TOTAL_RE = /[0-9]+件〜[0-9]+件\s*\(全([0-9]+)件\)/;
const USER_RE = /([^\s（）]+)\s*さん\s*\|\s*購入日：([0-9]{4}\/[0-9]{2}\/[0-9]{2})\|\s*公開日：([0-9]{4}\/[0-9]{2}\/[0-9]{2})/;
const HELPFUL_RE = /([0-9]+)\s*人が/;

function isoDate(jp: string): string | null {
	// "2026/04/06" → "2026-04-06"
	const m = jp.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
	return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function parseShopchReviewsHtml(html: string): ShopchReviewParse {
	const $ = cheerio.load(html);
	const pagesText = $(".mod-pager .pages").first().text();
	const totalMatch = pagesText.match(TOTAL_RE);
	const totalCount = totalMatch ? Number(totalMatch[1]) : 0;

	const reviews: ShopchReview[] = [];
	$(".itemKuchikomiComments").each((_, el) => {
		const $el = $(el);
		const id = ($el.attr("id") ?? "").replace(/^kuchikomi/, "").trim();
		if (!id) return;

		const ratingText = $el.find(".count").first().text().trim();
		const rating = ratingText ? Number(ratingText) : null;
		const title = $el.find(".ttl").first().text().trim() || null;
		const userText = $el.find(".user").first().text().replace(/\s+/g, " ").trim();
		const um = userText.match(USER_RE);
		const helpfulText = $el.find(".vote_comment").first().text().trim();
		const hm = helpfulText.match(HELPFUL_RE);

		reviews.push({
			external_id: id,
			rating: rating != null && Number.isFinite(rating) ? rating : null,
			title,
			comment: $el.find(".txt").first().text().trim() || null,
			reviewer_nickname: um ? um[1] : null,
			purchase_date: um ? isoDate(um[2]) : null,
			publish_date: um ? isoDate(um[3]) : null,
			helpful_count: hm ? Number(hm[1]) : null,
		});
	});

	return { totalCount, reviews };
}

async function fetchPage(reqPrNo: string, page: number): Promise<ShopchReviewParse | null> {
	const url = `${BASE}/pc/product/review/list?reqPrNo=${reqPrNo}&page=${page}`;
	const fetched = await politeFetch(url, { timeoutMs: 15_000 });
	if (!fetched.ok || !fetched.body) return null;
	return parseShopchReviewsHtml(fetched.body);
}

export interface ShopchReviewsResult {
	productId: string;
	totalCount: number;
	averageRating: number;
	upserted: number;
}

const MAX_PAGES = 10; // ~200 reviews safety cap

/**
 * Fetch all Shop Channel reviews for one product (paginating until exhausted)
 * and upsert into product_reviews + update shopch_products aggregates.
 */
export async function fetchAndStoreShopchReviews(reqPrNo: string): Promise<ShopchReviewsResult> {
	const sb = getServiceClient();

	const first = await fetchPage(reqPrNo, 1);
	if (!first) {
		return { productId: reqPrNo, totalCount: 0, averageRating: 0, upserted: 0 };
	}

	const all: ShopchReview[] = [...first.reviews];
	const totalCount = first.totalCount;
	const totalPages = Math.min(Math.ceil(totalCount / 20) || 1, MAX_PAGES);
	for (let p = 2; p <= totalPages; p++) {
		await sleep(400);
		const next = await fetchPage(reqPrNo, p);
		if (!next?.reviews.length) break;
		all.push(...next.reviews);
	}

	// Dedup by external_id (paginated lists can overlap)
	const seen = new Map<string, ShopchReview>();
	for (const r of all) seen.set(r.external_id, r);
	const unique = Array.from(seen.values());

	let upserted = 0;
	if (unique.length > 0) {
		const rows = unique.map((r) => ({
			channel: "shopch",
			product_id: reqPrNo,
			external_id: r.external_id,
			rating: r.rating,
			title: r.title,
			comment: r.comment,
			recommended: null,
			status: null,
			reviewer_nickname: r.reviewer_nickname,
			reviewer_profile_pic: null,
			reviewer_gender: null,
			variant_info: null,
			review_date: r.publish_date, // we use publish date as "review_date"
			raw: r,
			fetched_at: new Date().toISOString(),
		}));
		const { error, count } = await sb.from("product_reviews").upsert(rows, {
			onConflict: "channel,product_id,external_id",
			count: "exact",
		});
		if (!error && count != null) upserted = count;
	}

	const averageRating =
		unique.length > 0
			? unique.reduce((s, r) => s + (r.rating ?? 0), 0) / unique.filter((r) => r.rating != null).length
			: 0;

	await sb
		.from("shopch_products")
		.update({
			review_count: totalCount,
			review_avg: unique.length > 0 ? Number(averageRating.toFixed(2)) : null,
			reviews_fetched_at: new Date().toISOString(),
		})
		.eq("id", reqPrNo);

	return { productId: reqPrNo, totalCount, averageRating, upserted };
}
