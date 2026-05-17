import { createClient } from "@supabase/supabase-js";

const sb = createClient(
	process.env.NEXT_PUBLIC_SUPABASE_URL!,
	process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

(async () => {
	const { data, error } = await sb
		.from("discovered_products")
		.select(
			"id,name,product_url,thumbnail_url,price_jpy,category,tv_channel_source,source",
		)
		.not("tv_channel_source", "is", null)
		.order("created_at", { ascending: false })
		.limit(30);
	if (error) {
		console.error(error);
		return;
	}
	const total = data?.length ?? 0;
	const withImg = data?.filter((r) => (r as { thumbnail_url: string | null }).thumbnail_url).length ?? 0;
	const withPrice = data?.filter((r) => (r as { price_jpy: number | null }).price_jpy != null).length ?? 0;
	const withCategory = data?.filter((r) => (r as { category: string | null }).category).length ?? 0;
	console.log(`total: ${total}  thumb: ${withImg}  price: ${withPrice}  category: ${withCategory}`);
	console.log("\nfirst 5 rows:");
	for (const r of (data ?? []).slice(0, 5)) {
		const row = r as {
			name: string;
			product_url: string;
			thumbnail_url: string | null;
			price_jpy: number | null;
			category: string | null;
			tv_channel_source: string;
			source: string;
		};
		console.log({
			name: row.name.slice(0, 50),
			tv: row.tv_channel_source,
			source: row.source,
			thumb: row.thumbnail_url ? row.thumbnail_url.slice(0, 60) : null,
			price: row.price_jpy,
			category: row.category,
			url: row.product_url.slice(0, 70),
		});
	}
})();
