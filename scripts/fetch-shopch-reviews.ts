import { fetchAndStoreShopchReviews } from "../lib/shopch-products/reviews";
import { getServiceClient } from "../lib/supabase";

async function main() {
	const ids = process.argv.slice(2);
	if (ids.length === 0) {
		// Default: fetch reviews for shopch_products rows missing reviews_fetched_at
		const sb = getServiceClient();
		const { data } = await sb
			.from("shopch_products")
			.select("id")
			.is("reviews_fetched_at", null)
			.limit(50);
		ids.push(...((data ?? []) as Array<{ id: string }>).map((r) => r.id));
	}
	if (ids.length === 0) {
		console.log("No products to fetch reviews for.");
		return;
	}
	console.log(`Fetching reviews for ${ids.length} Shop Channel product(s)...`);
	for (const id of ids) {
		try {
			const r = await fetchAndStoreShopchReviews(id);
			console.log(
				`  ${id}: total=${r.totalCount} avg=${r.averageRating.toFixed(2)} upserted=${r.upserted}`,
			);
		} catch (e) {
			console.log(`  ${id}: ERROR ${(e as Error).message}`);
		}
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
