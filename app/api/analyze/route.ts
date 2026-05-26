import { hasInternalSecret, requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { extractProductInfo } from "@/lib/gemini";
import { GeminiCallError } from "@/lib/gemini/errors";

export const maxDuration = 120; // Extract only — fast, but buffer for large files

export async function POST(request: NextRequest) {
	const isInternal = hasInternalSecret(request);
	if (!isInternal) {
		const auth = await requireUser(["member", "admin"]);
		if ("error" in auth) return auth.error;
	}

	type AnalyzeFile = { base64: string; mimeType: string; fileName: string };
	const body = await request.json() as {
		productId: string;
		files?: AnalyzeFile[];
		fileBase64?: string;
		mimeType?: string;
		fileName?: string;
	};
	const { productId } = body;

	const supabase = getServiceClient();

	// Normalize body shape: prefer `files[]`, fall back to legacy single-file fields.
	let files: AnalyzeFile[];
	if (Array.isArray(body.files) && body.files.length > 0) {
		files = body.files;
	} else if (body.fileBase64 && body.mimeType && body.fileName) {
		files = [{ base64: body.fileBase64, mimeType: body.mimeType, fileName: body.fileName }];
	} else {
		await supabase
			.from("products")
			.update({ status: "failed", error_reason: "no_files" })
			.eq("id", productId);
		return NextResponse.json({ error: "no files supplied" }, { status: 400 });
	}

	// Size guards. Gemini inlineData hard cap is 25MB; we cap at 20MB total / 15MB per file.
	const MAX_SINGLE_FILE_MB = 15;
	const MAX_TOTAL_PAYLOAD_MB = 20;
	const sizeOf = (b64: string): number => Math.ceil(b64.length * 0.75); // approx decoded bytes
	for (const f of files) {
		if (sizeOf(f.base64) > MAX_SINGLE_FILE_MB * 1024 * 1024) {
			await supabase
				.from("products")
				.update({ status: "failed", error_reason: "file_too_large" })
				.eq("id", productId);
			return NextResponse.json({ error: `file '${f.fileName}' exceeds ${MAX_SINGLE_FILE_MB}MB` }, { status: 400 });
		}
	}
	const totalBytes = files.reduce((s, f) => s + sizeOf(f.base64), 0);
	if (totalBytes > MAX_TOTAL_PAYLOAD_MB * 1024 * 1024) {
		// Drop smallest files until under cap. Keep primary (files[0]) prioritised.
		const sorted = [...files].sort((a, b) => sizeOf(b.base64) - sizeOf(a.base64));
		const kept: AnalyzeFile[] = [];
		let sum = 0;
		for (const f of sorted) {
			if (sum + sizeOf(f.base64) > MAX_TOTAL_PAYLOAD_MB * 1024 * 1024) continue;
			kept.push(f);
			sum += sizeOf(f.base64);
		}
		files = kept;
		console.warn(`[${productId}] truncated to ${files.length} files (total ~${(sum / 1e6).toFixed(1)}MB)`);
	}

	try {
		// Update status to analyzing
		await supabase
			.from("products")
			.update({ status: "analyzing" })
			.eq("id", productId);

		// Step 1: Extract product info with Gemini (fast — typically <30s)
		console.log(`[${productId}] Extracting product info from ${files.length} file(s)...`);
		const productInfo = await extractProductInfo(files);

		// Update product name, description, and metadata — keep status: analyzing
		await supabase
			.from("products")
			.update({
				name: productInfo.name,
				description: productInfo.description,
				category: productInfo.category,
				features: productInfo.features,
				price_range: productInfo.price_range,
				target_market: productInfo.target_market,
				status: "analyzing",
			})
			.eq("id", productId);

		// Step 2: Trigger synthesize in a separate request (non-blocking)
		// This runs as a separate serverless function with its own 5-min timeout
		const cronSecret = process.env.CRON_SECRET;
		if (!cronSecret) {
			console.error(`[${productId}] CRON_SECRET missing — synthesize trigger blocked`);
			await supabase
				.from("products")
				.update({ status: "failed", error_reason: "cron_secret_missing" })
				.eq("id", productId);
			return NextResponse.json(
				{ error: "CRON_SECRET not configured" },
				{ status: 500 },
			);
		}
		const baseUrl =
			process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
		fetch(`${baseUrl}/api/analyze/synthesize`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${cronSecret}`,
			},
			body: JSON.stringify({ productId }),
		}).catch((err) => {
			console.error(`[${productId}] Failed to trigger synthesize:`, err);
		});

		console.log(`[${productId}] Extraction done, synthesis triggered async`);
		return NextResponse.json({
			success: true,
			productInfo,
			message: "Extraction complete. Synthesis running in background.",
		});
	} catch (error) {
		console.error(`[${productId}] Extraction failed:`, error);

		let reason: string;
		if (error instanceof GeminiCallError) {
			reason = error.message.slice(0, 500);
		} else if (error instanceof Error) {
			reason = `extract_failed: ${error.message.slice(0, 500)}`;
		} else {
			reason = "extract_failed: unknown";
		}
		await supabase
			.from("products")
			.update({ status: "failed", error_reason: reason })
			.eq("id", productId);

		return NextResponse.json(
			{ error: "Analysis failed" },
			{ status: 500 },
		);
	}
}
