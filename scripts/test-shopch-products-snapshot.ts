import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseShopChSlotJSON } from "../lib/broadcasts/shopch-json";

const body = readFileSync(
  join(process.cwd(), "scripts/fixtures/broadcasts/shopch-slot-with-products.json"),
  "utf-8",
);
const meta = parseShopChSlotJSON(body);

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
  else { console.log(`✓ ${msg}`); }
}

assert(Array.isArray(meta.products), "products array exists");
assert(meta.products.length > 0, "at least one product");
const p0 = meta.products[0];
assert(typeof p0.productId === "string" && /^\d+$/.test(p0.productId), "productId is digit string");
assert(p0.priceJpy === null || (typeof p0.priceJpy === "number" && p0.priceJpy > 0), "priceJpy is positive number or null");
assert(typeof p0.inStockAtCapture === "boolean", "inStockAtCapture is boolean");
assert(typeof meta.videoPath === "string" || meta.videoPath === null, "videoPath is string or null");
console.log("first product:", JSON.stringify(p0, null, 2));
console.log("videoPath:", meta.videoPath);
