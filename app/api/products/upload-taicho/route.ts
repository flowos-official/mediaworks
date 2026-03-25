import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { parseTaichoBuffer, extractImages } from "@/lib/taicho-parser";
import { uploadToS3 } from "@/lib/s3";

export async function POST(request: NextRequest) {
	const formData = await request.formData();
	const file = formData.get("file") as File | null;
	const productCode = formData.get("product_code") as string | null;

	if (!file || !productCode) {
		return NextResponse.json(
			{ error: "file and product_code are required" },
			{ status: 400 },
		);
	}

	if (
		!file.name.endsWith(".xlsx") &&
		!file.name.endsWith(".xlsm")
	) {
		return NextResponse.json(
			{ error: "Only .xlsx and .xlsm files are supported" },
			{ status: 400 },
		);
	}

	const supabase = getServiceClient();
	const buffer = Buffer.from(await file.arrayBuffer());

	// 1. Parse text data
	const parsed = parseTaichoBuffer(buffer, productCode, file.name);
	let detailsSaved = false;
	if (parsed) {
		const { error } = await supabase
			.from("product_details")
			.upsert(parsed, { onConflict: "product_code" });
		if (!error) detailsSaved = true;
	}

	// 2. Extract and upload images
	let imagesUploaded = 0;
	const images = extractImages(buffer);
	const imageRows: Array<Record<string, unknown>> = [];

	for (let i = 0; i < images.length; i++) {
		const img = images[i];
		const s3Key = `${productCode}/${img.sheetName ?? "unknown"}/${img.fileName}`;
		try {
			const s3Url = await uploadToS3(s3Key, img.data, img.mimeType);
			imagesUploaded++;
			imageRows.push({
				product_code: productCode,
				sheet_name: img.sheetName,
				image_key: s3Key,
				s3_url: s3Url,
				mime_type: img.mimeType,
				size_bytes: img.data.length,
				sort_order: i,
			});
		} catch {
			// Skip failed uploads
		}
	}

	if (imageRows.length > 0) {
		// Delete existing images for this product first
		await supabase
			.from("product_images")
			.delete()
			.eq("product_code", productCode);

		await supabase
			.from("product_images")
			.insert(imageRows);
	}

	return NextResponse.json({
		product_code: productCode,
		detailsSaved,
		imagesUploaded,
		totalImagesFound: images.length,
	});
}
