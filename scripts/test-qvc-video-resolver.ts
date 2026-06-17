/**
 * Unit test for the shared QVC video resolver (pure parts only — no DB).
 * Covers the bug it fixes: the lead product has no digest, a later one does.
 * Run: npm run test:qvc-video-resolver
 */
import { pickFirstVideoUrl, normalizeVideoUrl } from "../lib/broadcasts/qvc-video-resolver";

let pass = 0;
function ok(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; } else { console.log(`✓ ${msg}`); pass++; }
}

// normalizeVideoUrl
ok(normalizeVideoUrl(null) === null, "null → null");
ok(normalizeVideoUrl("") === null, "empty → null");
ok(normalizeVideoUrl("https://cdn/x.m3u8") === "https://cdn/x.m3u8", "absolute https kept");
ok(normalizeVideoUrl("//cdn/x.m3u8") === "https://cdn/x.m3u8", "protocol-relative → https");

// pickFirstVideoUrl — the core fix: scan ALL products in slot order
const map = new Map<string, string | null>([
	["A", null],            // lead product has NO digest
	["B", null],
	["C", "https://cdn/digest_product/C/ec.m3u8"], // a later product does
	["D", "https://cdn/digest_product/D/ec.m3u8"],
]);
ok(pickFirstVideoUrl(["A", "B", "C", "D"], map) === "https://cdn/digest_product/C/ec.m3u8",
	"lead has no video → returns first later product with a digest (the deferred-bug fix)");
ok(pickFirstVideoUrl(["A", "B"], map) === null, "no product has a video → null");
ok(pickFirstVideoUrl(["C", "A"], map) === "https://cdn/digest_product/C/ec.m3u8", "lead has video → returns lead");
ok(pickFirstVideoUrl([], map) === null, "empty product list → null");
ok(pickFirstVideoUrl(null, map) === null, "null product list → null");
// product id missing from the cache map is skipped, not treated as a hit
ok(pickFirstVideoUrl(["Z", "C"], map) === "https://cdn/digest_product/C/ec.m3u8", "unknown id skipped, falls through to C");

console.log(`\n[test:qvc-video-resolver] ${pass} assertions passed`);
