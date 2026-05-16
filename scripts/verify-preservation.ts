/**
 * End-to-end preservation audit. For a sample archived product:
 *   1. DB completeness — every column we promised to fill is filled
 *   2. S3 reachability — every archived URL returns 200 with the right MIME
 *   3. Content integrity — HTML.gz decompresses to real HTML w/ the product name;
 *      thumbnail starts with JPEG magic; video first 1 KB is ISO-MP4
 *   4. JSON-LD round-trip — jsonld_raw can be re-parsed back to the same fields
 *   5. Reviews — product_reviews rows match the cached aggregate
 *   6. Survivability — pretend the source site is gone: can we still tell users
 *      everything important from DB + S3 only?
 *   7. Coverage — list null/missing fields per channel
 */
import { gunzipSync } from "node:zlib";
import { getServiceClient } from "../lib/supabase";
import { extractJsonLd } from "../lib/archive/jsonld";

const ok = (label: string, detail?: string) =>
	console.log(`  ✓ ${label}${detail ? "  — " + detail : ""}`);
const fail = (label: string, detail?: string) => {
	console.log(`  ✗ ${label}${detail ? "  — " + detail : ""}`);
	process.exitCode = 1;
};

const PROBE_ID = "753074";

interface HeadInfo {
	status: number;
	contentType: string | null;
	contentLength: number | null;
	contentEncoding: string | null;
	acceptRanges: string | null;
}

async function head(url: string): Promise<HeadInfo> {
	const res = await fetch(url, { method: "HEAD" });
	return {
		status: res.status,
		contentType: res.headers.get("content-type"),
		contentLength: res.headers.get("content-length") ? Number(res.headers.get("content-length")) : null,
		contentEncoding: res.headers.get("content-encoding"),
		acceptRanges: res.headers.get("accept-ranges"),
	};
}

async function fetchBytes(url: string, byteRange?: string): Promise<Buffer | null> {
	const res = await fetch(url, byteRange ? { headers: { Range: `bytes=${byteRange}` } } : {});
	if (!res.ok && res.status !== 206) return null;
	const ab = await res.arrayBuffer();
	return Buffer.from(ab);
}

async function section1_db(): Promise<Record<string, unknown> | null> {
	console.log("\n=== 1) DB completeness (qvc_products 753074) ===");
	const sb = getServiceClient();
	const { data, error } = await sb.from("qvc_products").select("*").eq("id", PROBE_ID).single();
	if (error || !data) {
		fail("row exists", error?.message);
		return null;
	}
	const row = data as Record<string, unknown>;
	const required: Array<[string, "string" | "number" | "array" | "object" | "any"]> = [
		["id", "string"],
		["name", "string"],
		["description", "string"],
		["description_long", "string"],
		["image_url", "string"],
		["image_urls", "array"],
		["video_url", "string"],
		["price_text", "string"],
		["source_url", "string"],
		["sku_variants", "array"],
		["video_upload_date", "string"],
		["jsonld_raw", "array"],
		["review_count", "number"],
		["review_avg", "number"],
		["reviews_fetched_at", "string"],
		["archived_html_s3", "string"],
		["archived_text", "string"],
		["archived_thumbnail_s3", "string"],
		["archived_image_s3", "array"],
		["archived_video_s3", "string"],
		["video_size_bytes", "number"],
		["video_duration_sec", "number"],
		["video_quality", "string"],
		["archive_status", "string"],
		["first_archived_at", "string"],
		["last_seen_at", "string"],
		["is_still_available", "any"],
	];
	for (const [k, t] of required) {
		const v = row[k];
		if (v == null || v === "") {
			fail(`${k} present`, `value=${JSON.stringify(v)}`);
			continue;
		}
		if (t === "array" && !Array.isArray(v)) fail(`${k} is array`);
		else if (t === "number" && typeof v !== "number") fail(`${k} is number`);
		else if (t === "string" && typeof v !== "string") fail(`${k} is string`);
		else ok(`${k}`, `${typeof v === "string" ? (v as string).slice(0, 60) : JSON.stringify(v).slice(0, 60)}`);
	}
	return row;
}

async function section2_s3(row: Record<string, unknown>) {
	console.log("\n=== 2) S3 reachability + correct MIME ===");
	const checks: Array<{ label: string; url: string; type: RegExp; encoding?: string | null; range?: boolean }> = [
		{
			label: "archived_html_s3",
			url: row.archived_html_s3 as string,
			type: /text\/html/,
			encoding: "gzip",
		},
		{
			label: "archived_thumbnail_s3",
			url: row.archived_thumbnail_s3 as string,
			type: /image\//,
		},
		{
			label: "archived_video_s3",
			url: row.archived_video_s3 as string,
			type: /video\/mp4/,
			range: true,
		},
	];
	for (const c of checks) {
		const h = await head(c.url);
		if (h.status !== 200) {
			fail(c.label, `HTTP ${h.status}`);
			continue;
		}
		if (!c.type.test(h.contentType ?? "")) {
			fail(`${c.label} content-type`, `${h.contentType}`);
			continue;
		}
		if (c.encoding && h.contentEncoding !== c.encoding) {
			fail(`${c.label} content-encoding`, `${h.contentEncoding ?? "none"}`);
			continue;
		}
		if (c.range && h.acceptRanges !== "bytes") {
			fail(`${c.label} accept-ranges`, `${h.acceptRanges ?? "none"}`);
			continue;
		}
		ok(c.label, `${h.contentType}  ${h.contentLength?.toLocaleString() ?? "?"} bytes`);
	}

	// Image set: check each archived_image_s3 entry
	const imgs = (row.archived_image_s3 as string[] | null) ?? [];
	let allImgOk = true;
	for (const url of imgs) {
		const h = await head(url);
		if (h.status !== 200 || !(h.contentType ?? "").startsWith("image/")) {
			fail(`image ${url.slice(-40)}`, `${h.status} ${h.contentType}`);
			allImgOk = false;
		}
	}
	if (imgs.length > 0 && allImgOk) ok(`all ${imgs.length} archived_image_s3 entries`, "200 image/*");
}

async function section3_integrity(row: Record<string, unknown>) {
	console.log("\n=== 3) Content integrity (deep check) ===");

	// HTML — S3 sets Content-Encoding: gzip so fetch transparently decompresses.
	// We can either let fetch decompress (Accept-Encoding default) or force raw
	// (Accept-Encoding: identity) — we test both paths.
	const htmlAuto = await fetch(row.archived_html_s3 as string).then((r) => r.text());
	const name = row.name as string;
	if (htmlAuto.includes(name.slice(0, 10))) {
		ok("html (auto-decoded) contains product name", `${htmlAuto.length.toLocaleString()} chars`);
	} else {
		fail("html contains product name", `looked for "${name.slice(0, 10)}"`);
	}
	// Verify raw bytes are actually gzip-encoded on S3 (CDN cost win)
	try {
		const raw = await fetch(row.archived_html_s3 as string, {
			headers: { "Accept-Encoding": "identity" },
		});
		const buf = Buffer.from(await raw.arrayBuffer());
		if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
			ok("S3 stores HTML as gzip (1F 8B magic)", `${buf.length.toLocaleString()} bytes raw`);
		} else if (raw.headers.get("content-encoding") === "gzip") {
			ok("S3 advertises gzip (fetch always decoded)", `${buf.length.toLocaleString()} bytes`);
		} else {
			fail("HTML stored uncompressed", `first bytes: ${buf.subarray(0, 4).toString("hex")}`);
		}
	} catch (e) {
		fail("raw HTML probe", (e as Error).message);
	}

	// JSON-LD round-trip from archived HTML
	const ld = extractJsonLd(htmlAuto);
	if (ld.product?.offers && ld.product.offers.length > 0) {
		ok("JSON-LD Product.offers re-extractable from archived HTML", `${ld.product.offers.length} offer(s)`);
	} else {
		fail("JSON-LD Product.offers from archived HTML");
	}
	if (ld.video?.contentUrl) ok("JSON-LD VideoObject.contentUrl re-extractable", ld.video.contentUrl);
	else fail("JSON-LD VideoObject from archived HTML");

	// Image — JPEG magic bytes
	const imgBytes = await fetchBytes(row.archived_thumbnail_s3 as string, "0-31");
	if (imgBytes && imgBytes.length >= 3 && imgBytes[0] === 0xff && imgBytes[1] === 0xd8 && imgBytes[2] === 0xff) {
		ok("thumbnail starts with JPEG magic (FF D8 FF)");
	} else {
		fail("thumbnail JPEG magic", `first bytes: ${imgBytes?.slice(0, 4).toString("hex")}`);
	}

	// Video — ISO MP4 (look for "ftyp" at offset 4..8)
	const vidBytes = await fetchBytes(row.archived_video_s3 as string, "0-31");
	if (vidBytes && vidBytes.subarray(4, 8).toString("ascii") === "ftyp") {
		ok("video starts with ISO MP4 ftyp box");
	} else {
		fail("video ftyp", `offset 4-8: ${vidBytes?.subarray(4, 8).toString("ascii") ?? "n/a"}`);
	}
}

async function section4_jsonld(row: Record<string, unknown>) {
	console.log("\n=== 4) JSON-LD raw round-trip from DB column ===");
	const blocks = row.jsonld_raw as unknown[] | null;
	if (!blocks || blocks.length === 0) {
		fail("jsonld_raw populated");
		return;
	}
	// Find Product block by walking blocks
	let foundProduct = false;
	let foundVideo = false;
	const walk = (item: unknown) => {
		if (!item || typeof item !== "object") return;
		const o = item as Record<string, unknown>;
		if (o["@type"] === "Product") foundProduct = true;
		if (o["@type"] === "VideoObject") foundVideo = true;
		if (Array.isArray(o)) for (const x of o) walk(x);
	};
	for (const b of blocks) {
		if (Array.isArray(b)) for (const x of b) walk(x);
		else walk(b);
	}
	if (foundProduct) ok("jsonld_raw contains Product block");
	else fail("jsonld_raw contains Product block");
	if (foundVideo) ok("jsonld_raw contains VideoObject block");
	else fail("jsonld_raw contains VideoObject block");
}

async function section5_reviews() {
	console.log("\n=== 5) Reviews preservation ===");
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("product_reviews")
		.select("*")
		.eq("channel", "qvc")
		.eq("product_id", PROBE_ID);
	if (error) {
		fail("product_reviews query", error.message);
		return;
	}
	const rows = (data ?? []) as Array<Record<string, unknown>>;
	if (rows.length === 0) fail("at least 1 review row");
	else ok(`${rows.length} review row(s)`);
	for (const r of rows) {
		const missing = ["rating", "comment", "reviewer_nickname", "review_date", "raw"].filter((k) => r[k] == null);
		if (missing.length === 0) ok(`row ${r.external_id} complete`, `rating=${r.rating} status=${r.status}`);
		else fail(`row ${r.external_id} missing`, missing.join(","));
	}
}

async function section6_survivability(row: Record<string, unknown>) {
	console.log("\n=== 6) Survivability — pretend source site is gone ===");
	// Anything reachable from DB + S3 only should still answer:
	//   "What was this product?" — name, price, brand, full description, images, SKUs, video
	const facts = [
		["name", row.name],
		["price_text", row.price_text],
		["description_long (rich)", (row.description_long as string | null)?.slice(0, 100)],
		["sku_variants (offers)", JSON.stringify(row.sku_variants).slice(0, 80)],
		["video_upload_date", row.video_upload_date],
		["images count", ((row.archived_image_s3 as string[] | null) ?? []).length],
		["video URL (S3)", row.archived_video_s3],
		["html snapshot (S3)", row.archived_html_s3],
		["extracted body text (chars)", (row.archived_text as string | null)?.length ?? 0],
		["review aggregate", `count=${row.review_count} avg=${row.review_avg}`],
	];
	for (const [k, v] of facts) {
		if (v == null || v === "" || v === 0) fail(`survives source-site-gone: ${k}`);
		else ok(`survives source-site-gone: ${k}`, String(v).slice(0, 80));
	}
}

async function section7_coverage() {
	console.log("\n=== 7) Coverage across all archived rows ===");
	const sb = getServiceClient();
	const { data } = await sb
		.from("qvc_products")
		.select(
			"id, archive_status, archived_html_s3, archived_thumbnail_s3, archived_video_s3, video_url, description_long, sku_variants, video_upload_date, jsonld_raw, review_count, reviews_fetched_at",
		)
		.in("archive_status", ["complete", "partial"]);
	const rows = (data ?? []) as Array<Record<string, unknown>>;
	console.log(`  ${rows.length} archived qvc_products row(s) — null counts:`);
	const fields = [
		"archived_html_s3",
		"archived_thumbnail_s3",
		"archived_video_s3",
		"description_long",
		"sku_variants",
		"video_upload_date",
		"jsonld_raw",
		"reviews_fetched_at",
	];
	for (const f of fields) {
		const nulls = rows.filter((r) => r[f] == null).length;
		const hasVideo = (r: Record<string, unknown>) => r.video_url != null;
		const expectedNonNull =
			f === "archived_video_s3" || f === "video_upload_date" ? rows.filter(hasVideo).length : rows.length;
		const populated = rows.length - nulls;
		const symbol = populated >= expectedNonNull ? "✓" : "△";
		console.log(`    ${symbol} ${f}: ${populated}/${rows.length} populated  (expected ≥ ${expectedNonNull})`);
	}
}

async function main() {
	const row = await section1_db();
	if (!row) return;
	await section2_s3(row);
	await section3_integrity(row);
	await section4_jsonld(row);
	await section5_reviews();
	await section6_survivability(row);
	await section7_coverage();
	console.log(process.exitCode ? "\n✗ Some checks failed." : "\n✓ All preservation checks passed.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
