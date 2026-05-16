/**
 * QVC review API client.
 *   GET https://qvc.jp/api/sales/presentation/v1/jp/products/{id}/reviews?size=50&number=N
 *
 * Response shape (observed 2026-05-16):
 *   {
 *     averageRating, reviewCount, ratingCount,
 *     totalElements, size, number, totalPages,
 *     numberOfElements, first, last,
 *     reviews?: [{ id, title, comment, rating, recommended, status,
 *                  variantAxis, date, skn, nickName, profilePicture, gender }]
 *   }
 *
 * The endpoint is JSON-only — no JS rendering, no auth required.
 */
import { getServiceClient } from "@/lib/supabase";

const API_BASE = "https://qvc.jp/api/sales/presentation/v1/jp/products";
const PAGE_SIZE = 50;
const MAX_PAGES = 10; // safety cap, ~500 reviews per product

interface ReviewItem {
	id: string;
	title?: string;
	comment?: string;
	rating?: number;
	recommended?: boolean;
	status?: string;
	variantAxis?: Array<Record<string, unknown>>;
	date?: string; // ISO
	skn?: string;
	nickName?: string;
	profilePicture?: string;
	gender?: string;
}

interface ReviewApiResponse {
	averageRating: number;
	reviewCount: number;
	ratingCount: number;
	reviews?: ReviewItem[];
	totalElements: number;
	size: number;
	number: number;
	totalPages: number;
	numberOfElements: number;
	first: boolean;
	last: boolean;
}

export interface QvcReviewsResult {
	productId: string;
	averageRating: number;
	reviewCount: number;
	upserted: number;
}

async function fetchPage(productId: string, page: number): Promise<ReviewApiResponse | null> {
	const url = `${API_BASE}/${productId}/reviews?size=${PAGE_SIZE}&number=${page}`;
	const res = await fetch(url, {
		headers: {
			// qvc.jp sits behind Akamai bot-detection; custom UAs get served an
			// HTML error page even though the upstream API would return JSON.
			// Mozilla UA passes the filter.
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Accept: "application/json",
			"Accept-Language": "ja,en;q=0.8",
		},
	});
	if (!res.ok) return null;
	const ct = res.headers.get("content-type") ?? "";
	if (!ct.includes("application/json")) return null; // bot-detected HTML page
	try {
		return (await res.json()) as ReviewApiResponse;
	} catch {
		return null;
	}
}

/**
 * Fetch all reviews for one QVC product and upsert into product_reviews. Also
 * updates qvc_products.review_count/review_avg/reviews_fetched_at.
 */
export async function fetchAndStoreQvcReviews(productId: string): Promise<QvcReviewsResult> {
	const sb = getServiceClient();

	const first = await fetchPage(productId, 1);
	if (!first) {
		return { productId, averageRating: 0, reviewCount: 0, upserted: 0 };
	}

	const allReviews: ReviewItem[] = [...(first.reviews ?? [])];
	const totalPages = Math.min(first.totalPages ?? 1, MAX_PAGES);
	for (let p = 2; p <= totalPages; p++) {
		const next = await fetchPage(productId, p);
		if (!next?.reviews) break;
		allReviews.push(...next.reviews);
	}

	// Upsert into product_reviews
	let upserted = 0;
	if (allReviews.length > 0) {
		const rows = allReviews
			.filter((r) => typeof r.id === "string")
			.map((r) => ({
				channel: "qvc",
				product_id: productId,
				external_id: r.id,
				rating: typeof r.rating === "number" ? r.rating : null,
				title: r.title ?? null,
				comment: r.comment ?? null,
				recommended: typeof r.recommended === "boolean" ? r.recommended : null,
				status: r.status ?? null,
				reviewer_nickname: r.nickName ?? null,
				reviewer_profile_pic: r.profilePicture ?? null,
				reviewer_gender: r.gender ?? null,
				variant_info: r.variantAxis ?? null,
				review_date: r.date ?? null,
				raw: r,
				fetched_at: new Date().toISOString(),
			}));

		// Dedup within batch — same review id can appear if pagination overlaps
		const seen = new Map<string, (typeof rows)[number]>();
		for (const row of rows) seen.set(row.external_id, row);
		const unique = Array.from(seen.values());

		const { error, count } = await sb
			.from("product_reviews")
			.upsert(unique, {
				onConflict: "channel,product_id,external_id",
				count: "exact",
			});
		if (!error && count != null) upserted = count;
	}

	// Update aggregate on qvc_products
	await sb
		.from("qvc_products")
		.update({
			review_count: first.reviewCount,
			review_avg: first.reviewCount > 0 ? first.averageRating : null,
			reviews_fetched_at: new Date().toISOString(),
		})
		.eq("id", productId);

	return {
		productId,
		averageRating: first.averageRating,
		reviewCount: first.reviewCount,
		upserted,
	};
}
