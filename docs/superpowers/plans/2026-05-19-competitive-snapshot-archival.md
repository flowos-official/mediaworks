# Competitive Snapshot Archival Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture a per-product detail snapshot for every whitelist-matching QVC/ShopCh broadcast slot AND archive the QVC broadcast video to Cloudflare R2, so we have a permanent record of what competitors aired and how it was priced even after the source sites remove it.

**Architecture:** Two-stage pipeline. (1) The existing `daily-broadcasts` cron is extended to write a per-product snapshot row into a new `broadcast_products` table and mark eligible slots `video_status='queued'`. (2) A new `archive-videos` cron picks queued QVC slots, streams the m3u8 through `ffmpeg -c copy` into an R2 multipart upload, and records the resulting MP4 key. ShopCh video archival is explicitly deferred; ShopCh still gets the metadata snapshot.

**Tech Stack:** Next.js 16 App Router · Supabase (Postgres + RLS) · Cloudflare R2 (S3-compatible) · `@aws-sdk/client-s3` (already installed) · `@aws-sdk/lib-storage` (to add) · `@ffmpeg-installer/ffmpeg` (to add) · cheerio · tsx fixture-style tests under `scripts/`.

**Spec:** `docs/superpowers/specs/2026-05-19-competitive-snapshot-archival-design.md`

---

## Pre-flight Reading

Before starting Task 1, the implementing engineer should skim:

- The spec linked above — sections 4 (architecture), 5 (schema), 6 (pipelines), and 8 (error handling) are load-bearing.
- `lib/broadcasts/shopch-json.ts` — the JSON fetcher the spec extends.
- `lib/qvc-products/fetcher.ts` — the QVC HTML parser the spec extends.
- `app/api/cron/daily-broadcasts/route.ts` — the cron we wire enrichment into.
- `scripts/test-broadcasts-shopch-parser.ts` — the **test pattern** used in this repo (tsx + fixture files + custom `assert(cond, msg)` helper, NO jest/vitest).
- `supabase/migrations/2026-05-17_channel_categories_and_columns.sql` — recent RLS pattern to mirror.

---

## File Structure

**Created files (15):**

| Path | Responsibility |
|---|---|
| `supabase/migrations/2026-05-19_broadcast_products_and_brand.sql` | Schema: add columns to broadcasts/qvc_products, create broadcast_products table + RLS |
| `lib/broadcasts/snapshot-enrichment.ts` | Pure module — given a slot + product source, produce broadcast_products rows + brand fields |
| `lib/broadcasts/r2-storage.ts` | R2 (S3-compatible) client factory + multipart upload helper |
| `lib/broadcasts/video-archival.ts` | `archiveOne(slot)` — ffmpeg stream + R2 upload + DB state transitions |
| `app/api/cron/archive-videos/route.ts` | Worker cron — pulls queued slots, fans out archival jobs |
| `app/api/broadcasts/[id]/products/route.ts` | Read endpoint for the video modal |
| `app/api/admin/broadcasts/[id]/retry-archive/route.ts` | Admin endpoint to reset video_status to 'queued' |
| `app/[locale]/(admin)/admin/archive-status/page.tsx` | Admin dashboard for archive pipeline health |
| `components/broadcasts/BroadcastVideoModal.tsx` | Video player + per-product detail list modal |
| `scripts/backfill-broadcast-products.ts` | One-shot historical backfill for existing rows |
| `scripts/smoke-archive-one.ts` | Manual single-slot end-to-end smoke |
| `scripts/test-snapshot-enrichment.ts` | Fixture-based unit test for snapshot module |
| `scripts/test-qvc-fetcher-brand.ts` | Fixture-based unit test for QVC brand/discount extraction |
| `scripts/fixtures/qvc/product-with-brand-and-discount.html` | Fixture for QVC test |
| `scripts/fixtures/broadcasts/shopch-slot-with-products.json` | Fixture for ShopCh products test |

**Modified files (8):**

| Path | Change |
|---|---|
| `lib/qvc-products/fetcher.ts` | Extract `brand` from JSON-LD, `original_price_jpy`/`sale_label` from `utag_data` |
| `lib/broadcasts/shopch-json.ts` | Extend `ShopChSlotMetadata` with `products: ShopChProductSnapshot[]` and `videoPath` |
| `lib/broadcasts/shopch.ts` | Pass new `products[]` through to enrichment |
| `app/api/cron/daily-broadcasts/route.ts` | Call snapshot-enrichment after upsert |
| `components/broadcasts/BroadcastListItem.tsx` | Conditional ▶ icon + status indicator |
| `vercel.json` | Add archive-videos function (maxDuration: 300) + two cron entries |
| `package.json` | Add `@aws-sdk/lib-storage`, `@ffmpeg-installer/ffmpeg`; new `test:snapshot-enrichment`, `test:qvc-brand` scripts; combined `test:archival` |
| `CLAUDE.md` | Append a paragraph documenting the archival pipeline |

---

## Task 1: Schema Migration

**Files:**
- Create: `supabase/migrations/2026-05-19_broadcast_products_and_brand.sql`

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/2026-05-19_broadcast_products_and_brand.sql`:

```sql
-- 2026-05-19: competitive snapshot archival schema
-- Spec: docs/superpowers/specs/2026-05-19-competitive-snapshot-archival-design.md

BEGIN;

-- 1) broadcasts gains brand attribution columns (sourced from JSON-LD brand for
--    QVC, JSON brandname/brandcode for ShopCh).
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS brand_name text,
  ADD COLUMN IF NOT EXISTS brand_code text;

-- 2) qvc_products gains discount snapshot fields parsed from the product page's
--    inline utag_data block (no extra HTTP — parsed during existing enrich).
ALTER TABLE qvc_products
  ADD COLUMN IF NOT EXISTS brand text,
  ADD COLUMN IF NOT EXISTS original_price_jpy int,
  ADD COLUMN IF NOT EXISTS sale_label text;

-- 3) broadcast_products — append-only per-slot per-product snapshot.
CREATE TABLE IF NOT EXISTS broadcast_products (
  broadcast_id        uuid        NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  product_id          text        NOT NULL,
  position            int         NOT NULL,
  name                text,
  image_url           text,
  price_jpy           int,
  original_price_jpy  int,
  discount_rate       int,
  sale_label          text,
  tax_incl            boolean,
  in_stock_at_capture boolean,
  source              text        NOT NULL CHECK (source IN ('qvc', 'shopch')),
  captured_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (broadcast_id, product_id)
);

CREATE INDEX IF NOT EXISTS broadcast_products_product_idx
  ON broadcast_products (product_id);
CREATE INDEX IF NOT EXISTS broadcast_products_captured_idx
  ON broadcast_products (captured_at DESC);

ALTER TABLE broadcast_products ENABLE ROW LEVEL SECURITY;

-- Group A pattern: member/admin read, service_role write.
-- Mirrors the policy in 2026-05-17_channel_categories_and_columns.sql.
DROP POLICY IF EXISTS broadcast_products_select ON broadcast_products;
CREATE POLICY broadcast_products_select
  ON broadcast_products
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.role IN ('member', 'admin')
    )
  );

COMMIT;
```

- [ ] **Step 2: Apply the migration**

Run:
```bash
npx supabase db push
```

Expected output ends with `Finished supabase db push.` (or equivalent confirming push). If the project uses migration application via a custom script, instead run `npm run test:migrations` first to verify discoverability, then push.

- [ ] **Step 3: Verify schema in Supabase**

Run:
```bash
node -e "require('dotenv').config({path:'.env.local'}); const {createClient}=require('@supabase/supabase-js'); const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY); sb.from('broadcast_products').select('*',{count:'exact',head:true}).then(({error,count})=>{ if(error) {console.error(error);process.exit(1);} console.log('broadcast_products exists, count=',count); });"
```

Expected: `broadcast_products exists, count= 0`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-05-19_broadcast_products_and_brand.sql
git commit -m "feat(schema): broadcast_products table + brand/discount columns"
```

---

## Task 2: QVC Parser — Brand Extraction (TDD)

**Files:**
- Create: `scripts/fixtures/qvc/product-with-brand-and-discount.html`
- Create: `scripts/test-qvc-fetcher-brand.ts`
- Modify: `lib/qvc-products/fetcher.ts` (extend `QvcProductDetail` + `parseQvcProductHTML`)
- Modify: `package.json` (add `test:qvc-brand` script)

- [ ] **Step 1: Capture a real QVC product page as fixture**

Run:
```bash
mkdir -p scripts/fixtures/qvc
curl -sS -A "Mozilla/5.0" "https://qvc.jp/product.749000.html" -o scripts/fixtures/qvc/product-with-brand-and-discount.html
```

If 749000 returns 404, substitute any active product id from `node -e "...select id from qvc_products limit 1..."`. The fixture only needs the page's `<script type="application/ld+json">` block (containing `"brand":"…"`) and the inline `var utag_data = {...}` script.

- [ ] **Step 2: Write the failing test**

Create `scripts/test-qvc-fetcher-brand.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseQvcProductHTML } from "../lib/qvc-products/fetcher";

const html = readFileSync(
  join(process.cwd(), "scripts/fixtures/qvc/product-with-brand-and-discount.html"),
  "utf-8",
);
const detail = parseQvcProductHTML(html, "749000");

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
  else { console.log(`✓ ${msg}`); }
}

assert(typeof detail.brand === "string" && detail.brand.length > 0, "brand extracted from JSON-LD");
assert(
  detail.originalPriceJpy === null || typeof detail.originalPriceJpy === "number",
  "originalPriceJpy is number or null",
);
assert(
  detail.saleLabel === null || typeof detail.saleLabel === "string",
  "saleLabel is string or null",
);
// If the fixture page is currently discounted, both should be non-null.
// We only soft-assert here (page may not be on sale).
console.log("brand=", JSON.stringify(detail.brand));
console.log("originalPriceJpy=", detail.originalPriceJpy, "saleLabel=", detail.saleLabel);
```

- [ ] **Step 3: Add test script to package.json**

In `package.json` under `scripts`:
```json
"test:qvc-brand": "tsx scripts/test-qvc-fetcher-brand.ts",
```

- [ ] **Step 4: Run test — expect FAIL**

```bash
npm run test:qvc-brand
```

Expected: TypeScript error on `detail.brand` (field doesn't exist on `QvcProductDetail` yet), OR runtime "brand extracted" assertion fails because parser doesn't read JSON-LD `brand`.

- [ ] **Step 5: Extend `QvcProductDetail` interface**

Modify `lib/qvc-products/fetcher.ts`. After the existing `QvcProductDetail` interface, replace it:

```ts
export interface QvcProductDetail {
	id: string;
	name: string | null;
	description: string | null;
	category: string | null;
	brand: string | null;
	image_url: string | null;
	image_urls: string[];
	video_url: string | null;
	price_text: string | null;
	original_price_jpy: number | null;
	sale_label: string | null;
	source_url: string;
}
```

- [ ] **Step 6: Implement brand + discount extraction**

In the same file, ABOVE `parseQvcProductHTML`, add helper functions:

```ts
function extractBrandFromJSONLD($: cheerio.CheerioAPI): string | null {
	const ldNodes = $('script[type="application/ld+json"]').toArray();
	for (const el of ldNodes) {
		const text = $(el).text();
		if (!text) continue;
		try {
			const parsed = JSON.parse(text);
			const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
			for (const item of items) {
				if (typeof item !== "object" || item === null) continue;
				const obj = item as Record<string, unknown>;
				const brand = obj.brand;
				if (typeof brand === "string") {
					const cleaned = brand.trim();
					if (cleaned) return cleaned;
				} else if (typeof brand === "object" && brand !== null) {
					const name = (brand as Record<string, unknown>).name;
					if (typeof name === "string" && name.trim()) return name.trim();
				}
			}
		} catch {
			// next node
		}
	}
	return null;
}

/**
 * Parse the inline `var utag_data = { ... };` block on QVC product pages for
 * the list price + sale code triplet. Tolerates the block being absent (older
 * page revisions or sold-out products) by returning null.
 */
function extractUtagDiscount(html: string): {
	originalPriceJpy: number | null;
	saleLabel: string | null;
} {
	const match = html.match(/var\s+utag_data\s*=\s*(\{[\s\S]*?\});/);
	if (!match) return { originalPriceJpy: null, saleLabel: null };
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(match[1]) as Record<string, unknown>;
	} catch {
		return { originalPriceJpy: null, saleLabel: null };
	}
	const rawPrice = data.product_qvc_price;
	const original =
		typeof rawPrice === "string" && /^\d+$/.test(rawPrice)
			? parseInt(rawPrice, 10)
			: null;
	const rawLabel = data.special_price_code;
	const label =
		typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim() : null;
	return { originalPriceJpy: original, saleLabel: label };
}
```

- [ ] **Step 7: Wire the helpers into `parseQvcProductHTML`**

Inside `parseQvcProductHTML`, after `const category = extractCategoryFromHTML($);`, add:

```ts
	const brand = extractBrandFromJSONLD($);
	const { originalPriceJpy, saleLabel } = extractUtagDiscount(html);
```

Then update the returned object to include the new fields:

```ts
	return {
		id,
		name,
		description,
		category,
		brand,
		image_url,
		image_urls,
		video_url,
		price_text,
		original_price_jpy: originalPriceJpy,
		sale_label: saleLabel,
		source_url: productUrl(id),
	};
```

- [ ] **Step 8: Run test — expect PASS**

```bash
npm run test:qvc-brand
```

Expected: all `✓` lines, no `✗`. The console.log lines print actual extracted brand/price/label.

- [ ] **Step 9: Update enrichment writer**

Modify `lib/qvc-products/enrich.ts` at the `rows.map((r) => ({ ... }))` block (around line 79) to include the new fields. Replace that block with:

```ts
			const rows = results
				.filter((r) => r.detail !== null)
				.map((r) => ({
					id: r.id,
					name: r.detail!.name,
					description: r.detail!.description,
					category: r.detail!.category,
					brand: r.detail!.brand,
					image_url: r.detail!.image_url,
					image_urls: r.detail!.image_urls,
					video_url: r.detail!.video_url,
					price_text: r.detail!.price_text,
					original_price_jpy: r.detail!.original_price_jpy,
					sale_label: r.detail!.sale_label,
					source_url: r.detail!.source_url,
					fetched_at: new Date().toISOString(),
				}));
```

- [ ] **Step 10: Run existing QVC parser test**

```bash
npm run test:broadcasts-qvc
```

Expected: existing assertions still pass (we added fields, didn't break any).

- [ ] **Step 11: Type-check**

```bash
npx tsc --noEmit
```

Expected: zero new errors (pre-existing `pg` module errors in `scripts/apply-sql-file.ts` etc. are unrelated).

- [ ] **Step 12: Commit**

```bash
git add lib/qvc-products/fetcher.ts lib/qvc-products/enrich.ts scripts/test-qvc-fetcher-brand.ts scripts/fixtures/qvc/product-with-brand-and-discount.html package.json
git commit -m "feat(qvc-parser): extract brand from JSON-LD + utag_data discount fields"
```

---

## Task 3: ShopCh Parser — Per-Product Snapshot (TDD)

**Files:**
- Create: `scripts/fixtures/broadcasts/shopch-slot-with-products.json`
- Modify: `lib/broadcasts/shopch-json.ts` (extend `ShopChSlotMetadata`)
- Create: `scripts/test-shopch-products-snapshot.ts`
- Modify: `package.json` (add script)

- [ ] **Step 1: Capture a real ShopCh slot JSON as fixture**

```bash
curl -sS -A "Mozilla/5.0" "https://www.shopch.jp/json/programprodlist2/20260518000000.json" -o scripts/fixtures/broadcasts/shopch-slot-with-products.json
```

If that programId no longer exists (older than 30 days), substitute any current `air_date + start_time` from `broadcasts` via Supabase:
```bash
node -e "require('dotenv').config({path:'.env.local'}); const {createClient}=require('@supabase/supabase-js'); const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY); sb.from('broadcasts').select('air_date,start_time').eq('channel','shopch').order('air_date',{ascending:false}).limit(1).then(({data})=>{ const r=data[0]; console.log(r.air_date.replace(/-/g,'')+r.start_time.replace(/:/g,'')); });"
```

- [ ] **Step 2: Write the failing test**

Create `scripts/test-shopch-products-snapshot.ts`:

```ts
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
```

- [ ] **Step 3: Add to package.json scripts**

```json
"test:shopch-products": "tsx scripts/test-shopch-products-snapshot.ts",
```

- [ ] **Step 4: Run test — expect FAIL**

```bash
npm run test:shopch-products
```

Expected: TypeScript error `products` doesn't exist on `ShopChSlotMetadata`.

- [ ] **Step 5: Extend `ShopChSlotMetadata`**

Modify `lib/broadcasts/shopch-json.ts`. Replace `ShopChSlotMetadata` and add the new `ShopChProductSnapshot`:

```ts
export interface ShopChProductSnapshot {
	productId: string;
	name: string | null;
	imageUrl: string | null;
	priceJpy: number | null;
	originalPriceJpy: number | null;
	discountRate: number | null;
	saleLabel: string | null;
	taxIncl: boolean | null;
	inStockAtCapture: boolean;
}

export interface ShopChSlotMetadata {
	category: string | null;
	categoryCode: string | null;
	productIds: string[];
	products: ShopChProductSnapshot[];
	brandName: string | null;
	brandCode: string | null;
	/** The site's m3u8 stem path (e.g. "m3u8/prog/20260518000000/20260518000000").
	 *  Stored for future ShopCh video archival; null when absent. */
	videoPath: string | null;
}
```

Update `EMPTY`:

```ts
const EMPTY: ShopChSlotMetadata = {
	category: null,
	categoryCode: null,
	productIds: [],
	products: [],
	brandName: null,
	brandCode: null,
	videoPath: null,
};
```

- [ ] **Step 6: Implement the product mapping**

In the same file, replace the body of `parseShopChSlotJSON` with the extended version. Find the existing `productIds` loop and after it, add:

```ts
	const products: ShopChProductSnapshot[] = [];
	if (Array.isArray(prodList)) {
		for (const raw of prodList) {
			if (typeof raw !== "object" || raw === null) continue;
			const item = raw as Record<string, unknown>;
			const pid = item.reqPrNo;
			if (typeof pid !== "string" || !/^\d+$/.test(pid)) continue;

			const parseYen = (v: unknown): number | null => {
				if (typeof v !== "string") return null;
				const digits = v.replace(/[^\d]/g, "");
				return digits.length > 0 ? parseInt(digits, 10) : null;
			};
			const parseRate = (v: unknown): number | null => {
				if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
				const n = parseInt(v, 10);
				return n >= 0 && n <= 100 ? n : null;
			};
			const prodImg = trimOrNull(item.prodImg);
			const imageUrl = prodImg
				? prodImg.startsWith("http")
					? prodImg
					: `https://www.shopch.jp/${prodImg.replace(/^\/+/, "")}`
				: null;
			const nostock = trimOrNull(item.nostockName);
			const taxStr = trimOrNull(item.texStr);

			products.push({
				productId: pid,
				name: trimOrNull(item.prodName),
				imageUrl,
				priceJpy: parseYen(item.genzaiPrice),
				originalPriceJpy: parseYen(item.comperPrice),
				discountRate: parseRate(item.offRate),
				saleLabel:
					trimOrNull(item.limitedPriceLabel) ?? trimOrNull(item.saleStr),
				taxIncl: taxStr === null ? null : taxStr === "(税込)",
				inStockAtCapture: nostock === null,
			});
		}
	}

	const videoPath = trimOrNull(parsed.pgmMovie);
```

Update the return statement of `parseShopChSlotJSON`:

```ts
	return {
		category: trimOrNull(parsed.pgmcategory),
		categoryCode: trimOrNull(parsed.pgmcategorycode),
		productIds,
		products,
		brandName: trimOrNull(parsed.brandname),
		brandCode: trimOrNull(parsed.brandcode),
		videoPath,
	};
```

Update `RawSlotJSON` to declare `pgmMovie`:

```ts
interface RawSlotJSON {
	pgmcategory?: unknown;
	pgmcategorycode?: unknown;
	prodList1?: unknown;
	brandname?: unknown;
	brandcode?: unknown;
	pgmMovie?: unknown;
}
```

- [ ] **Step 7: Run test — expect PASS**

```bash
npm run test:shopch-products
```

Expected: all `✓`, console prints a sample product object and the videoPath stem.

- [ ] **Step 8: Type-check + commit**

```bash
npx tsc --noEmit
git add lib/broadcasts/shopch-json.ts scripts/test-shopch-products-snapshot.ts scripts/fixtures/broadcasts/shopch-slot-with-products.json package.json
git commit -m "feat(shopch-parser): extend ShopChSlotMetadata with products[] + videoPath"
```

---

## Task 4: Snapshot Enrichment Module (TDD)

**Files:**
- Create: `lib/broadcasts/snapshot-enrichment.ts`
- Create: `scripts/test-snapshot-enrichment.ts`
- Modify: `package.json` (add `test:snapshot-enrichment`)

- [ ] **Step 1: Write the failing test**

Create `scripts/test-snapshot-enrichment.ts`:

```ts
import {
	buildQvcSnapshotRows,
	buildShopChSnapshotRows,
	pickBrandFromQvcProducts,
} from "../lib/broadcasts/snapshot-enrichment";
import type { ShopChProductSnapshot } from "../lib/broadcasts/shopch-json";

function assert(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
	else { console.log(`✓ ${msg}`); }
}

// ---- QVC ----
const qvcSlot = {
	id: "bcast-1",
	channel: "qvc" as const,
	product_ids: ["100", "200", "300"],
};
const qvcProducts = [
	{ id: "100", name: "プロダクト 100", image_url: "https://x/100.jpg", price_text: "¥12,000", brand: null,           original_price_jpy: null, sale_label: null },
	{ id: "200", name: "プロダクト 200", image_url: "https://x/200.jpg", price_text: "¥3,980",  brand: "ブランドB",     original_price_jpy: 5980, sale_label: "WSV" },
];
const qvcRows = buildQvcSnapshotRows(qvcSlot.id, qvcSlot.product_ids, qvcProducts);
assert(qvcRows.length === 2, "QVC: 2 rows produced (missing id 300 skipped)");
assert(qvcRows[0].position === 0 && qvcRows[0].product_id === "100", "QVC: position 0 = first id");
assert(qvcRows[1].price_jpy === 3980, "QVC: price_jpy parsed from price_text");
assert(qvcRows[1].original_price_jpy === 5980, "QVC: original_price_jpy passed through");
assert(qvcRows[1].discount_rate === 33, "QVC: discount_rate computed (5980→3980 = 33%)");
assert(qvcRows[0].source === "qvc", "QVC: source label");
const qvcBrand = pickBrandFromQvcProducts(qvcSlot.product_ids, qvcProducts);
assert(qvcBrand === "ブランドB", "QVC: brand picked from first non-null");

// ---- ShopCh ----
const shopchProducts: ShopChProductSnapshot[] = [
	{
		productId: "555",
		name: "ショップCH商品",
		imageUrl: "https://x/555.jpg",
		priceJpy: 7700,
		originalPriceJpy: 18700,
		discountRate: 58,
		saleLabel: "期間限定",
		taxIncl: true,
		inStockAtCapture: true,
	},
];
const shopchRows = buildShopChSnapshotRows("bcast-2", shopchProducts);
assert(shopchRows.length === 1, "ShopCh: 1 row");
assert(shopchRows[0].discount_rate === 58, "ShopCh: discount_rate from JSON offRate");
assert(shopchRows[0].in_stock_at_capture === true, "ShopCh: in_stock_at_capture");
assert(shopchRows[0].source === "shopch", "ShopCh: source label");
```

- [ ] **Step 2: Add to package.json**

```json
"test:snapshot-enrichment": "tsx scripts/test-snapshot-enrichment.ts",
```

- [ ] **Step 3: Run — expect FAIL**

```bash
npm run test:snapshot-enrichment
```

Expected: TypeScript error — module doesn't exist.

- [ ] **Step 4: Implement the module**

Create `lib/broadcasts/snapshot-enrichment.ts`:

```ts
/**
 * Pure functions that turn a broadcast slot + its product source into
 * `broadcast_products` row objects. No I/O — the cron caller is responsible
 * for fetching qvc_products / ShopCh JSON and for writing the resulting rows
 * to Supabase. Keeping this pure makes it cheap to unit-test the row shape
 * and the discount/brand derivations without spinning up a DB.
 */
import type { ShopChProductSnapshot } from "./shopch-json";

export interface BroadcastProductRow {
	broadcast_id: string;
	product_id: string;
	position: number;
	name: string | null;
	image_url: string | null;
	price_jpy: number | null;
	original_price_jpy: number | null;
	discount_rate: number | null;
	sale_label: string | null;
	tax_incl: boolean | null;
	in_stock_at_capture: boolean | null;
	source: "qvc" | "shopch";
}

export interface QvcProductLike {
	id: string;
	name: string | null;
	image_url: string | null;
	price_text: string | null;
	brand: string | null;
	original_price_jpy: number | null;
	sale_label: string | null;
}

/**
 * Strip yen-formatted strings ("¥3,980", "3980円") down to an integer.
 * Returns null when no digits found.
 */
function parsePriceText(s: string | null): number | null {
	if (!s) return null;
	const digits = s.replace(/[^\d]/g, "");
	return digits.length > 0 ? parseInt(digits, 10) : null;
}

function computeDiscountRate(
	current: number | null,
	original: number | null,
): number | null {
	if (current === null || original === null || original <= 0) return null;
	if (current >= original) return null;
	return Math.round(((original - current) / original) * 100);
}

/** Produce broadcast_products rows for a QVC slot.
 *  Skips product_ids that don't resolve in `qvc_products`. Preserves array
 *  position even when intermediate ids are missing (UI orders by position). */
export function buildQvcSnapshotRows(
	broadcastId: string,
	productIds: readonly string[],
	qvcProducts: readonly QvcProductLike[],
): BroadcastProductRow[] {
	const byId = new Map<string, QvcProductLike>();
	for (const p of qvcProducts) byId.set(p.id, p);
	const rows: BroadcastProductRow[] = [];
	productIds.forEach((id, position) => {
		const p = byId.get(id);
		if (!p) return;
		const priceJpy = parsePriceText(p.price_text);
		const original = p.original_price_jpy;
		rows.push({
			broadcast_id: broadcastId,
			product_id: id,
			position,
			name: p.name,
			image_url: p.image_url,
			price_jpy: priceJpy,
			original_price_jpy: original,
			discount_rate: computeDiscountRate(priceJpy, original),
			sale_label: p.sale_label,
			tax_incl: null, // QVC pages don't expose tax breakdown reliably
			in_stock_at_capture: null, // QVC scrape doesn't capture per-broadcast stock
			source: "qvc",
		});
	});
	return rows;
}

/** First non-null brand among the resolved QVC products (in array order). */
export function pickBrandFromQvcProducts(
	productIds: readonly string[],
	qvcProducts: readonly QvcProductLike[],
): string | null {
	const byId = new Map<string, QvcProductLike>();
	for (const p of qvcProducts) byId.set(p.id, p);
	for (const id of productIds) {
		const p = byId.get(id);
		if (p && typeof p.brand === "string" && p.brand.length > 0) return p.brand;
	}
	return null;
}

/** Produce broadcast_products rows for a ShopCh slot. */
export function buildShopChSnapshotRows(
	broadcastId: string,
	products: readonly ShopChProductSnapshot[],
): BroadcastProductRow[] {
	return products.map((p, position) => ({
		broadcast_id: broadcastId,
		product_id: p.productId,
		position,
		name: p.name,
		image_url: p.imageUrl,
		price_jpy: p.priceJpy,
		original_price_jpy: p.originalPriceJpy,
		discount_rate: p.discountRate,
		sale_label: p.saleLabel,
		tax_incl: p.taxIncl,
		in_stock_at_capture: p.inStockAtCapture,
		source: "shopch",
	}));
}
```

- [ ] **Step 5: Run test — expect PASS**

```bash
npm run test:snapshot-enrichment
```

Expected: all `✓`, no `✗`.

- [ ] **Step 6: Commit**

```bash
git add lib/broadcasts/snapshot-enrichment.ts scripts/test-snapshot-enrichment.ts package.json
git commit -m "feat(broadcasts): pure snapshot-enrichment module + unit tests"
```

---

## Task 5: Wire Enrichment into daily-broadcasts Cron

**Files:**
- Modify: `app/api/cron/daily-broadcasts/route.ts`
- Modify: `lib/broadcasts/shopch.ts` (expose products[] in scrape result)

- [ ] **Step 1: Read the current daily-broadcasts route**

```bash
cat app/api/cron/daily-broadcasts/route.ts | head -80
```

Locate the section that upserts slots and persists. The enrichment must run AFTER the upsert (so we have `broadcasts.id` values) and BEFORE the response returns.

- [ ] **Step 2: Update shopch.ts to surface products[] to the caller**

In `lib/broadcasts/shopch.ts::scrapeShopChannelForDate`, the existing enrichment loop already calls `fetchShopChSlotMetadataBatch`. The metadata is currently discarded once `category`/`product_ids` are merged into the slot. Persist the products array on the returned slot via a side channel.

Add an exported map alongside the function:

```ts
// Exported so the cron can rebuild the per-slot ShopCh product list for the
// snapshot pass without re-fetching the JSON. Keyed by programId.
export type ShopChMetadataByProgramId = Map<string, import("./shopch-json").ShopChSlotMetadata>;

export async function scrapeShopChannelForDate(
	date: Date,
): Promise<ScrapeResult & { shopchMetadataByProgramId?: ShopChMetadataByProgramId }> {
	// ... existing body ...
	// (return the metaByPid map alongside the existing result)
	return {
		channel: "shopch",
		date: iso,
		slots: enriched,
		ok: true,
		health: computeHealth(enriched, true),
		shopchMetadataByProgramId: metaByPid,
	};
}
```

- [ ] **Step 3: Add the enrichment block to daily-broadcasts route**

In `app/api/cron/daily-broadcasts/route.ts`, after the existing upsert loop completes, insert this enrichment pass. Use the exact identifier names that appear in the route (the implementing engineer should match local variables):

```ts
import {
	buildQvcSnapshotRows,
	buildShopChSnapshotRows,
	pickBrandFromQvcProducts,
	type QvcProductLike,
} from "@/lib/broadcasts/snapshot-enrichment";
import {
	buildProgramId,
	type ShopChSlotMetadata,
} from "@/lib/broadcasts/shopch-json";
import { loadWhitelist, isAllowed } from "@/lib/broadcasts/category-filter";

// ... existing scrape + upsert ...

const whitelist = await loadWhitelist();
const sb = getServiceClient();

// Snapshot enrichment — runs only for whitelist-matching slots.
for (const persistedSlot of allPersistedSlots) {
	// `allPersistedSlots` must be the upserted rows with their assigned `id`s.
	if (!isAllowed(whitelist, persistedSlot.channel, persistedSlot.category)) {
		continue;
	}
	if (persistedSlot.channel === "qvc") {
		const ids = persistedSlot.product_ids ?? [];
		if (ids.length === 0) continue;
		const { data: products } = await sb
			.from("qvc_products")
			.select("id, name, image_url, price_text, brand, original_price_jpy, sale_label, video_url")
			.in("id", ids);
		const qvcProducts = (products ?? []) as QvcProductLike[];
		const rows = buildQvcSnapshotRows(persistedSlot.id, ids, qvcProducts);
		if (rows.length > 0) {
			await sb.from("broadcast_products").upsert(rows, { onConflict: "broadcast_id,product_id" });
		}
		const brandName = pickBrandFromQvcProducts(ids, qvcProducts);
		const anyVideoUrl = qvcProducts.some((p) => (p as unknown as { video_url?: string }).video_url);
		await sb.from("broadcasts").update({
			brand_name: brandName,
			video_status: anyVideoUrl ? "queued" : "deferred",
		}).eq("id", persistedSlot.id);
	} else if (persistedSlot.channel === "shopch") {
		const programId = buildProgramId(persistedSlot.air_date, persistedSlot.start_time);
		const meta: ShopChSlotMetadata | undefined =
			shopchMetadataByProgramId?.get(programId);
		if (!meta) continue;
		const rows = buildShopChSnapshotRows(persistedSlot.id, meta.products);
		if (rows.length > 0) {
			await sb.from("broadcast_products").upsert(rows, { onConflict: "broadcast_id,product_id" });
		}
		await sb.from("broadcasts").update({
			brand_name: meta.brandName,
			brand_code: meta.brandCode,
			video_status: "failed_unsupported",
		}).eq("id", persistedSlot.id);
	}
}
```

The route variable `allPersistedSlots` and `shopchMetadataByProgramId` should be sourced from the upsert step's return value. If the existing route doesn't return the upserted rows, modify the persist call to return `select('id, channel, air_date, start_time, category, product_ids')`.

- [ ] **Step 4: Bump function timeout to accommodate enrichment**

In `vercel.json`, change `app/api/cron/daily-broadcasts/route.ts` maxDuration from `60` to `120`. (Enrichment adds at most one DB roundtrip per slot for QVC + the existing JSON fetches are already counted.)

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit
```

Expected: zero new errors.

- [ ] **Step 6: Smoke against staging — dry run**

If a staging Supabase is available, run the cron manually:
```bash
curl -H "Authorization: Bearer ${CRON_SECRET}" "https://<staging>/api/cron/daily-broadcasts"
```

Verify `broadcast_products` gained rows for yesterday's date:
```bash
node -e "require('dotenv').config({path:'.env.local'}); const {createClient}=require('@supabase/supabase-js'); const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY); sb.from('broadcast_products').select('*',{count:'exact',head:true}).then(({count})=>console.log('broadcast_products rows:',count));"
```

Expected: count > 0.

- [ ] **Step 7: Commit**

```bash
git add app/api/cron/daily-broadcasts/route.ts lib/broadcasts/shopch.ts vercel.json
git commit -m "feat(cron): wire snapshot enrichment into daily-broadcasts"
```

---

## Task 6: R2 Storage Wrapper

**Files:**
- Create: `lib/broadcasts/r2-storage.ts`
- Modify: `.env.local.example` (or wherever env templates live; check repo)

- [ ] **Step 1: Add R2 env var template**

If `.env.example` exists in the repo, append:

```
# Cloudflare R2 — broadcast video archive (see docs/superpowers/specs/2026-05-19-competitive-snapshot-archival-design.md)
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=mediaworks-broadcasts
R2_PUBLIC_BASE_URL=
```

If no `.env.example`, skip this step but flag in the commit message that operator must add these to Vercel + local `.env.local`.

- [ ] **Step 2: Install `@aws-sdk/lib-storage`**

```bash
npm install --save @aws-sdk/lib-storage
```

Expected: `package.json` and `package-lock.json` updated, `@aws-sdk/lib-storage` added to `dependencies`.

- [ ] **Step 3: Implement R2 client wrapper**

Create `lib/broadcasts/r2-storage.ts`:

```ts
/**
 * Cloudflare R2 client wrapper. R2 implements the S3 API; the AWS SDK v3
 * works against it when we override `endpoint` and use `region: "auto"`.
 *
 * Public reads go through the bucket's R2.dev URL or a custom domain,
 * configured by R2_PUBLIC_BASE_URL. We store only the object key in
 * broadcasts.archived_video_s3 — never the full URL — so the public base
 * can change without rewriting historical rows.
 */
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing required env var: ${name}`);
	return v;
}

let client: S3Client | null = null;
export function getR2Client(): S3Client {
	if (client) return client;
	const accountId = requireEnv("R2_ACCOUNT_ID");
	client = new S3Client({
		region: "auto",
		endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
			secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
		},
		forcePathStyle: true,
	});
	return client;
}

export interface R2UploadResult {
	key: string;
	bytes: number;
}

/**
 * Stream an MP4 (or any binary) into R2 with multipart upload. Returns the
 * stored key and total bytes uploaded. Throws on hard upload failure (after
 * the SDK's internal 3× retry budget).
 */
export async function uploadStreamToR2(
	body: Readable,
	key: string,
	contentType = "video/mp4",
): Promise<R2UploadResult> {
	const bucket = requireEnv("R2_BUCKET");
	let bytes = 0;
	body.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
	});
	const upload = new Upload({
		client: getR2Client(),
		params: {
			Bucket: bucket,
			Key: key,
			Body: body,
			ContentType: contentType,
		},
		// 16 MB parts — R2 minimum is 5 MB, larger parts reduce round-trips.
		partSize: 16 * 1024 * 1024,
		queueSize: 4,
	});
	await upload.done();
	return { key, bytes };
}

/**
 * Build the deterministic R2 object key for a broadcast slot's archived
 * video. Same slot re-archived → overwrite (idempotent).
 */
export function broadcastVideoKey(
	channel: string,
	airDate: string,
	startTime: string,
	broadcastId: string,
): string {
	const shortId = broadcastId.slice(0, 8);
	const safeTime = startTime.replace(/:/g, "-");
	return `videos/${channel}/${airDate}/${safeTime}--${shortId}.mp4`;
}
```

- [ ] **Step 4: Type-check + commit**

```bash
npx tsc --noEmit
git add lib/broadcasts/r2-storage.ts package.json package-lock.json
git commit -m "feat(storage): R2 client wrapper + deterministic video key builder"
```

---

## Task 7: Video Archival Module

**Files:**
- Create: `lib/broadcasts/video-archival.ts`
- Modify: `package.json` (add `@ffmpeg-installer/ffmpeg`)

- [ ] **Step 1: Install ffmpeg installer**

```bash
npm install --save @ffmpeg-installer/ffmpeg
```

- [ ] **Step 2: Implement the archival module**

Create `lib/broadcasts/video-archival.ts`:

```ts
/**
 * Single-slot video archival job. Given a queued broadcast row, resolves its
 * m3u8 source URL (QVC only at this stage), pipes the stream through ffmpeg
 * in copy mode (no transcode) into an R2 multipart upload, and updates the
 * broadcasts row with archive metadata or a retryable failure state.
 *
 * Failure model: any throw rolls the slot back to `video_status='queued'`
 * with incremented attempts. At attempts >= MAX_ATTEMPTS the status becomes
 * `abandoned` and admin intervention is required.
 */
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { getServiceClient } from "@/lib/supabase";
import { broadcastVideoKey, uploadStreamToR2 } from "./r2-storage";

const MAX_ATTEMPTS = 5;

export interface QueuedSlot {
	id: string;
	channel: "qvc" | "shopch";
	air_date: string;
	start_time: string;
	product_ids: string[] | null;
	video_download_attempts: number;
}

export interface ArchiveResult {
	broadcastId: string;
	status: "archived" | "queued" | "deferred" | "abandoned" | "failed_unsupported";
	bytes?: number;
	error?: string;
}

/** Look up the m3u8 URL for the slot's lead product. ShopCh is deferred. */
async function resolveVideoUrl(slot: QueuedSlot): Promise<string | null> {
	if (slot.channel !== "qvc") return null;
	const firstPid = slot.product_ids?.[0];
	if (!firstPid) return null;
	const sb = getServiceClient();
	const { data } = await sb
		.from("qvc_products")
		.select("video_url")
		.eq("id", firstPid)
		.maybeSingle();
	const url = (data as { video_url: string | null } | null)?.video_url ?? null;
	if (!url) return null;
	return url.startsWith("http") ? url : `https:${url}`;
}

/** Spawn ffmpeg to copy-mux the m3u8 into a fragmented MP4 on stdout.
 *  We use `-c copy` (no re-encode) and `-movflags frag_keyframe+empty_moov`
 *  so the MP4 stream is valid even when piped (no seekable index needed). */
function spawnFfmpegStream(m3u8Url: string): {
	stream: Readable;
	stderrChunks: string[];
	wait: Promise<{ code: number | null }>;
} {
	const proc = spawn(ffmpegInstaller.path, [
		"-hide_banner",
		"-loglevel", "warning",
		"-i", m3u8Url,
		"-c", "copy",
		"-movflags", "frag_keyframe+empty_moov",
		"-f", "mp4",
		"pipe:1",
	], { stdio: ["ignore", "pipe", "pipe"] });

	const stderrChunks: string[] = [];
	proc.stderr.on("data", (c: Buffer) => stderrChunks.push(c.toString("utf-8")));
	const wait = new Promise<{ code: number | null }>((resolve) => {
		proc.on("close", (code) => resolve({ code }));
	});
	return { stream: proc.stdout, stderrChunks, wait };
}

/** Archive one queued slot. Idempotent: a row already 'archived' is a no-op.
 *  Failures roll the status forward correctly. */
export async function archiveOne(slot: QueuedSlot): Promise<ArchiveResult> {
	const sb = getServiceClient();
	const broadcastId = slot.id;

	// Claim the slot so a parallel cron run doesn't double-process it.
	const { error: claimErr } = await sb
		.from("broadcasts")
		.update({ video_status: "downloading" })
		.eq("id", broadcastId)
		.eq("video_status", "queued");
	if (claimErr) {
		return { broadcastId, status: "queued", error: claimErr.message };
	}

	const videoUrl = await resolveVideoUrl(slot);
	if (!videoUrl) {
		await sb.from("broadcasts").update({
			video_status: slot.channel === "shopch" ? "failed_unsupported" : "deferred",
			video_error: slot.channel === "shopch"
				? "shopch video archival not yet supported"
				: "no video_url for lead product",
		}).eq("id", broadcastId);
		return { broadcastId, status: slot.channel === "shopch" ? "failed_unsupported" : "deferred" };
	}

	const key = broadcastVideoKey(slot.channel, slot.air_date, slot.start_time, broadcastId);
	const { stream, stderrChunks, wait } = spawnFfmpegStream(videoUrl);

	try {
		const [{ bytes }, { code }] = await Promise.all([
			uploadStreamToR2(stream, key),
			wait,
		]);
		if (code !== 0) {
			throw new Error(`ffmpeg exited with code ${code}: ${stderrChunks.join("").slice(-500)}`);
		}
		// ffmpeg writes a Duration line to stderr around stream start.
		const durationSec = parseDurationFromStderr(stderrChunks.join(""));
		await sb.from("broadcasts").update({
			archived_video_s3: key,
			video_size_bytes: bytes,
			video_duration_sec: durationSec,
			video_quality: "source",
			video_status: "archived",
			video_downloaded_at: new Date().toISOString(),
			video_error: null,
		}).eq("id", broadcastId);
		return { broadcastId, status: "archived", bytes };
	} catch (e) {
		const attempts = (slot.video_download_attempts ?? 0) + 1;
		const finalStatus = attempts >= MAX_ATTEMPTS ? "abandoned" : "queued";
		const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
		await sb.from("broadcasts").update({
			video_status: finalStatus,
			video_download_attempts: attempts,
			video_error: msg,
		}).eq("id", broadcastId);
		return { broadcastId, status: finalStatus, error: msg };
	}
}

/** Parse `Duration: HH:MM:SS.xx` from ffmpeg stderr. Returns null when not
 *  found (e.g. the stream finished too fast or the format hid it). */
export function parseDurationFromStderr(stderr: string): number | null {
	const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
	if (!m) return null;
	const h = parseInt(m[1], 10);
	const mi = parseInt(m[2], 10);
	const s = parseFloat(m[3]);
	if (!Number.isFinite(h + mi + s)) return null;
	return Math.round(h * 3600 + mi * 60 + s);
}
```

- [ ] **Step 3: Unit-test the duration parser**

Append to `scripts/test-snapshot-enrichment.ts` (extending the existing test runner so we don't pay another script slot):

```ts
import { parseDurationFromStderr } from "../lib/broadcasts/video-archival";

assert(parseDurationFromStderr("Duration: 01:23:45.67, start: 0") === 5025, "parseDuration: 1h23m45s = 5025s");
assert(parseDurationFromStderr("nothing here") === null, "parseDuration: null when absent");
```

Run:
```bash
npm run test:snapshot-enrichment
```

Expected: all assertions pass including the two new ones.

- [ ] **Step 4: Type-check + commit**

```bash
npx tsc --noEmit
git add lib/broadcasts/video-archival.ts scripts/test-snapshot-enrichment.ts package.json package-lock.json
git commit -m "feat(broadcasts): video-archival module — ffmpeg copy stream → R2"
```

---

## Task 8: Video Archival Worker Route

**Files:**
- Create: `app/api/cron/archive-videos/route.ts`

- [ ] **Step 1: Implement the worker route**

Create `app/api/cron/archive-videos/route.ts`:

```ts
/**
 * Cron — archive queued broadcast videos.
 *
 * Schedule: JST 04:00 (UTC 19:00 previous day) + JST 10:00 (UTC 01:00) retry.
 * Auth: Bearer ${CRON_SECRET} via hasInternalSecret().
 * Concurrency: 4 ffmpeg pipes in parallel, up to 8 slots per invocation.
 * Function timeout: 300s (configured in vercel.json).
 */
import { NextResponse, type NextRequest } from "next/server";
import { hasInternalSecret } from "@/lib/auth/internal-secret";
import { getServiceClient } from "@/lib/supabase";
import { archiveOne, type QueuedSlot } from "@/lib/broadcasts/video-archival";

const BATCH_SIZE = 8;
const CONCURRENCY = 4;

/** Bounded-concurrency map, no external dep. */
async function pBoundedAll<T, R>(
	items: readonly T[],
	worker: (item: T) => Promise<R>,
	concurrency: number,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let i = 0;
	const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (true) {
			const idx = i++;
			if (idx >= items.length) return;
			results[idx] = await worker(items[idx]);
		}
	});
	await Promise.all(lanes);
	return results;
}

export async function GET(req: NextRequest) {
	if (!hasInternalSecret(req)) {
		return new Response("unauthorized", { status: 401 });
	}
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("broadcasts")
		.select("id, channel, air_date, start_time, product_ids, video_download_attempts")
		.eq("video_status", "queued")
		.lt("video_download_attempts", 5)
		.order("air_date", { ascending: false })
		.limit(BATCH_SIZE);
	if (error) {
		console.error("[archive-videos] queue read failed:", error.message);
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
	const queue = (data ?? []) as QueuedSlot[];
	if (queue.length === 0) {
		return NextResponse.json({ processed: 0, archived: 0, message: "empty queue" });
	}
	const results = await pBoundedAll(queue, archiveOne, CONCURRENCY);
	const summary = {
		processed: results.length,
		archived: results.filter((r) => r.status === "archived").length,
		queued: results.filter((r) => r.status === "queued").length,
		abandoned: results.filter((r) => r.status === "abandoned").length,
		deferred: results.filter((r) => r.status === "deferred").length,
		failed_unsupported: results.filter((r) => r.status === "failed_unsupported").length,
		total_bytes: results.reduce((sum, r) => sum + (r.bytes ?? 0), 0),
	};
	console.log("[archive-videos]", JSON.stringify(summary));
	return NextResponse.json(summary);
}
```

- [ ] **Step 2: Verify `hasInternalSecret` exists**

```bash
grep -rn "hasInternalSecret" lib/auth/ 2>&1 | head -5
```

If absent, locate the equivalent helper (CLAUDE.md mentions `hasInternalSecret()`). If not found by that name, scan `lib/auth/` for the function that validates `Authorization: Bearer ${CRON_SECRET}` and use its actual exported name.

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/archive-videos/route.ts
git commit -m "feat(cron): archive-videos worker — batched, concurrent, idempotent"
```

---

## Task 9: vercel.json — Cron Registration + Function Config

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add function config**

In `vercel.json` under `functions`, add:

```json
"app/api/cron/archive-videos/route.ts": {
  "maxDuration": 300,
  "memory": 1024
}
```

(Verify the existing JSON is well-formed; the entry above appends as another sibling.)

- [ ] **Step 2: Add two cron entries**

In `vercel.json` under `crons`, append:

```json
{ "path": "/api/cron/archive-videos", "schedule": "0 19 * * *" },
{ "path": "/api/cron/archive-videos", "schedule": "0 1 * * *" }
```

(`0 19 * * *` = JST 04:00 = primary pass after live programming ends. `0 1 * * *` = JST 10:00 = retry pass.)

- [ ] **Step 3: Sync workflow manifest**

Check whether the repo's `public/.well-known/workflow/v1/manifest.json` (already in git status as modified) lists crons. If it does, add the two new entries there matching the pattern of existing ones. If not, skip.

- [ ] **Step 4: Validate JSON**

```bash
node -e "JSON.parse(require('node:fs').readFileSync('vercel.json','utf-8')); console.log('vercel.json OK')"
```

Expected: `vercel.json OK`.

- [ ] **Step 5: Commit**

```bash
git add vercel.json public/.well-known/workflow/v1/manifest.json
git commit -m "feat(vercel): register archive-videos cron at JST 04:00 + 10:00"
```

---

## Task 10: Historical Backfill Script

**Files:**
- Create: `scripts/backfill-broadcast-products.ts`
- Modify: `package.json` (add `backfill:broadcast-products` script)

- [ ] **Step 1: Write the backfill**

Create `scripts/backfill-broadcast-products.ts`:

```ts
/**
 * One-shot historical backfill — produces broadcast_products rows for every
 * already-stored broadcasts row that matches its channel's whitelist. Also
 * sets video_status='queued' (QVC, when video_url resolvable) or
 * 'failed_unsupported' (ShopCh).
 *
 * Idempotent: re-runs upsert on (broadcast_id, product_id). Safe to re-run.
 *
 * Run: tsx --env-file=.env.local scripts/backfill-broadcast-products.ts
 */
import { getServiceClient } from "../lib/supabase";
import { loadWhitelist, isAllowed } from "../lib/broadcasts/category-filter";
import {
	buildProgramId,
	fetchShopChSlotMetadata,
} from "../lib/broadcasts/shopch-json";
import {
	buildQvcSnapshotRows,
	buildShopChSnapshotRows,
	pickBrandFromQvcProducts,
	type QvcProductLike,
} from "../lib/broadcasts/snapshot-enrichment";

const PAGE_SIZE = 200;

async function main() {
	const sb = getServiceClient();
	const wl = await loadWhitelist();

	console.log("[1/2] QVC backfill");
	let qvcOffset = 0;
	let qvcUpdated = 0;
	while (true) {
		const { data, error } = await sb
			.from("broadcasts")
			.select("id, channel, air_date, start_time, category, product_ids")
			.eq("channel", "qvc")
			.not("product_ids", "is", null)
			.order("id")
			.range(qvcOffset, qvcOffset + PAGE_SIZE - 1);
		if (error) throw error;
		if (!data || data.length === 0) break;
		for (const slot of data as Array<{ id: string; channel: "qvc"; air_date: string; start_time: string; category: string | null; product_ids: string[] | null }>) {
			if (!isAllowed(wl, slot.channel, slot.category)) continue;
			const ids = slot.product_ids ?? [];
			if (ids.length === 0) continue;
			const { data: products } = await sb
				.from("qvc_products")
				.select("id, name, image_url, price_text, brand, original_price_jpy, sale_label, video_url")
				.in("id", ids);
			const qvcProducts = (products ?? []) as Array<QvcProductLike & { video_url: string | null }>;
			const rows = buildQvcSnapshotRows(slot.id, ids, qvcProducts);
			if (rows.length > 0) {
				await sb.from("broadcast_products").upsert(rows, { onConflict: "broadcast_id,product_id" });
			}
			const brand = pickBrandFromQvcProducts(ids, qvcProducts);
			const anyVideo = qvcProducts.some((p) => p.video_url);
			await sb.from("broadcasts").update({
				brand_name: brand,
				video_status: anyVideo ? "queued" : "deferred",
			}).eq("id", slot.id);
			qvcUpdated++;
		}
		console.log(`  qvc [${qvcOffset + data.length}] updated=${qvcUpdated}`);
		if (data.length < PAGE_SIZE) break;
		qvcOffset += PAGE_SIZE;
	}

	console.log("\n[2/2] ShopCh backfill");
	let shOffset = 0;
	let shUpdated = 0;
	let shSkippedOlder = 0;
	while (true) {
		const { data, error } = await sb
			.from("broadcasts")
			.select("id, channel, air_date, start_time, category")
			.eq("channel", "shopch")
			.order("id")
			.range(shOffset, shOffset + PAGE_SIZE - 1);
		if (error) throw error;
		if (!data || data.length === 0) break;
		for (const slot of data as Array<{ id: string; channel: "shopch"; air_date: string; start_time: string; category: string | null }>) {
			if (!isAllowed(wl, slot.channel, slot.category)) continue;
			const pid = buildProgramId(slot.air_date, slot.start_time);
			const meta = await fetchShopChSlotMetadata(pid);
			if (meta.products.length === 0) {
				shSkippedOlder++;
				continue;
			}
			const rows = buildShopChSnapshotRows(slot.id, meta.products);
			await sb.from("broadcast_products").upsert(rows, { onConflict: "broadcast_id,product_id" });
			await sb.from("broadcasts").update({
				brand_name: meta.brandName,
				brand_code: meta.brandCode,
				video_status: "failed_unsupported",
			}).eq("id", slot.id);
			shUpdated++;
		}
		console.log(`  shopch [${shOffset + data.length}] updated=${shUpdated} skipped=${shSkippedOlder}`);
		if (data.length < PAGE_SIZE) break;
		shOffset += PAGE_SIZE;
	}

	console.log(`\nDone. qvc updated=${qvcUpdated}, shopch updated=${shUpdated}, shopch skipped=${shSkippedOlder}`);
}

void main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add to package.json**

```json
"backfill:broadcast-products": "tsx --env-file=.env.local scripts/backfill-broadcast-products.ts",
```

- [ ] **Step 3: Run the backfill**

```bash
npm run backfill:broadcast-products
```

Expected: prints per-page progress, final line `qvc updated=~370 shopch updated=~340 shopch skipped=~30` (the ~30 ShopCh skip count corresponds to slots older than ~30 days that the JSON endpoint 403s).

- [ ] **Step 4: Verify counts**

```bash
node -e "require('dotenv').config({path:'.env.local'}); const {createClient}=require('@supabase/supabase-js'); const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY); (async()=>{ const {count}=await sb.from('broadcast_products').select('*',{count:'exact',head:true}); console.log('broadcast_products rows:',count); const {data}=await sb.from('broadcasts').select('video_status').not('video_status','is',null); const t=new Map(); for(const r of data||[]) t.set(r.video_status,(t.get(r.video_status)||0)+1); console.log('video_status tally:',Object.fromEntries(t)); })();"
```

Expected: `broadcast_products rows: ~2500-3500` (370 QVC × ~6 + 340 ShopCh × ~6). `video_status` tally shows `queued` count, `failed_unsupported` for ShopCh.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-broadcast-products.ts package.json
git commit -m "feat(backfill): broadcast_products historical fill + video_status seeding"
```

---

## Task 11: Smoke Test One Slot End-to-End

**Files:**
- Create: `scripts/smoke-archive-one.ts`
- Modify: `package.json` (add `smoke:archive-one`)

- [ ] **Step 1: Write the smoke script**

Create `scripts/smoke-archive-one.ts`:

```ts
/**
 * Manual one-shot smoke for the archival pipeline. Picks the newest QVC
 * slot in `queued` status with attempts=0 and a resolvable video_url, runs
 * archiveOne() against it, then prints the resulting broadcasts row.
 */
import { getServiceClient } from "../lib/supabase";
import { archiveOne, type QueuedSlot } from "../lib/broadcasts/video-archival";

async function main() {
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("broadcasts")
		.select("id, channel, air_date, start_time, product_ids, video_download_attempts")
		.eq("channel", "qvc")
		.eq("video_status", "queued")
		.eq("video_download_attempts", 0)
		.not("product_ids", "is", null)
		.order("air_date", { ascending: false })
		.limit(1);
	if (error || !data || data.length === 0) {
		console.error("No queued QVC slot available for smoke");
		process.exit(1);
	}
	const slot = data[0] as QueuedSlot;
	console.log("Smoke target:", slot.id, slot.channel, slot.air_date, slot.start_time);
	const result = await archiveOne(slot);
	console.log("\nResult:", result);
	const { data: row } = await sb
		.from("broadcasts")
		.select("video_status, archived_video_s3, video_size_bytes, video_duration_sec, video_error")
		.eq("id", slot.id)
		.single();
	console.log("\nFinal row:", row);
}

void main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add to package.json**

```json
"smoke:archive-one": "tsx --env-file=.env.local scripts/smoke-archive-one.ts",
```

- [ ] **Step 3: Confirm R2 env vars are in `.env.local`**

```bash
grep -E "^R2_" .env.local | wc -l
```

Expected: `5` (all five R2_* env vars set). If less, stop and request the operator add them.

- [ ] **Step 4: Run smoke**

```bash
npm run smoke:archive-one
```

Expected: prints "Result: { status: 'archived', bytes: <some_number> }" and the final row shows `video_status: 'archived'`, `archived_video_s3: 'videos/qvc/YYYY-MM-DD/HH-MM-SS--xxxxxxxx.mp4'`, non-null bytes/duration. On Cloudflare R2 dashboard, the object is listed at that key.

- [ ] **Step 5: Verify playback**

Compose the public URL: `$R2_PUBLIC_BASE_URL/<key from previous step>`. Open in a browser or HEAD-check:

```bash
curl -I "$R2_PUBLIC_BASE_URL/videos/qvc/.../...mp4"
```

Expected: `HTTP/2 200`, `content-type: video/mp4`.

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke-archive-one.ts package.json
git commit -m "test(broadcasts): manual smoke for one-slot video archival"
```

---

## Task 12: UI — ▶ Icon + Status on BroadcastListItem

**Files:**
- Modify: `components/broadcasts/BroadcastListItem.tsx`

- [ ] **Step 1: Read the current component**

```bash
cat components/broadcasts/BroadcastListItem.tsx
```

Identify the `Broadcast` interface and the JSX area where action icons (if any) appear.

- [ ] **Step 2: Extend the `Broadcast` interface**

Add the new fields. Find the existing `interface Broadcast` declaration in the file and add:

```ts
	archived_video_s3?: string | null;
	video_status?: string | null;
	brand_name?: string | null;
	brand_code?: string | null;
```

- [ ] **Step 3: Add the icon JSX**

Locate the right edge of the list item layout (where existing icons like external-link live, or near the program title). Insert:

```tsx
{broadcast.archived_video_s3 && (
  <button
    type="button"
    onClick={(e) => { e.stopPropagation(); onPlayVideo?.(broadcast); }}
    className="inline-flex items-center justify-center w-6 h-6 rounded text-gray-600 hover:bg-gray-100"
    aria-label={t("playArchive")}
  >
    <Play size={14} />
  </button>
)}
{!broadcast.archived_video_s3 &&
  (broadcast.video_status === "queued" || broadcast.video_status === "downloading") && (
  <Loader2 size={14} className="animate-spin text-gray-400" aria-label={t("archiving")} />
)}
```

Add imports at the top:
```ts
import { Play, Loader2 } from "lucide-react";
```

Extend the component props with `onPlayVideo?: (b: Broadcast) => void;` and thread it through where the component is used (`BroadcastCalendar`, `UnifiedDayDetailPanel`).

- [ ] **Step 4: Add i18n strings**

In `messages/ja.json` and `messages/en.json` under `broadcasts`, add:

```json
"playArchive": "アーカイブを再生",  // ja
"archiving": "アーカイブ中"           // ja
```
```json
"playArchive": "Play archive",       // en
"archiving": "Archiving"              // en
```

- [ ] **Step 5: Update the parent query selects**

In `app/[locale]/(market)/broadcasts/page.tsx`, line 65 (the `select(...)` string for broadcasts), append the new columns:
```ts
"id,channel,air_date,start_time,program_title,presenter,description,thumbnail_url,source_url,product_ids,category,archived_video_s3,video_status,brand_name,brand_code"
```

Same for `app/api/broadcasts/route.ts` line 81-ish.

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add components/broadcasts/BroadcastListItem.tsx app/[locale]/\(market\)/broadcasts/page.tsx app/api/broadcasts/route.ts messages/ja.json messages/en.json
git commit -m "feat(ui): play-archive icon + status indicator on broadcast list item"
```

---

## Task 13: UI — Broadcast Video Modal + Products API

**Files:**
- Create: `app/api/broadcasts/[id]/products/route.ts`
- Create: `components/broadcasts/BroadcastVideoModal.tsx`
- Modify: `components/broadcasts/UnifiedDayDetailPanel.tsx` (wire `onPlayVideo` → open modal)

- [ ] **Step 1: Read endpoint for broadcast_products**

Create `app/api/broadcasts/[id]/products/route.ts`:

```ts
import { requireUser } from "@/lib/auth/require-user";
import { NextResponse, type NextRequest } from "next/server";

export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { id } = await params;
	const { data, error } = await auth.sb
		.from("broadcast_products")
		.select("product_id, position, name, image_url, price_jpy, original_price_jpy, discount_rate, sale_label, tax_incl, in_stock_at_capture, source, captured_at")
		.eq("broadcast_id", id)
		.order("position", { ascending: true });
	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
	return NextResponse.json({ products: data ?? [] }, {
		headers: { "Cache-Control": "private, max-age=300" },
	});
}
```

- [ ] **Step 2: Modal component**

Create `components/broadcasts/BroadcastVideoModal.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";

interface BroadcastProduct {
	product_id: string;
	position: number;
	name: string | null;
	image_url: string | null;
	price_jpy: number | null;
	original_price_jpy: number | null;
	discount_rate: number | null;
	sale_label: string | null;
	in_stock_at_capture: boolean | null;
	source: "qvc" | "shopch";
}

interface Props {
	broadcastId: string | null;
	videoKey: string | null;
	brandName: string | null;
	onClose: () => void;
}

export default function BroadcastVideoModal({
	broadcastId,
	videoKey,
	brandName,
	onClose,
}: Props) {
	const t = useTranslations("broadcasts");
	const [products, setProducts] = useState<BroadcastProduct[]>([]);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (!broadcastId) return;
		setLoading(true);
		fetch(`/api/broadcasts/${broadcastId}/products`)
			.then((r) => r.json())
			.then((j) => setProducts(j.products ?? []))
			.finally(() => setLoading(false));
	}, [broadcastId]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	if (!broadcastId || !videoKey) return null;

	const videoUrl = `${process.env.NEXT_PUBLIC_R2_PUBLIC_BASE_URL ?? ""}/${videoKey}`;

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4" role="dialog" aria-modal="true">
			<button type="button" className="absolute inset-0 bg-black/60" onClick={onClose} aria-label="close" />
			<div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[calc(100vh-6rem)] overflow-y-auto">
				<div className="sticky top-0 bg-white border-b px-6 py-3 flex items-center justify-between">
					<h2 className="text-base font-semibold">
						{brandName ?? t("archivedBroadcast")}
					</h2>
					<button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg" aria-label="close">
						<X size={18} />
					</button>
				</div>
				<div className="px-6 pb-6">
					<video controls preload="metadata" className="w-full rounded-lg bg-black" src={videoUrl} />
					<h3 className="mt-6 mb-3 text-sm font-semibold text-gray-700">
						{t("productsInBroadcast", { n: products.length })}
					</h3>
					{loading ? (
						<div className="text-sm text-gray-500">{t("loading")}</div>
					) : (
						<ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
							{products.map((p) => (
								<li key={p.product_id} className="flex gap-3 border rounded-lg p-3">
									{p.image_url && (
										<img src={p.image_url} alt={p.name ?? ""} className="w-20 h-20 object-cover rounded" />
									)}
									<div className="flex-1 min-w-0">
										<div className="text-sm text-gray-900 truncate">{p.name ?? p.product_id}</div>
										<div className="text-sm">
											{p.price_jpy ? `¥${p.price_jpy.toLocaleString("ja-JP")}` : "—"}
											{p.original_price_jpy && p.original_price_jpy > (p.price_jpy ?? 0) && (
												<span className="ml-2 text-xs text-gray-400 line-through">¥{p.original_price_jpy.toLocaleString("ja-JP")}</span>
											)}
											{p.discount_rate != null && (
												<span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700">{p.discount_rate}% OFF</span>
											)}
										</div>
										{p.sale_label && <div className="text-xs text-gray-500">{p.sale_label}</div>}
										{p.in_stock_at_capture === false && (
											<div className="text-xs text-gray-500">{t("soldOut")}</div>
										)}
									</div>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</div>
	);
}
```

- [ ] **Step 3: Add i18n strings**

Append to `messages/ja.json` `broadcasts`:
```json
"archivedBroadcast": "アーカイブ放送",
"productsInBroadcast": "出演商品 ({n}件)",
"soldOut": "完売"
```
And to `messages/en.json` `broadcasts`:
```json
"archivedBroadcast": "Archived broadcast",
"productsInBroadcast": "Products ({n})",
"soldOut": "Sold out"
```

- [ ] **Step 4: Add `NEXT_PUBLIC_R2_PUBLIC_BASE_URL` to env template**

Update `.env.example` if it exists:
```
NEXT_PUBLIC_R2_PUBLIC_BASE_URL=https://archive.example.com
```

- [ ] **Step 5: Wire modal into UnifiedDayDetailPanel**

In `components/broadcasts/UnifiedDayDetailPanel.tsx`, add modal state:

```tsx
const [modalBroadcast, setModalBroadcast] = useState<Broadcast | null>(null);
```

Pass `onPlayVideo={setModalBroadcast}` to each `<BroadcastListItem>`.

At the end of the component JSX, before the closing `</div>`:

```tsx
<BroadcastVideoModal
	broadcastId={modalBroadcast?.id ?? null}
	videoKey={modalBroadcast?.archived_video_s3 ?? null}
	brandName={modalBroadcast?.brand_name ?? null}
	onClose={() => setModalBroadcast(null)}
/>
```

Import: `import BroadcastVideoModal from "./BroadcastVideoModal";`

- [ ] **Step 6: Manual UI check**

```bash
npm run dev
```

Navigate to `/ja/broadcasts`, pick a date with an archived QVC slot, click ▶. Modal opens, video plays, product list renders below. ESC closes.

- [ ] **Step 7: Commit**

```bash
git add app/api/broadcasts/\[id\]/products/route.ts components/broadcasts/BroadcastVideoModal.tsx components/broadcasts/UnifiedDayDetailPanel.tsx messages/ja.json messages/en.json
git commit -m "feat(ui): broadcast video modal with archived video + product snapshot list"
```

---

## Task 14: Admin Archive-Status Page + Force-Retry Endpoint

**Files:**
- Create: `app/api/admin/broadcasts/[id]/retry-archive/route.ts`
- Create: `app/[locale]/(admin)/admin/archive-status/page.tsx`

- [ ] **Step 1: Force-retry endpoint**

Create `app/api/admin/broadcasts/[id]/retry-archive/route.ts`:

```ts
import { requireUser } from "@/lib/auth/require-user";
import { NextResponse, type NextRequest } from "next/server";

export async function POST(
	req: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await requireUser(["admin"]);
	if ("error" in auth) return auth.error;
	const { id } = await params;
	const { error } = await auth.sb
		.from("broadcasts")
		.update({
			video_status: "queued",
			video_download_attempts: 0,
			video_error: null,
		})
		.eq("id", id);
	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Admin dashboard page**

Create `app/[locale]/(admin)/admin/archive-status/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/require-user";
import { localePath } from "@/lib/i18n/locale-path";

export const dynamic = "force-dynamic";

interface PageProps {
	params: Promise<{ locale: string }>;
}

export default async function ArchiveStatusPage({ params }: PageProps) {
	const { locale } = await params;
	const auth = await requireUser(["admin"]);
	if ("error" in auth) redirect(localePath(locale, "/login"));
	const sb = auth.sb;

	const { data: tally } = await sb
		.from("broadcasts")
		.select("video_status")
		.not("video_status", "is", null);
	const counts = new Map<string, number>();
	for (const r of (tally ?? []) as { video_status: string }[]) {
		counts.set(r.video_status, (counts.get(r.video_status) ?? 0) + 1);
	}

	const { data: failures } = await sb
		.from("broadcasts")
		.select("id, channel, air_date, start_time, video_status, video_download_attempts, video_error")
		.in("video_status", ["abandoned", "deferred"])
		.order("air_date", { ascending: false })
		.limit(50);

	const { data: sizes } = await sb
		.from("broadcasts")
		.select("video_size_bytes")
		.eq("video_status", "archived");
	const totalBytes = (sizes ?? []).reduce(
		(sum, r: { video_size_bytes: number | null }) => sum + (r.video_size_bytes ?? 0),
		0,
	);
	const r2CostUsd = ((totalBytes / 1e9) * 0.015).toFixed(2);

	return (
		<div className="max-w-5xl mx-auto p-6">
			<h1 className="text-2xl font-semibold mb-4">Archive Pipeline Status</h1>
			<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
				{[...counts.entries()].map(([k, v]) => (
					<div key={k} className="border rounded p-3">
						<div className="text-xs text-gray-500">{k}</div>
						<div className="text-2xl font-semibold">{v.toLocaleString("ja-JP")}</div>
					</div>
				))}
				<div className="border rounded p-3 bg-gray-50">
					<div className="text-xs text-gray-500">Total archived bytes</div>
					<div className="text-lg font-semibold">{(totalBytes / 1e9).toFixed(2)} GB</div>
					<div className="text-xs text-gray-500">≈ ${r2CostUsd} / month</div>
				</div>
			</div>
			<h2 className="text-lg font-semibold mb-2">Recent failures</h2>
			<table className="w-full text-sm">
				<thead className="bg-gray-50 border-b">
					<tr>
						<th className="text-left px-3 py-2">Date</th>
						<th className="text-left px-3 py-2">Channel</th>
						<th className="text-left px-3 py-2">Status</th>
						<th className="text-left px-3 py-2">Attempts</th>
						<th className="text-left px-3 py-2">Error</th>
						<th className="text-left px-3 py-2"></th>
					</tr>
				</thead>
				<tbody>
					{(failures ?? []).map((f: { id: string; channel: string; air_date: string; start_time: string; video_status: string; video_download_attempts: number | null; video_error: string | null }) => (
						<tr key={f.id} className="border-b">
							<td className="px-3 py-2">{f.air_date} {f.start_time}</td>
							<td className="px-3 py-2">{f.channel}</td>
							<td className="px-3 py-2">{f.video_status}</td>
							<td className="px-3 py-2">{f.video_download_attempts ?? 0}</td>
							<td className="px-3 py-2 text-xs text-gray-600">{f.video_error?.slice(0, 80)}</td>
							<td className="px-3 py-2">
								<RetryButton broadcastId={f.id} />
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

// (Client) RetryButton — separate file or inline 'use client' island.
// For brevity, inline as a client component.
import RetryButton from "./RetryButton";
```

And the client island `app/[locale]/(admin)/admin/archive-status/RetryButton.tsx`:

```tsx
"use client";
import { useState } from "react";

export default function RetryButton({ broadcastId }: { broadcastId: string }) {
	const [pending, setPending] = useState(false);
	const onClick = async () => {
		setPending(true);
		await fetch(`/api/admin/broadcasts/${broadcastId}/retry-archive`, { method: "POST" });
		window.location.reload();
	};
	return (
		<button type="button" disabled={pending} onClick={onClick}
		  className="text-xs px-2 py-1 rounded border hover:bg-gray-50 disabled:opacity-50">
			{pending ? "..." : "Retry"}
		</button>
	);
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/broadcasts/\[id\]/retry-archive/route.ts "app/[locale]/(admin)/admin/archive-status/"
git commit -m "feat(admin): archive pipeline status dashboard + force-retry endpoint"
```

---

## Task 15: CLAUDE.md Update + Final Wrap

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append documentation paragraph**

Open `CLAUDE.md` and find the "Broadcast Calendar" section. After the Phase 1-D paragraph, add:

```markdown
- Competitive snapshot archival (2026-05-19, `docs/superpowers/specs/2026-05-19-competitive-snapshot-archival-design.md`): whitelist-matching slots are enriched at scrape time with a per-product detail snapshot in `broadcast_products` (name/image/price/original_price/discount_rate/sale_label/in_stock_at_capture/brand). QVC video is archived to Cloudflare R2 by a separate `archive-videos` cron (JST 04:00 + 10:00) — `ffmpeg -c copy` streams the QVC m3u8 into a multipart MP4 upload. Storage key: `videos/{channel}/{air_date}/{start_time}--{broadcast_id_short}.mp4`. ShopCh video is intentionally deferred (m3u8 hosts return 403 without auth — separate PoC). UI: `BroadcastListItem` shows ▶ when `archived_video_s3` is set; clicking opens `BroadcastVideoModal` with the video + per-product list. Admin observability: `/admin/archive-status`. R2 env vars: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` (also `NEXT_PUBLIC_R2_PUBLIC_BASE_URL` for client video src).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): document competitive snapshot archival pipeline"
```

- [ ] **Step 3: Open PR**

```bash
git push -u origin <branch>
gh pr create --title "feat: competitive snapshot archival (QVC video → R2 + per-slot product snapshots)" --body "$(cat <<'EOF'
## Summary
- New `broadcast_products` table captures a point-in-time per-product snapshot (name/image/price/discount/stock/brand) for every whitelist-matching QVC and ShopCh broadcast slot.
- QVC broadcast video is archived to Cloudflare R2 via a new `archive-videos` cron (ffmpeg copy → multipart upload, 4 concurrent workers, 8 slots/run, JST 04:00 + 10:00).
- ShopCh video archival is explicitly deferred; ShopCh still gets the metadata snapshot.
- UI: ▶ button on each archived slot opens a modal with the video + product snapshot list. Admin `/admin/archive-status` for pipeline health.
- Historical backfill ran across all existing whitelist-matching rows.

Spec: `docs/superpowers/specs/2026-05-19-competitive-snapshot-archival-design.md`
Plan: `docs/superpowers/plans/2026-05-19-competitive-snapshot-archival.md`

## Test plan
- [x] `npm run test:qvc-brand`
- [x] `npm run test:shopch-products`
- [x] `npm run test:snapshot-enrichment`
- [x] `npx tsc --noEmit` clean
- [x] `npm run smoke:archive-one` archived a real slot end-to-end
- [x] Manual: opened modal on `/ja/broadcasts`, verified playback + product list
- [x] Manual: opened `/ja/admin/archive-status`, verified counts + force-retry

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage** (cross-checked against `2026-05-19-competitive-snapshot-archival-design.md`):

- §4 architecture (two-stage pipeline) → Task 5 + 8
- §5A broadcasts brand columns → Task 1
- §5B qvc_products discount columns → Task 1 + 2
- §5C broadcast_products table + RLS → Task 1
- §6A snapshot enrichment (QVC + ShopCh paths) → Task 4 (pure) + Task 5 (wiring)
- §6B archival worker → Task 7 (module) + Task 8 (route)
- §6C parser extensions → Tasks 2 + 3
- §7 R2 backend → Task 6
- §8 error handling state machine → Task 7 (statuses), Task 14 (admin force-retry)
- §9A ▶ icon → Task 12
- §9B video modal → Task 13
- §9C admin dashboard → Task 14
- §10 migration + backfill sequence → Task 1 → 2 → 3 → 4 → 5 → 10 → 11
- §11 tests → Tasks 2, 3, 4 cover the parser/enrichment layers (fixture-style scripts matching repo convention)
- §12 observability → Task 14 dashboard + structured log in Task 8
- §13 future work (ShopCh video, transcription) → out of scope, deliberately preserved as future

No spec sections are unimplemented.

**Placeholder scan**: searched for "TBD", "TODO", "implement later" — none present in this plan. Search for "Similar to" / "as above" — none. Every test step has code; every implementation step has code.

**Type consistency**: `BroadcastProductRow` shape in Task 4 matches the SQL columns in Task 1 (column-by-column verified). `archiveOne` return type in Task 7 matches what Task 8's route summary reads. `Broadcast` interface extension in Task 12 matches the `select(...)` strings updated in the same task. `ShopChProductSnapshot` in Task 3 is consumed in Task 4 — names match (`productId` not `product_id` — interface uses camelCase, DB row uses snake_case; transition happens inside `buildShopChSnapshotRows`).

Plan is internally consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-competitive-snapshot-archival.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task with the spec + plan as context, review the diff between tasks, fast iteration. Best for plans of this size (15 tasks across schema/parsers/cron/UI).

**2. Inline Execution** — Execute tasks in this session using executing-plans skill, batch execution with checkpoints. Saves a context switch but the session grows long.

Which approach?
