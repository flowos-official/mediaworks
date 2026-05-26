/**
 * Live DB smoke: createSignedProductFileUrl が
 *   1) 有効な signed URL を返す
 *   2) bucket は public でないため、未認証の curl で signed URL は読めるが
 *      非-signed (素の path) では 403/404 になる
 * 実行: npm run test:storage-signed-url
 *
 * 前提: 2026-05-26_storage_lock_product_files.sql が dev DB に適用済み。
 */
import { createClient } from "@supabase/supabase-js";
import { createSignedProductFileUrl } from "../lib/storage/signed-url";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
	throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env.local に必要");
}
const sb = createClient(url, key, { auth: { persistSession: false } });

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function main(): Promise<void> {
	const tag = `signed-url-smoke-${Date.now()}.png`;
	// Minimal 1×1 white PNG (valid PNG bytes so mime-type check passes)
	const payload = Buffer.from(
		"89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
		"2e00000000c4944415478016360f8cfc00000000200016f65683600000000" +
		"49454e44ae426082",
		"hex",
	);

	// 1) Upload a tiny file via service-role
	const { error: upErr } = await sb.storage.from("product-files").upload(tag, payload, {
		contentType: "image/png",
		upsert: false,
	});
	if (upErr) throw new Error(`temp upload failed: ${upErr.message}`);

	try {
		// 2) Get a signed URL via the helper
		const signed = await createSignedProductFileUrl(tag, 60);
		assert(signed.startsWith("http"), `signed URL should start with http, got: ${signed}`);
		assert(signed.includes(tag) || signed.includes(encodeURIComponent(tag)),
			`signed URL should reference the path, got: ${signed}`);

		// 3) Fetch via signed URL — should succeed
		const r1 = await fetch(signed);
		assert(r1.ok, `signed URL fetch should be 200, got ${r1.status}`);
		const buf = Buffer.from(await r1.arrayBuffer());
		// PNG magic bytes: 89 50 4E 47
		assert(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
			`body should be a PNG (magic bytes mismatch)`);
		// Also confirm Content-Type
		const ct = r1.headers.get("content-type") ?? "";
		assert(ct.includes("image/png"), `content-type should be image/png, got: ${ct}`);

		// 4) Fetch a guessed public URL (bucket is private after migration) — should fail
		const guessedPublic = `${url}/storage/v1/object/public/product-files/${encodeURIComponent(tag)}`;
		const r2 = await fetch(guessedPublic);
		assert(!r2.ok, `non-signed public URL should be denied (bucket private), got ${r2.status}`);

		console.log("[ok] signed-url smoke 通過 (signed: 200, raw public: blocked)");
	} finally {
		await sb.storage.from("product-files").remove([tag]);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
