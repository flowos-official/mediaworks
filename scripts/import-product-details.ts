/**
 * ETL Script: Match sales products to 台帳 files and extract detailed specs
 *
 * Usage: npx tsx scripts/import-product-details.ts
 *
 * Strategy:
 * 1. Get unique product names from sales_weekly (161 products)
 * 2. Scan 台帳 files in 03_GIGAPODアップ済_台帳 (~7,900 files)
 * 3. Fuzzy-match product names → open matched files → parse 5 sheets
 * 4. Upsert into product_details table
 */

import * as fs from "fs";
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
import { parseTaichoBuffer } from "../lib/taicho-parser";
import {
	loadEnv,
	scanTaichoFiles,
	findBestMatch,
} from "./lib/match-utils";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

loadEnv();

const supabase = createClient(
	process.env.NEXT_PUBLIC_SUPABASE_URL!,
	process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log("=== Product Details Import ===\n");

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

	// Step 2: Scan 台帳 files
	console.log("Step 2: Scanning 台帳 files...");
	const entries = scanTaichoFiles();
	console.log(`  Found ${entries.length} 台帳 files\n`);

	// Step 3: Match and parse
	console.log("Step 3: Matching and parsing...");
	const results: Array<Record<string, unknown>> = [];
	const unmatched: string[] = [];
	let matchCount = 0;

	for (const [code, salesName] of uniqueProducts) {
		const bestMatch = findBestMatch(salesName, entries);

		if (bestMatch) {
			matchCount++;
			process.stdout.write(`\r  Matched: ${matchCount}/${uniqueProducts.size}`);
			const buffer = fs.readFileSync(bestMatch);
			const parsed = parseTaichoBuffer(buffer, code, path.basename(bestMatch));
			if (parsed) {
				results.push(parsed);
			}
		} else {
			unmatched.push(`${code}: ${salesName}`);
		}
	}
	console.log(`\n  Successfully parsed: ${results.length} products`);

	// Step 4: Upsert
	if (results.length > 0) {
		console.log("\nStep 4: Upserting to product_details...");
		let errorCount = 0;
		const BATCH = 50;
		for (let i = 0; i < results.length; i += BATCH) {
			const batch = results.slice(i, i + BATCH);
			const { error: upsertError } = await supabase
				.from("product_details")
				.upsert(batch, { onConflict: "product_code" });

			if (upsertError) {
				console.error(`  Batch error:`, upsertError.message);
				errorCount++;
			} else {
				process.stdout.write(`\r  ${Math.min(i + BATCH, results.length)}/${results.length}`);
			}
		}
		console.log("\n  Done.");

		if (errorCount > 0) {
			console.error(`\n${errorCount} batch errors occurred.`);
			process.exit(1);
		}
	}

	// Report
	console.log(`\n=== Summary ===`);
	console.log(`Total sales products: ${uniqueProducts.size}`);
	console.log(`Matched & parsed: ${results.length}`);
	console.log(`Unmatched: ${unmatched.length}`);

	if (unmatched.length > 0) {
		console.log(`\nUnmatched products:`);
		for (const u of unmatched) {
			console.log(`  - ${u}`);
		}
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
