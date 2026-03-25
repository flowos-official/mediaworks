/**
 * ETL Script: Extract images from matched 台帳 Excel files → S3 + DB
 *
 * Usage: npx tsx scripts/extract-product-images.ts
 *
 * Strategy:
 * 1. Get unique product names from sales_weekly
 * 2. Scan & match 台帳 files (reusing match-utils)
 * 3. Extract images from each matched Excel file (ZIP xl/media/)
 * 4. Upload to S3, upsert metadata to product_images table
 */

import * as fs from "fs";
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
import { extractImages } from "../lib/taicho-parser";
import { uploadToS3 } from "../lib/s3";
import { loadEnv, scanTaichoFiles, findBestMatch } from "./lib/match-utils";

// ---------------------------------------------------------------------------
// Env & clients
// ---------------------------------------------------------------------------

loadEnv();

const supabase = createClient(
	process.env.NEXT_PUBLIC_SUPABASE_URL!,
	process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const CONCURRENCY = 10;

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

async function pMap<T, R>(
	items: T[],
	fn: (item: T, index: number) => Promise<R>,
	concurrency: number,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let idx = 0;

	async function worker() {
		while (idx < items.length) {
			const i = idx++;
			results[i] = await fn(items[i], i);
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
	return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log("=== Product Images Extraction ===\n");

	// Step 1: Get unique products from sales_weekly
	console.log("Step 1: Fetching sales products from DB...");
	const { data: salesProducts, error } = await supabase
		.from("sales_weekly")
		.select("product_code, product_name")
		.gte("week_start", "2025-01-01")
		.limit(10000);

	if (error) {
		console.error("DB error:", error.message);
		process.exit(1);
	}

	const uniqueProducts = new Map<string, string>();
	for (const p of salesProducts ?? []) {
		if (!uniqueProducts.has(p.product_code)) {
			uniqueProducts.set(p.product_code, p.product_name);
		}
	}
	console.log(`  Found ${uniqueProducts.size} unique products\n`);

	// Step 2: Scan & match
	console.log("Step 2: Scanning 台帳 files...");
	const entries = scanTaichoFiles();
	console.log(`  Found ${entries.length} 台帳 files\n`);

	const matched: Array<{ code: string; filePath: string }> = [];
	for (const [code, salesName] of uniqueProducts) {
		const filePath = findBestMatch(salesName, entries);
		if (filePath) {
			matched.push({ code, filePath });
		}
	}
	console.log(`  Matched: ${matched.length} products\n`);

	// Step 3: Extract images and upload
	console.log("Step 3: Extracting images and uploading to S3...");
	let totalImages = 0;
	let totalUploaded = 0;
	let totalErrors = 0;
	const allImageRows: Array<Record<string, unknown>> = [];

	for (let mi = 0; mi < matched.length; mi++) {
		const { code, filePath } = matched[mi];
		process.stdout.write(
			`\r  Processing ${mi + 1}/${matched.length}: ${path.basename(filePath).slice(0, 40)}...`,
		);

		let buffer: Buffer;
		try {
			buffer = fs.readFileSync(filePath);
		} catch {
			totalErrors++;
			continue;
		}

		let images;
		try {
			images = extractImages(buffer);
		} catch {
			totalErrors++;
			continue;
		}

		if (images.length === 0) continue;
		totalImages += images.length;

		// Upload images in parallel
		const uploadResults = await pMap(
			images,
			async (img, idx) => {
				const s3Key = `${code}/${img.sheetName ?? "unknown"}/${img.fileName}`;
				try {
					const s3Url = await uploadToS3(s3Key, img.data, img.mimeType);
					totalUploaded++;
					return {
						product_code: code,
						sheet_name: img.sheetName,
						image_key: s3Key,
						s3_url: s3Url,
						mime_type: img.mimeType,
						size_bytes: img.data.length,
						sort_order: idx,
					};
				} catch (err) {
					totalErrors++;
					console.error(`\n  S3 upload error for ${s3Key}:`, (err as Error).message);
					return null;
				}
			},
			CONCURRENCY,
		);

		for (const row of uploadResults) {
			if (row) allImageRows.push(row);
		}
	}

	console.log(`\n\n  Total images found: ${totalImages}`);
	console.log(`  Successfully uploaded: ${totalUploaded}`);
	console.log(`  Errors: ${totalErrors}`);

	// Step 4: Upsert to DB
	if (allImageRows.length > 0) {
		console.log(`\nStep 4: Upserting ${allImageRows.length} image records to DB...`);
		const BATCH = 100;
		let dbErrors = 0;
		for (let i = 0; i < allImageRows.length; i += BATCH) {
			const batch = allImageRows.slice(i, i + BATCH);
			const { error: upsertError } = await supabase
				.from("product_images")
				.upsert(batch, { onConflict: "image_key" });

			if (upsertError) {
				console.error(`  DB batch error:`, upsertError.message);
				dbErrors++;
			} else {
				process.stdout.write(
					`\r  ${Math.min(i + BATCH, allImageRows.length)}/${allImageRows.length}`,
				);
			}
		}
		console.log(`\n  Done. DB errors: ${dbErrors}`);
	}

	// Summary
	console.log(`\n=== Summary ===`);
	console.log(`Products matched: ${matched.length}`);
	console.log(`Images extracted: ${totalImages}`);
	console.log(`Images uploaded to S3: ${totalUploaded}`);
	console.log(`Image records in DB: ${allImageRows.length}`);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
