import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export async function GET(request: NextRequest) {
	const { searchParams } = new URL(request.url);
	const search = searchParams.get("search") ?? "";

	const supabase = getServiceClient();

	// Get all products that have images, with their first image as thumbnail
	const { data: imageProducts, error: imgError } = await supabase
		.from("product_images")
		.select("product_code, s3_url, sheet_name, sort_order")
		.order("sort_order", { ascending: true });

	if (imgError) {
		return NextResponse.json({ error: imgError.message }, { status: 500 });
	}

	// Group by product_code, pick first image as thumbnail
	const productMap = new Map<
		string,
		{ thumbnail: string; imageCount: number }
	>();
	for (const row of imageProducts ?? []) {
		const existing = productMap.get(row.product_code);
		if (!existing) {
			productMap.set(row.product_code, {
				thumbnail: row.s3_url,
				imageCount: 1,
			});
		} else {
			existing.imageCount++;
		}
	}

	// Get product details for names and categories
	const codes = Array.from(productMap.keys());
	if (codes.length === 0) {
		return NextResponse.json({ products: [] });
	}

	const { data: details } = await supabase
		.from("product_details")
		.select("product_code, product_name, category_txd1")
		.in("product_code", codes);

	const detailMap = new Map<
		string,
		{ name: string; category: string | null }
	>();
	for (const d of details ?? []) {
		detailMap.set(d.product_code, {
			name: d.product_name,
			category: d.category_txd1,
		});
	}

	// Build response
	let products = codes.map((code) => ({
		code,
		name: detailMap.get(code)?.name ?? code,
		category: detailMap.get(code)?.category ?? null,
		thumbnail: productMap.get(code)!.thumbnail,
		imageCount: productMap.get(code)!.imageCount,
	}));

	// Filter by search
	if (search) {
		const q = search.toLowerCase();
		products = products.filter(
			(p) =>
				p.name.toLowerCase().includes(q) ||
				p.code.toLowerCase().includes(q) ||
				(p.category && p.category.toLowerCase().includes(q)),
		);
	}

	// Sort by name
	products.sort((a, b) => a.name.localeCompare(b.name, "ja"));

	return NextResponse.json({ products });
}
