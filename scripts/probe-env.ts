import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";
import { getServiceClient } from "../lib/supabase";

async function probeAws() {
	console.log("=== AWS ===");
	const ak = process.env.AWS_ACCESS_KEY_ID ?? "";
	console.log("AWS_ACCESS_KEY_ID:", ak ? `${ak.slice(0, 4)}...${ak.slice(-4)} (${ak.length} chars)` : "MISSING");
	console.log("AWS_S3_REGION:", process.env.AWS_S3_REGION ?? "MISSING");
	if (!ak) return;
	const s3 = new S3Client({
		region: process.env.AWS_S3_REGION,
		credentials: {
			accessKeyId: ak,
			secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
		},
	});
	try {
		const r = await s3.send(new ListBucketsCommand({}));
		console.log("AWS OK, buckets:", (r.Buckets ?? []).map((b) => b.Name).join(", ") || "(none)");
	} catch (e) {
		const err = e as { name?: string; message?: string };
		console.log("AWS ERROR:", err.name, err.message?.slice(0, 200));
	}
}

async function probeSupabase() {
	console.log("\n=== Supabase ===");
	const sb = getServiceClient();
	const checks = ["discovered_products", "qvc_products", "shopch_products", "product_snapshots", "broadcasts", "product_reviews"];
	for (const t of checks) {
		const { error } = await sb.from(t).select("id").limit(1);
		console.log(`  ${t}: ${error ? "ERROR " + error.message.slice(0, 100) : "OK"}`);
	}
	console.log("\n=== New archive + reviews columns ===");
	{
		const { error } = await sb.from("qvc_products").select("archived_video_s3, archive_status, review_count, description_long, sku_variants, jsonld_raw").limit(1);
		console.log("  qvc_products.new cols:", error ? "MISSING (" + error.message.slice(0, 80) + ")" : "OK");
	}
	{
		const { error } = await sb.from("broadcasts").select("archived_video_s3, video_status").limit(1);
		console.log("  broadcasts.archive cols:", error ? "MISSING (" + error.message.slice(0, 80) + ")" : "OK");
	}
	{
		const { error } = await sb.from("discovered_products").select("archived_html_s3, is_still_available, review_count, jsonld_raw").limit(1);
		console.log("  discovered_products.new cols:", error ? "MISSING (" + error.message.slice(0, 80) + ")" : "OK");
	}
	{
		const { error } = await sb.from("shopch_products").select("review_count, jsonld_raw").limit(1);
		console.log("  shopch_products.new cols:", error ? "MISSING (" + error.message.slice(0, 80) + ")" : "OK");
	}
}

async function main() {
	await probeAws();
	await probeSupabase();
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
