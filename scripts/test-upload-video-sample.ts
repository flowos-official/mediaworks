/**
 * One-shot PoC: upload a locally-downloaded HLS→MP4 sample to Supabase Storage
 * and print the public URL.
 *
 * Usage:
 *   npm run test:upload-video-sample -- --file=/path/to/749808.mp4 --id=749808
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getServiceClient } from "../lib/supabase";

const BUCKET = "broadcast-videos";

function parseArgs(): { file: string; id: string } {
	const args = process.argv.slice(2);
	const get = (name: string) =>
		args.find((a) => a.startsWith(`--${name}=`))?.replace(`--${name}=`, "");
	const file = get("file");
	const id = get("id");
	if (!file || !id) {
		console.error("Usage: --file=<path-to-mp4> --id=<product-id>");
		process.exit(1);
	}
	return { file, id };
}

async function ensureBucket() {
	const sb = getServiceClient();
	const { data: buckets, error: listErr } = await sb.storage.listBuckets();
	if (listErr) throw new Error(`listBuckets: ${listErr.message}`);
	const exists = (buckets ?? []).some((b) => b.name === BUCKET);
	if (exists) {
		console.log(`bucket "${BUCKET}" already exists`);
		return;
	}
	const { error } = await sb.storage.createBucket(BUCKET, {
		public: true,
		fileSizeLimit: 50 * 1024 * 1024, // 50 MB (free-tier ceiling)
		allowedMimeTypes: ["video/mp4"],
	});
	if (error) throw new Error(`createBucket: ${error.message}`);
	console.log(`bucket "${BUCKET}" created (public)`);
}

async function main() {
	const { file, id } = parseArgs();
	const absPath = path.resolve(file);
	const info = await stat(absPath);
	console.log(`Local file: ${absPath} (${(info.size / 1024 / 1024).toFixed(1)} MB)`);

	await ensureBucket();

	const bytes = await readFile(absPath);
	const objectKey = `qvc/${id}.mp4`;

	const sb = getServiceClient();
	const t0 = Date.now();
	const { error: upErr } = await sb.storage.from(BUCKET).upload(objectKey, bytes, {
		contentType: "video/mp4",
		upsert: true,
	});
	if (upErr) throw new Error(`upload: ${upErr.message}`);
	console.log(`uploaded in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${objectKey}`);

	const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(objectKey);
	console.log(`\nPublic URL:\n  ${pub.publicUrl}\n`);
	console.log("Open this URL directly in a browser to verify playback.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
