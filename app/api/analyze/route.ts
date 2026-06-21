import { hasInternalSecret, requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse, after } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { extractProductInfo } from "@/lib/gemini";
import { GeminiCallError } from "@/lib/gemini/errors";

export const maxDuration = 120; // Extract only — fast, but buffer for large files

export async function POST(request: NextRequest) {
	const isInternal = hasInternalSecret(request);
	let authUserId: string | null = null;
	let authRole: "member" | "admin" | null = null;
	if (!isInternal) {
		const auth = await requireUser(["member", "admin"]);
		if ("error" in auth) return auth.error;
		authUserId = auth.user.id;
		authRole = auth.role as "member" | "admin";
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

	// Phase 4 IDOR check — only when called via user-auth (internal-secret path bypasses).
	if (!isInternal) {
		const { data: prod, error: prodErr } = await supabase
			.from("products")
			.select("id, created_by")
			.eq("id", productId)
			.maybeSingle();
		if (prodErr) {
			console.error(`[${productId}] ownership lookup failed:`, prodErr);
			return NextResponse.json({ error: "product lookup failed" }, { status: 500 });
		}
		if (!prod) {
			return NextResponse.json({ error: "product not found" }, { status: 404 });
		}
		const isOwner = (prod as { created_by: string | null }).created_by === authUserId;
		const isAdmin = authRole === "admin";
		if (!isOwner && !isAdmin) {
			console.warn(`[${productId}] analyze IDOR blocked: user=${authUserId} owner=${(prod as { created_by: string | null }).created_by}`);
			return NextResponse.json({ error: "forbidden" }, { status: 403 });
		}
	}

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
		// Greedily keep the largest files that fit under the cap (sorted by size,
		// descending). This is keyed on size, not position — files[0] is not
		// guaranteed to survive. Only reachable via the internal/legacy path; the
		// upload route already caps total payload at 20MB before calling here.
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
		const baseUrl = process.env.INTERNAL_APP_URL || request.nextUrl.origin;
		// Dispatch synthesize inside after() so the trigger is guaranteed to fire after
		// the response returns; a bare fire-and-forget fetch can be dropped when the
		// function suspends. Mirrors app/api/discovery/enrich/[productId]/route.ts.
		after(() =>
			fetch(`${baseUrl}/api/analyze/synthesize`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${cronSecret}`,
				},
				body: JSON.stringify({ productId }),
			}).catch((err) => {
				console.error(`[${productId}] Failed to trigger synthesize:`, err);
				void supabase
					.from("products")
					.update({ status: "failed", error_reason: "synthesize_trigger_failed" })
					.eq("id", productId);
			}),
		);

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
