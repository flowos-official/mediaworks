import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseQvcProductHTML } from "../lib/qvc-products/fetcher";

const html = readFileSync(
  join(process.cwd(), "scripts/fixtures/qvc/product-with-brand-and-discount.html"),
  "utf-8",
);
const detail = parseQvcProductHTML(html, "569190");

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
  else { console.log(`✓ ${msg}`); }
}

assert(typeof detail.brand === "string" && detail.brand.length > 0, "brand extracted from JSON-LD");
assert(
  detail.original_price_jpy === null || typeof detail.original_price_jpy === "number",
  "original_price_jpy is number or null",
);
assert(
  detail.sale_label === null || typeof detail.sale_label === "string",
  "sale_label is string or null",
);
console.log("brand=", JSON.stringify(detail.brand));
console.log("original_price_jpy=", detail.original_price_jpy, "sale_label=", detail.sale_label);
