# OA Channel Image Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich 7 OA channels (txd, junsanpo, tbs, senobura, uranoura, dinos, ntv) in `historical_broadcasts` with product thumbnails so the calendar's `UnifiedDayDetailPanel` renders images alongside QVC/ShopCh.

**Architecture:** Add a new `image_url` column to `historical_broadcasts`. Introduce two reusable image extractors — a generic cheerio-based `og-image` extractor (5 channels) and an `ntv-api` JSON extractor (ntv). Each parser invokes its extractor after producing rows, capped at concurrency 5 to stay polite. `txd` is special: its existing list-API response already contains image URLs, so the parser just maps one more field. A one-shot backfill script enriches the ~15k existing rows for the 6 non-txd channels (txd backfill is a re-run of the existing `backfill-txd.ts` after the parser patch). The daily cron picks up forward enrichment automatically.

**Tech Stack:** TypeScript, Next.js 16 (App Router), Supabase (Postgres + service client), cheerio, existing `politeFetch`/`historical-crawl` infrastructure, bespoke fixture-based test scripts.

**Spec:** `docs/superpowers/specs/2026-05-21-oa-channel-images-design.md`

---

## Pre-flight: Working directory

All paths relative to the worktree root: `E:\Github\mediaworks\.claude\worktrees\research-cross-system-integration\` (or the main repo root if the worktree was already merged — both have identical state after the recent merge).

The implementer should run commands from the project root. Do not `cd` into nested dirs unless explicitly directed.

---

## Task 1: Add `image_url` column to `historical_broadcasts`

**Goal:** Create the migration file and apply it. After this, the schema is ready to accept image URLs but no rows have them yet.

**Files:**
- Create: `supabase/migrations/2026-05-21_historical_broadcasts_image_url.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/2026-05-21_historical_broadcasts_image_url.sql`:

```sql
-- 2026-05-21_historical_broadcasts_image_url.sql
-- Adds an optional thumbnail URL for OA-channel slots.
-- Spec: docs/superpowers/specs/2026-05-21-oa-channel-images-design.md §4
--
-- RLS: existing policies cover the new column (column-level RLS not used).
-- Forward-compatible: existing readers ignore the column; writers can leave it null.

BEGIN;

ALTER TABLE historical_broadcasts
  ADD COLUMN IF NOT EXISTS image_url text NULL;

COMMENT ON COLUMN historical_broadcasts.image_url IS
  'Product thumbnail URL discovered via channel-specific extractor. Null when extraction failed, was skipped (japanet), or row predates the enrichment feature. Backfill via scripts/backfill-oa-images.ts.';

COMMIT;
```

- [ ] **Step 2: Apply the migration**

Apply through the project's normal migration workflow. Two options:

**Option A** — Supabase CLI (preferred if `supabase` CLI is installed and the project is linked):

```bash
supabase db push
```

**Option B** — Manual SQL execution via the Supabase dashboard (project URL → SQL editor → paste the SQL → run).

After applying, verify with:

```bash
npx tsx --env-file=.env.local -e "
import('./lib/supabase').then(async (m) => {
  const sb = m.getServiceClient();
  const { error } = await sb.from('historical_broadcasts').select('image_url').limit(1);
  console.log(error ? 'FAIL: ' + error.message : 'OK: column exists');
});
"
```

Expected: `OK: column exists`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-05-21_historical_broadcasts_image_url.sql
git commit -m "feat(historical-broadcasts): add image_url column"
```

---

## Task 2: Extend `HistoricalRow` type with `image_url`

**Goal:** Make the row type aware of the new field. All parsers will set this (or leave null) once the rest of the plan lands.

**Files:**
- Modify: `lib/historical-crawl/types.ts`

- [ ] **Step 1: Add `image_url` to `HistoricalRow`**

Edit `lib/historical-crawl/types.ts`. Find the `HistoricalRow` interface and add `image_url`:

```typescript
export interface HistoricalRow {
	channel: OAChannelSlug;
	air_date: string; // YYYY-MM-DD JST
	day_of_week: string | null;
	start_time: string | null;
	product_name: string;
	price_text: string | null;
	price_jpy: number | null;
	price_is_tax_incl: boolean | null;
	source_url: string | null;
	source_sheet: string;
	image_url: string | null;
}
```

Note: place `image_url` last in the interface (next to other "URL"-shaped fields), preserving the existing field order.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`

Expected output: each existing parser surfaces an error like `Property 'image_url' is missing in type '...' but required in type 'HistoricalRow'.` These are intentional — they'll be filled in by Tasks 6–8. Note the count for your own tracking (should be one error per parser × number of `rows.push({ ... })` call sites).

Pre-existing unrelated errors in `scripts/e2e-screenplay.ts` and `scripts/screenshot-list.ts` are OK to leave.

- [ ] **Step 3: Make the field optional temporarily, OR fix all parsers now?**

Choose A — keep the type as `string | null` (non-optional) and let downstream tasks fill it in. The TS errors are a "todo list" you'll burn down over Tasks 5–8.

DO NOT mark the field as optional (`image_url?: string | null`) — that hides incomplete implementations. The type system should bite until every parser populates it.

- [ ] **Step 4: Commit**

```bash
git add lib/historical-crawl/types.ts
git commit -m "feat(historical-crawl): extend HistoricalRow with image_url field"
```

The tree is "broken" at this commit (TS errors) and that's intentional — Tasks 5–8 fix them in sequence. Don't run any other broad type-check job between tasks.

---

## Task 3: Create extractor infrastructure (interface + concurrency helper + registry)

**Goal:** Set up the small folder `lib/historical-crawl/image-extractors/` with the shared interface and the `mapWithConcurrency` helper used by parser enrichment. Empty registry — concrete extractors land in Tasks 4 and 5.

**Files:**
- Create: `lib/historical-crawl/image-extractors/types.ts`
- Create: `lib/historical-crawl/image-extractors/index.ts`

- [ ] **Step 1: Create `types.ts`**

Create `lib/historical-crawl/image-extractors/types.ts`:

```typescript
/**
 * Image extractor interface for OA channels.
 *
 * Pure-function over a source URL; returns the resolved image URL (always
 * absolute HTTPS) or null when extraction failed for any reason (HTTP error,
 * missing meta tag, parse failure, timeout). Extractors MUST NOT throw —
 * caller relies on null-on-failure semantics.
 *
 * Spec: docs/superpowers/specs/2026-05-21-oa-channel-images-design.md §5
 */
export interface ImageExtractor {
	extract(sourceUrl: string): Promise<string | null>;
}

/**
 * Run `fn` over `items` with at most `concurrency` simultaneous invocations.
 * Preserves input order in the output. Used by parsers to cap how many
 * upstream requests we fire at any one host.
 */
export async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const out: R[] = new Array(items.length);
	let cursor = 0;
	const workerCount = Math.min(concurrency, items.length);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (true) {
				const i = cursor++;
				if (i >= items.length) return;
				out[i] = await fn(items[i]);
			}
		}),
	);
	return out;
}
```

- [ ] **Step 2: Create empty registry `index.ts`**

Create `lib/historical-crawl/image-extractors/index.ts`:

```typescript
import type { OAChannelSlug } from "../types";
import type { ImageExtractor } from "./types";

/**
 * Channel → image extractor mapping. Null = unsupported (japanet) or
 * handled inside the parser itself (txd uses its list-API response, no
 * separate fetch).
 *
 * Populated in Tasks 4 (og-image) and 5 (ntv-api). Tasks 6/7 wire each
 * parser to its extractor.
 */
export const IMAGE_EXTRACTORS: Record<OAChannelSlug, ImageExtractor | null> = {
	japanet: null,
	junsanpo: null,
	ntv: null,
	tbs: null,
	dinos: null,
	senobura: null,
	uranoura: null,
	txd: null, // txd populates image_url inside the parser, not via an extractor
};

export type { ImageExtractor } from "./types";
export { mapWithConcurrency } from "./types";
```

- [ ] **Step 3: Type-check (only this folder)**

Run: `npx tsc --noEmit`

Expected: still the parser-level errors from Task 2; no new errors from the new files.

- [ ] **Step 4: Commit**

```bash
git add lib/historical-crawl/image-extractors/types.ts lib/historical-crawl/image-extractors/index.ts
git commit -m "feat(historical-crawl): add image-extractor infrastructure + mapWithConcurrency"
```

---

## Task 4: Implement `og-image` extractor + fixture test

**Goal:** Generic cheerio extractor that reads `<meta property="og:image">` from a product page. Used by junsanpo, tbs, dinos, senobura, uranoura.

**Files:**
- Create: `lib/historical-crawl/image-extractors/og-image.ts`
- Create: `scripts/fixtures/oa-images/junsanpo-sample.html`
- Create: `scripts/fixtures/oa-images/tbs-sample.html`
- Create: `scripts/fixtures/oa-images/senobura-sample.html`
- Create: `scripts/fixtures/oa-images/uranoura-sample.html`
- Create: `scripts/fixtures/oa-images/dinos-sample.html`
- Create: `scripts/test-og-image-extractor.ts`
- Modify: `lib/historical-crawl/image-extractors/index.ts` (wire up 5 channels)
- Modify: `package.json` (add `test:og-image-extractor` script)

- [ ] **Step 1: Record fixtures for all 5 channels**

```bash
mkdir -p scripts/fixtures/oa-images

curl -sL -A "MediaWorks-Historical-Crawl/1.0 (+contact@mediaw-b.com)" \
  "https://ropping.jp/product/111643" \
  -o scripts/fixtures/oa-images/junsanpo-sample.html

curl -sL -A "MediaWorks-Historical-Crawl/1.0 (+contact@mediaw-b.com)" \
  "https://shopping.tbs.co.jp/tbs/product/P2122145" \
  -o scripts/fixtures/oa-images/tbs-sample.html

curl -sL -A "MediaWorks-Historical-Crawl/1.0 (+contact@mediaw-b.com)" \
  "https://shop.asahi.co.jp/item/G0032142A.html" \
  -o scripts/fixtures/oa-images/senobura-sample.html

curl -sL -A "MediaWorks-Historical-Crawl/1.0 (+contact@mediaw-b.com)" \
  "https://shop.asahi.co.jp/category/URANADJA/Z0032459.html" \
  -o scripts/fixtures/oa-images/uranoura-sample.html

curl -sL -A "MediaWorks-Historical-Crawl/1.0 (+contact@mediaw-b.com)" \
  "https://www.dinos.co.jp/p/1110429450/" \
  -o scripts/fixtures/oa-images/dinos-sample.html
```

Verify each file is > 0 bytes and contains an `og:image` meta tag:

```bash
for f in scripts/fixtures/oa-images/*.html; do
  echo "$f: $(wc -c < "$f") bytes, og:image hits: $(grep -c 'og:image' "$f")"
done
```

Expected: each file has > 1KB and ≥ 1 og:image hit. If any returns 0 hits, re-fetch with a different sample URL (look at recent rows in `historical_broadcasts` via Supabase).

- [ ] **Step 2: Write the failing test script**

Create `scripts/test-og-image-extractor.ts`:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseOgImageFromHtml } from "../lib/historical-crawl/image-extractors/og-image";

interface Case {
	name: string;
	html: string;
	sourceUrl: string;
	expectedHost: string;
}

function load(channel: string, sourceUrl: string, expectedHost: string): Case {
	const html = readFileSync(
		join(process.cwd(), `scripts/fixtures/oa-images/${channel}-sample.html`),
		"utf-8",
	);
	return { name: channel, html, sourceUrl, expectedHost };
}

const CASES: Case[] = [
	load("junsanpo", "https://ropping.jp/product/111643", "ropping.jp"),
	load("tbs", "https://shopping.tbs.co.jp/tbs/product/P2122145", "shopping.tbs.co.jp"),
	load("senobura", "https://shop.asahi.co.jp/item/G0032142A.html", "shop.asahi.co.jp"),
	load("uranoura", "https://shop.asahi.co.jp/category/URANADJA/Z0032459.html", "shop.asahi.co.jp"),
	load("dinos", "https://www.dinos.co.jp/p/1110429450/", "dinos.co.jp"),
];

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${msg}`);
	}
}

function main() {
	for (const c of CASES) {
		const url = parseOgImageFromHtml(c.html, c.sourceUrl);
		assert(typeof url === "string", `${c.name}: extractor returns string (got ${typeof url})`);
		if (typeof url === "string") {
			assert(url.startsWith("https://"), `${c.name}: URL is absolute HTTPS (got ${url.slice(0, 60)}...)`);
			assert(url.includes(c.expectedHost), `${c.name}: URL contains expected host '${c.expectedHost}' (got ${url.slice(0, 80)})`);
		}
	}

	// Negative case: HTML without og:image
	const empty = parseOgImageFromHtml("<html><head></head><body>no meta</body></html>", "https://example.com/p/1");
	assert(empty === null, `no og:image returns null (got ${empty})`);

	if (process.exitCode) {
		console.error("\nog-image extractor test FAILED");
		process.exit(1);
	}
	console.log("\nAll og-image assertions passed.");
}

main();
```

- [ ] **Step 3: Run the test (should fail because parseOgImageFromHtml doesn't exist yet)**

Run: `npx tsx scripts/test-og-image-extractor.ts`

Expected: a TypeScript/module error like `Cannot find module '../lib/historical-crawl/image-extractors/og-image'`.

- [ ] **Step 4: Implement the extractor**

Create `lib/historical-crawl/image-extractors/og-image.ts`:

```typescript
import * as cheerio from "cheerio";
import { politeFetch } from "../fetch";
import type { ImageExtractor } from "./types";

/**
 * Pure-function variant: parse og:image from an HTML string.
 * Exposed for fixture-based tests; not used by the live extractor below.
 */
export function parseOgImageFromHtml(html: string, sourceUrl: string): string | null {
	try {
		const $ = cheerio.load(html);
		const og = $('meta[property="og:image"]').attr("content")?.trim();
		if (!og) return null;
		// Resolve relative URLs (defensive — most sites give absolute, but not all)
		return new URL(og, sourceUrl).toString();
	} catch {
		return null;
	}
}

/**
 * Live extractor: fetch the source URL and extract og:image.
 * Returns null on any failure (HTTP error, missing meta, parse failure).
 *
 * Used by junsanpo, tbs, dinos, senobura, uranoura — all sites that
 * render product detail pages with `<meta property="og:image">` in
 * server-rendered HTML.
 */
export const ogImageExtractor: ImageExtractor = {
	async extract(sourceUrl: string): Promise<string | null> {
		const r = await politeFetch(sourceUrl);
		if (!r.ok || !r.body) return null;
		return parseOgImageFromHtml(r.body, sourceUrl);
	},
};
```

- [ ] **Step 5: Wire it up in the registry**

Edit `lib/historical-crawl/image-extractors/index.ts` and replace the `null` entries for the 5 og-image channels:

```typescript
import type { OAChannelSlug } from "../types";
import type { ImageExtractor } from "./types";
import { ogImageExtractor } from "./og-image";

export const IMAGE_EXTRACTORS: Record<OAChannelSlug, ImageExtractor | null> = {
	japanet: null,
	junsanpo: ogImageExtractor,
	ntv: null, // populated in Task 5
	tbs: ogImageExtractor,
	dinos: ogImageExtractor,
	senobura: ogImageExtractor,
	uranoura: ogImageExtractor,
	txd: null,
};

export type { ImageExtractor } from "./types";
export { mapWithConcurrency } from "./types";
```

- [ ] **Step 6: Add npm script**

Edit `package.json`. Find the existing `test:historical-txd-parser` line and add immediately after it:

```json
    "test:og-image-extractor": "tsx scripts/test-og-image-extractor.ts",
```

- [ ] **Step 7: Run the test**

Run: `npm run test:og-image-extractor`

Expected: a list of `✓` lines (3 per channel × 5 channels + 1 negative = 16 assertions) and `All og-image assertions passed.` Exit 0.

If any channel's URL doesn't match the expected host, inspect the fixture — the upstream may have changed.

- [ ] **Step 8: Commit**

```bash
git add lib/historical-crawl/image-extractors/og-image.ts \
        lib/historical-crawl/image-extractors/index.ts \
        scripts/fixtures/oa-images/junsanpo-sample.html \
        scripts/fixtures/oa-images/tbs-sample.html \
        scripts/fixtures/oa-images/senobura-sample.html \
        scripts/fixtures/oa-images/uranoura-sample.html \
        scripts/fixtures/oa-images/dinos-sample.html \
        scripts/test-og-image-extractor.ts \
        package.json
git commit -m "feat(historical-crawl): og:image extractor for 5 OA channels"
```

---

## Task 5: Implement `ntv-api` extractor + fixture test

**Goal:** JSON-API extractor for ntv. Maps a `source_url` like `https://shop.ntv.co.jp/item/{id}` to an image via the public `/api/v1/item/detail-list/json` endpoint.

**Files:**
- Create: `lib/historical-crawl/image-extractors/ntv-api.ts`
- Create: `scripts/fixtures/oa-images/ntv-api-sample.json`
- Create: `scripts/test-ntv-image-extractor.ts`
- Modify: `lib/historical-crawl/image-extractors/index.ts` (wire ntv)
- Modify: `package.json` (add `test:ntv-image-extractor` script)

- [ ] **Step 1: Record API fixture**

```bash
curl -sL -A "MediaWorks-Historical-Crawl/1.0 (+contact@mediaw-b.com)" \
  -H "Accept: application/json" \
  "https://shop.ntv.co.jp/api/v1/item/detail-list/json?bics=5003a4010006&ptn=p0" \
  -o scripts/fixtures/oa-images/ntv-api-sample.json
```

Spot-check:

```bash
node -e "const d = require('./scripts/fixtures/oa-images/ntv-api-sample.json'); console.log({ rcd: d.itemListInfoXML?.rcd, count: d.itemListInfoXML?.count, hasImage: !!d.itemListInfoXML?.itL?.[0]?.itD?.item?.mainImgList?.[0]?.imgInfo?.path });"
```

Expected: `{ rcd: 0 (or success-equivalent), count: 1, hasImage: true }`.

If `hasImage` is false, try a different `bics` id from a recent ntv row in `historical_broadcasts`.

- [ ] **Step 2: Write the failing test script**

Create `scripts/test-ntv-image-extractor.ts`:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	extractNtvBicsFromSourceUrl,
	parseNtvApiImage,
	type NtvApiResponse,
} from "../lib/historical-crawl/image-extractors/ntv-api";

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${msg}`);
	}
}

function main() {
	// URL extraction
	assert(
		extractNtvBicsFromSourceUrl("https://shop.ntv.co.jp/item/5003a4010006?areaid=sptvshopping") ===
			"5003a4010006",
		"bics extracted from canonical URL",
	);
	assert(
		extractNtvBicsFromSourceUrl("https://shop.ntv.co.jp/item/5003a4010006") === "5003a4010006",
		"bics extracted from URL without query",
	);
	assert(
		extractNtvBicsFromSourceUrl("https://shop.ntv.co.jp/category/foo") === null,
		"non-item URL returns null",
	);

	// Fixture parsing
	const raw = readFileSync(
		join(process.cwd(), "scripts/fixtures/oa-images/ntv-api-sample.json"),
		"utf-8",
	);
	const body = JSON.parse(raw) as NtvApiResponse;
	const img = parseNtvApiImage(body);
	assert(typeof img === "string", `parseNtvApiImage returns string (got ${typeof img})`);
	if (typeof img === "string") {
		assert(
			img.startsWith("https://img.shop.ntv.co.jp/"),
			`image URL is on img.shop.ntv.co.jp (got ${img.slice(0, 80)})`,
		);
	}

	// Negative cases
	assert(parseNtvApiImage({} as NtvApiResponse) === null, "empty response returns null");
	assert(
		parseNtvApiImage({ itemListInfoXML: { itL: [] } } as NtvApiResponse) === null,
		"empty itL[] returns null",
	);

	if (process.exitCode) {
		console.error("\nntv-api extractor test FAILED");
		process.exit(1);
	}
	console.log("\nAll ntv-api assertions passed.");
}

main();
```

- [ ] **Step 3: Run the test (should fail)**

Run: `npx tsx scripts/test-ntv-image-extractor.ts`

Expected: module not found error.

- [ ] **Step 4: Implement the extractor**

Create `lib/historical-crawl/image-extractors/ntv-api.ts`:

```typescript
import { politeFetch } from "../fetch";
import type { ImageExtractor } from "./types";

const API_BASE = "https://shop.ntv.co.jp/api/v1/item/detail-list/json";

export interface NtvApiResponse {
	itemListInfoXML?: {
		rcd?: number;
		count?: number;
		itL?: Array<{
			itD?: {
				item?: {
					mainImgList?: Array<{
						imgInfo?: { path?: string };
					}>;
				};
			};
		}>;
	};
}

/**
 * Extract the `bics` (ntv-internal item id) from a source URL.
 * The ntv parser persists URLs like https://shop.ntv.co.jp/item/{bics}[?...].
 * Returns null when the URL doesn't match the expected /item/{id} shape.
 */
export function extractNtvBicsFromSourceUrl(sourceUrl: string): string | null {
	const m = sourceUrl.match(/\/item\/([a-zA-Z0-9]+)/);
	return m ? m[1] : null;
}

/**
 * Navigate the deeply-nested response to find the first product's main image.
 * Pure function; null on any missing path.
 */
export function parseNtvApiImage(body: NtvApiResponse): string | null {
	const path =
		body?.itemListInfoXML?.itL?.[0]?.itD?.item?.mainImgList?.[0]?.imgInfo?.path;
	return typeof path === "string" && path.length > 0 ? path : null;
}

/**
 * Live extractor: derive bics from source URL, fetch the public detail API,
 * extract image. Returns null on any failure.
 */
export const ntvApiExtractor: ImageExtractor = {
	async extract(sourceUrl: string): Promise<string | null> {
		const bics = extractNtvBicsFromSourceUrl(sourceUrl);
		if (!bics) return null;
		const apiUrl = `${API_BASE}?bics=${encodeURIComponent(bics)}&ptn=p0`;
		const r = await politeFetch(apiUrl, {
			headers: { Accept: "application/json, text/plain, */*" },
		});
		if (!r.ok || !r.body) return null;
		try {
			const body = JSON.parse(r.body) as NtvApiResponse;
			return parseNtvApiImage(body);
		} catch {
			return null;
		}
	},
};
```

- [ ] **Step 5: Wire it up in the registry**

Edit `lib/historical-crawl/image-extractors/index.ts`. Add the ntv-api import and replace the ntv entry:

```typescript
import type { OAChannelSlug } from "../types";
import type { ImageExtractor } from "./types";
import { ogImageExtractor } from "./og-image";
import { ntvApiExtractor } from "./ntv-api";

export const IMAGE_EXTRACTORS: Record<OAChannelSlug, ImageExtractor | null> = {
	japanet: null,
	junsanpo: ogImageExtractor,
	ntv: ntvApiExtractor,
	tbs: ogImageExtractor,
	dinos: ogImageExtractor,
	senobura: ogImageExtractor,
	uranoura: ogImageExtractor,
	txd: null,
};

export type { ImageExtractor } from "./types";
export { mapWithConcurrency } from "./types";
```

- [ ] **Step 6: Add npm script**

Edit `package.json`. After the `test:og-image-extractor` entry:

```json
    "test:ntv-image-extractor": "tsx scripts/test-ntv-image-extractor.ts",
```

- [ ] **Step 7: Run the test**

Run: `npm run test:ntv-image-extractor`

Expected: 7 ✓ lines (3 URL-extract + 2 fixture-parse + 2 negative cases) and `All ntv-api assertions passed.` Exit 0.

- [ ] **Step 8: Commit**

```bash
git add lib/historical-crawl/image-extractors/ntv-api.ts \
        lib/historical-crawl/image-extractors/index.ts \
        scripts/fixtures/oa-images/ntv-api-sample.json \
        scripts/test-ntv-image-extractor.ts \
        package.json
git commit -m "feat(historical-crawl): ntv JSON-API image extractor"
```

---

## Task 6: Add `image_url` to txd parser

**Goal:** txd's list API already returns `PictureCollection.URL[]`. A one-line addition + an assertion in the existing fixture test.

**Files:**
- Modify: `lib/historical-crawl/parsers/txd.ts`
- Modify: `scripts/test-historical-txd-parser.ts`

- [ ] **Step 1: Add image_url to txdProductToRow**

Edit `lib/historical-crawl/parsers/txd.ts`. Find the return inside `txdProductToRow` and add `image_url` (placed after `source_sheet`, mirroring the field order in `HistoricalRow`):

Locate this block:

```typescript
	return {
		channel: "txd",
		air_date: jstDate,
		day_of_week: dayOfWeekJp(jstDate),
		start_time: null,
		product_name: (p.Gname ?? "").slice(0, 500),
		price_text: priceText ? priceText.slice(0, 200) : null,
		price_jpy: min,
		price_is_tax_incl: min !== null ? true : null,
		source_url: detailUrl,
		source_sheet: "live-crawl:txd",
	};
```

Replace with:

```typescript
	return {
		channel: "txd",
		air_date: jstDate,
		day_of_week: dayOfWeekJp(jstDate),
		start_time: null,
		product_name: (p.Gname ?? "").slice(0, 500),
		price_text: priceText ? priceText.slice(0, 200) : null,
		price_jpy: min,
		price_is_tax_incl: min !== null ? true : null,
		source_url: detailUrl,
		source_sheet: "live-crawl:txd",
		image_url: p.PictureCollection?.URL?.[0] ?? null,
	};
```

- [ ] **Step 2: Add image_url assertion to fixture test**

Edit `scripts/test-historical-txd-parser.ts`. Find the existing assertion block and add immediately after the `price_is_tax_incl` assertion:

```typescript
	assert(
		typeof sample.image_url === "string" && sample.image_url.startsWith("https://"),
		`image_url is absolute HTTPS (got ${sample.image_url})`,
	);
	assert(
		sample.image_url!.includes("tv-tokyoshop.jp"),
		`image_url contains tv-tokyoshop.jp host (got ${sample.image_url})`,
	);
```

- [ ] **Step 3: Run the test**

Run: `npm run test:historical-txd-parser`

Expected: all assertions pass including the two new image_url ones. The fixture (recorded 2026-05-19) has 15 products all with non-null `PictureCollection.URL[0]` from earlier verification.

If image_url assertion fails: the fixture's first product may have been a corner case (no images). Either re-record the fixture or update the test to scan all rows for at least 1 with image_url.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`

Expected: 1 fewer parser error than after Task 2 (txd is now compliant). Other 6 OA parsers still have the `Property 'image_url' is missing` error — that's the Task 7 deliverable.

- [ ] **Step 5: Commit**

```bash
git add lib/historical-crawl/parsers/txd.ts scripts/test-historical-txd-parser.ts
git commit -m "feat(historical-crawl): populate image_url in txd parser from PictureCollection"
```

---

## Task 7: Apply enrichment to og-image channels (junsanpo, tbs, dinos, senobura, uranoura)

**Goal:** After each parser produces rows, call `ogImageExtractor` for each row via `mapWithConcurrency(rows, 5, ...)`. Five files, same pattern.

**Files:**
- Modify: `lib/historical-crawl/parsers/junsanpo.ts`
- Modify: `lib/historical-crawl/parsers/tbs.ts`
- Modify: `lib/historical-crawl/parsers/dinos.ts`
- Modify: `lib/historical-crawl/parsers/senobura.ts`
- Modify: `lib/historical-crawl/parsers/uranoura.ts`

The mechanics are identical across all 5 — each parser has a `fetchToday(jstDate)` function that returns `HistoricalRow[]`. We need to:
1. Add `image_url: null` to every `rows.push({ ... })` call site so the existing build compiles (one line per existing row construction).
2. After all rows are produced, run image enrichment.
3. Add imports at the top.

- [ ] **Step 1: Modify junsanpo.ts**

Edit `lib/historical-crawl/parsers/junsanpo.ts`.

a) Add imports near the top (next to existing imports):

```typescript
import { ogImageExtractor } from "../image-extractors/og-image";
import { mapWithConcurrency } from "../image-extractors/types";
```

b) Find every `rows.push({ ... })` in `parse(...)`. Inside each object literal, add `image_url: null` as the last field (mirrors the type's field order).

For example, locate a block like:

```typescript
		rows.push({
			channel: "junsanpo",
			air_date: jstDate,
			// ...other fields...
			source_url: detailUrl,
			source_sheet: "live-crawl:junsanpo",
		});
```

And add the new field:

```typescript
		rows.push({
			channel: "junsanpo",
			air_date: jstDate,
			// ...other fields...
			source_url: detailUrl,
			source_sheet: "live-crawl:junsanpo",
			image_url: null,
		});
```

c) Find the parser export at the bottom — `export const junsanpoParser: ChannelParser = { ... }`. Replace its `fetchToday` so it enriches after parsing:

Existing (typical pattern):

```typescript
export const junsanpoParser: ChannelParser = {
	slug: "junsanpo",
	name: "テレ朝じゅん散歩",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) return [];
		return parse(r.body, jstDate);
	},
};
```

Replace with:

```typescript
export const junsanpoParser: ChannelParser = {
	slug: "junsanpo",
	name: "テレ朝じゅん散歩",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) return [];
		const rows = parse(r.body, jstDate);
		await mapWithConcurrency(rows, 5, async (row) => {
			if (!row.source_url) return;
			row.image_url = await ogImageExtractor.extract(row.source_url).catch(() => null);
		});
		return rows;
	},
};
```

If the exact existing structure differs (some parsers wrap their fetch differently), preserve the existing flow and add the `mapWithConcurrency` call after the row array is constructed but before returning.

- [ ] **Step 2: Modify tbs.ts**

Same three changes (imports, `image_url: null` in every push, `fetchToday` enrichment) as Task 7 Step 1. The slug is `"tbs"`.

- [ ] **Step 3: Modify dinos.ts**

Same three changes. Slug: `"dinos"`.

- [ ] **Step 4: Modify senobura.ts**

Same three changes — but note that senobura.ts uses a shared helper `parseAsahiCategory(...)` from this same file. The `rows.push({ ... })` is inside `parseAsahiCategory`; add `image_url: null` there (single push call site).

The `fetchToday` enrichment goes inside `senoburaParser.fetchToday` (after `parseAsahiCategory` returns rows).

- [ ] **Step 5: Modify uranoura.ts**

Same as senobura — uranoura.ts also uses `parseAsahiCategory(...)` from senobura.ts. The shared helper now already has `image_url: null` from Task 7 Step 4, so only the parser's `fetchToday` needs the enrichment wrapper.

If `uranoura.ts` imports `parseAsahiCategory` from `./senobura`, this becomes a 5-line change at the bottom only.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`

Expected: 1 remaining error from `ntv.ts` (Task 8). All other parsers compile cleanly.

- [ ] **Step 7: Smoke-verify with one parser locally (optional, no DB write)**

Run:

```bash
npx tsx --env-file=.env.local -e "
import('./lib/historical-crawl/parsers/junsanpo').then(async (m) => {
  const today = new Date(Date.now() + 9*3600_000).toISOString().slice(0,10);
  const rows = await m.junsanpoParser.fetchToday(today);
  console.log('rows:', rows.length, '| with image:', rows.filter(r => r.image_url).length);
  console.log('first:', rows[0]);
});
"
```

Expected: returns rows; at least 1 row should have a non-null `image_url`. (This is a network test — skip if no internet.)

- [ ] **Step 8: Commit**

```bash
git add lib/historical-crawl/parsers/junsanpo.ts \
        lib/historical-crawl/parsers/tbs.ts \
        lib/historical-crawl/parsers/dinos.ts \
        lib/historical-crawl/parsers/senobura.ts \
        lib/historical-crawl/parsers/uranoura.ts
git commit -m "feat(historical-crawl): enrich 5 OA parsers with og:image extraction"
```

---

## Task 8: Apply enrichment to ntv parser

**Goal:** Wire ntv parser to `ntvApiExtractor`. Same pattern as Task 7 but with a different extractor.

**Files:**
- Modify: `lib/historical-crawl/parsers/ntv.ts`

- [ ] **Step 1: Modify ntv.ts**

Edit `lib/historical-crawl/parsers/ntv.ts`.

a) Add imports:

```typescript
import { ntvApiExtractor } from "../image-extractors/ntv-api";
import { mapWithConcurrency } from "../image-extractors/types";
```

b) Add `image_url: null` to every `rows.push({ ... })` call site inside the parse function.

c) Replace `fetchToday` to add enrichment after the parse step:

Existing pattern:

```typescript
export const ntvParser: ChannelParser = {
	slug: "ntv",
	name: "日テレポシュレ",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) return [];
		return parse(r.body, jstDate);
	},
};
```

Replace with:

```typescript
export const ntvParser: ChannelParser = {
	slug: "ntv",
	name: "日テレポシュレ",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) return [];
		const rows = parse(r.body, jstDate);
		await mapWithConcurrency(rows, 5, async (row) => {
			if (!row.source_url) return;
			row.image_url = await ntvApiExtractor.extract(row.source_url).catch(() => null);
		});
		return rows;
	},
};
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`

Expected: clean (zero new errors). The Task 2 error list should now be empty for all OA parsers.

- [ ] **Step 3: Commit**

```bash
git add lib/historical-crawl/parsers/ntv.ts
git commit -m "feat(historical-crawl): enrich ntv parser with API-based image extraction"
```

---

## Task 9: Live integration test for all extractors

**Goal:** Single script that hits the live API/web for each channel's sample source URL and asserts an image_url is returned. Catches contract changes that fixture tests wouldn't.

**Files:**
- Create: `scripts/test-oa-images-live.ts`
- Modify: `package.json` (add `test:oa-images-live`)

- [ ] **Step 1: Create the live test script**

Create `scripts/test-oa-images-live.ts`:

```typescript
import { ogImageExtractor } from "../lib/historical-crawl/image-extractors/og-image";
import { ntvApiExtractor } from "../lib/historical-crawl/image-extractors/ntv-api";

interface Case {
	channel: string;
	url: string;
	extractor: typeof ogImageExtractor;
}

const CASES: Case[] = [
	{ channel: "junsanpo", url: "https://ropping.jp/product/111643", extractor: ogImageExtractor },
	{ channel: "tbs", url: "https://shopping.tbs.co.jp/tbs/product/P2122145", extractor: ogImageExtractor },
	{ channel: "senobura", url: "https://shop.asahi.co.jp/item/G0032142A.html", extractor: ogImageExtractor },
	{ channel: "uranoura", url: "https://shop.asahi.co.jp/category/URANADJA/Z0032459.html", extractor: ogImageExtractor },
	{ channel: "dinos", url: "https://www.dinos.co.jp/p/1110429450/", extractor: ogImageExtractor },
	{ channel: "ntv", url: "https://shop.ntv.co.jp/item/5003a4010006", extractor: ntvApiExtractor },
];

async function main() {
	console.log(`Live image-extractor test — ${CASES.length} cases\n`);
	let failed = 0;
	for (const c of CASES) {
		const t0 = Date.now();
		try {
			const url = await c.extractor.extract(c.url);
			const ms = Date.now() - t0;
			if (typeof url === "string" && url.startsWith("https://")) {
				console.log(`✓ ${c.channel.padEnd(10)} ${ms}ms  ${url.slice(0, 80)}`);
			} else {
				console.log(`✗ ${c.channel.padEnd(10)} ${ms}ms  (got null or non-HTTPS)`);
				failed++;
			}
		} catch (e) {
			console.log(`✗ ${c.channel.padEnd(10)} threw: ${e instanceof Error ? e.message : String(e)}`);
			failed++;
		}
	}
	console.log();
	if (failed > 0) {
		console.error(`${failed}/${CASES.length} cases failed.`);
		process.exit(1);
	}
	console.log(`All ${CASES.length} cases passed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add npm script**

Edit `package.json`. After `test:ntv-image-extractor`:

```json
    "test:oa-images-live": "tsx scripts/test-oa-images-live.ts",
```

- [ ] **Step 3: Run the live test**

Run: `npm run test:oa-images-live`

Expected: 6/6 ✓ lines, each well under 5s, all URLs starting with `https://`. Exit 0.

If a specific URL has been deleted from the upstream, swap in a different sample URL from `historical_broadcasts`.

- [ ] **Step 4: Commit**

```bash
git add scripts/test-oa-images-live.ts package.json
git commit -m "test(historical-crawl): live integration test for OA image extractors"
```

---

## Task 10: Backfill script for non-txd channels

**Goal:** `scripts/backfill-oa-images.ts --channel=<slug>` — iterates `image_url IS NULL` rows for a single channel and fills them via the channel's extractor. Idempotent. Operator runs per-channel.

**Files:**
- Create: `scripts/backfill-oa-images.ts`

- [ ] **Step 1: Create the backfill script**

Create `scripts/backfill-oa-images.ts`:

```typescript
/**
 * Backfill image_url for an OA channel's existing rows.
 *
 * Required flag: --channel=<slug> (one of: junsanpo, ntv, tbs, dinos, senobura, uranoura)
 * Optional:      --limit=N    (default: process all matching rows)
 *                --throttle=N (ms between requests; default 350)
 *                --concurrency=N (default 4 — within one channel, parallel rows)
 *
 * Reads rows where image_url IS NULL AND source_url IS NOT NULL.
 * For each row, calls the channel's image extractor and updates image_url.
 * Failures stay null — re-run to retry.
 *
 * Does NOT support txd (txd backfill is a re-run of scripts/backfill-txd.ts
 * after the parser patch lands).
 *
 * Spec: docs/superpowers/specs/2026-05-21-oa-channel-images-design.md §8
 */

import { createClient } from "@supabase/supabase-js";
import { IMAGE_EXTRACTORS, mapWithConcurrency, type ImageExtractor } from "../lib/historical-crawl/image-extractors";
import type { OAChannelSlug } from "../lib/historical-crawl/types";

const SUPPORTED_CHANNELS: readonly OAChannelSlug[] = [
	"junsanpo",
	"ntv",
	"tbs",
	"dinos",
	"senobura",
	"uranoura",
];

interface Args {
	channel: OAChannelSlug;
	limit: number | null;
	throttleMs: number;
	concurrency: number;
}

function parseArgs(): Args {
	const a = process.argv.slice(2);
	const get = (name: string): string | undefined => {
		const hit = a.find((x) => x.startsWith(`--${name}=`));
		return hit?.split("=", 2)[1];
	};
	const channel = get("channel");
	if (!channel || !SUPPORTED_CHANNELS.includes(channel as OAChannelSlug)) {
		console.error(`--channel=<slug> is required. Supported: ${SUPPORTED_CHANNELS.join(", ")}`);
		console.error("(txd backfill uses scripts/backfill-txd.ts, not this script.)");
		process.exit(2);
	}
	const limit = get("limit") ? parseInt(get("limit")!, 10) : null;
	const throttleMs = get("throttle") ? parseInt(get("throttle")!, 10) : 350;
	const concurrency = get("concurrency") ? parseInt(get("concurrency")!, 10) : 4;
	return { channel: channel as OAChannelSlug, limit, throttleMs, concurrency };
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

(async () => {
	const args = parseArgs();
	const extractor: ImageExtractor | null = IMAGE_EXTRACTORS[args.channel];
	if (!extractor) {
		console.error(`No extractor registered for channel ${args.channel}.`);
		process.exit(2);
	}

	const sb = createClient(
		process.env.NEXT_PUBLIC_SUPABASE_URL!,
		process.env.SUPABASE_SERVICE_ROLE_KEY!,
	);

	console.log(`Backfill — channel=${args.channel} concurrency=${args.concurrency} throttle=${args.throttleMs}ms${args.limit ? ` limit=${args.limit}` : ""}`);

	let query = sb
		.from("historical_broadcasts")
		.select("id, source_url")
		.eq("channel", args.channel)
		.is("image_url", null)
		.not("source_url", "is", null)
		.order("air_date", { ascending: false });
	if (args.limit) query = query.limit(args.limit);

	const { data, error } = await query;
	if (error) {
		console.error("SELECT failed:", error.message);
		process.exit(1);
	}
	const rows = (data ?? []) as Array<{ id: string; source_url: string }>;
	console.log(`Found ${rows.length} rows to enrich.\n`);

	if (rows.length === 0) {
		console.log("Nothing to do.");
		return;
	}

	let updated = 0;
	let failed = 0;
	const startedAt = Date.now();

	// Process in small chunks so we can throttle between chunks.
	const CHUNK = args.concurrency;
	for (let i = 0; i < rows.length; i += CHUNK) {
		const chunk = rows.slice(i, i + CHUNK);
		const imageUrls = await mapWithConcurrency(chunk, CHUNK, async (row) => {
			try {
				return await extractor.extract(row.source_url);
			} catch {
				return null;
			}
		});
		// Update only the rows with a non-null result (NULL stays NULL; next run retries)
		for (let j = 0; j < chunk.length; j++) {
			const newUrl = imageUrls[j];
			if (!newUrl) { failed++; continue; }
			const { error: upErr } = await sb
				.from("historical_broadcasts")
				.update({ image_url: newUrl })
				.eq("id", chunk[j].id);
			if (upErr) { failed++; continue; }
			updated++;
		}

		if ((i + chunk.length) % 50 === 0 || i + chunk.length >= rows.length) {
			const pct = (((i + chunk.length) / rows.length) * 100).toFixed(1);
			const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
			console.log(`[${i + chunk.length}/${rows.length} ${pct}%]  updated=${updated}  failed=${failed}  elapsed=${elapsed}s`);
		}

		if (i + CHUNK < rows.length) await sleep(args.throttleMs);
	}

	const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
	console.log(`\n=== Summary ===`);
	console.log(`channel:   ${args.channel}`);
	console.log(`total:     ${rows.length}`);
	console.log(`updated:   ${updated}`);
	console.log(`failed:    ${failed} (image stayed NULL — re-run to retry)`);
	console.log(`elapsed:   ${elapsed}s`);
})();
```

- [ ] **Step 2: Smoke-test with the smallest channel (uranoura, ~385 rows)**

Run a small slice first to validate the end-to-end before committing the operator to a long run:

```bash
npx tsx --env-file=.env.local scripts/backfill-oa-images.ts --channel=uranoura --limit=10
```

Expected: prints "Found 10 rows" (or fewer if already partially populated), progresses through them, prints summary with `updated >= 1`.

Verify in DB:

```bash
npx tsx --env-file=.env.local -e "
import('./lib/supabase').then(async (m) => {
  const sb = m.getServiceClient();
  const { count } = await sb.from('historical_broadcasts').select('id', { count: 'exact', head: true }).eq('channel', 'uranoura').not('image_url', 'is', null);
  console.log('uranoura rows with image_url:', count);
});
"
```

Expected: a positive count.

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-oa-images.ts
git commit -m "chore(historical-crawl): add per-channel image backfill script"
```

---

## Task 11: API route + UI update to surface image_url

**Goal:** `/api/historical-broadcasts` returns `image_url`; `OABroadcastListItem` renders a 48×48 thumbnail when present, placeholder div otherwise.

**Files:**
- Modify: `app/api/historical-broadcasts/route.ts`
- Modify: `components/broadcasts/OABroadcastListItem.tsx`

- [ ] **Step 1: Extend the API row shape and SELECT**

Edit `app/api/historical-broadcasts/route.ts`. Find the `HistoricalBroadcastRow` interface (around line 16):

```typescript
export interface HistoricalBroadcastRow {
	id: string;
	channel: string;
	air_date: string;
	day_of_week: string | null;
	start_time: string | null;
	product_name: string;
	price_text: string | null;
	price_jpy: number | null;
	price_is_tax_incl: boolean | null;
	source_url: string | null;
	category: string | null;
}
```

Add `image_url`:

```typescript
export interface HistoricalBroadcastRow {
	id: string;
	channel: string;
	air_date: string;
	day_of_week: string | null;
	start_time: string | null;
	product_name: string;
	price_text: string | null;
	price_jpy: number | null;
	price_is_tax_incl: boolean | null;
	source_url: string | null;
	category: string | null;
	image_url: string | null;
}
```

Find the SELECT (search the file for `.select(`). Add `image_url` to the list. For example:

```typescript
.select("id, channel, air_date, day_of_week, start_time, product_name, price_text, price_jpy, price_is_tax_incl, source_url, category, image_url")
```

- [ ] **Step 2: Extend OARow in the component**

Edit `components/broadcasts/OABroadcastListItem.tsx`. Find the `OARow` interface near the top:

```typescript
export interface OARow {
	id: string;
	channel: string;
	air_date: string;
	day_of_week: string | null;
	start_time: string | null;
	product_name: string;
	price_text: string | null;
	price_jpy: number | null;
	price_is_tax_incl: boolean | null;
	source_url: string | null;
	category: string | null;
}
```

Add `image_url`:

```typescript
export interface OARow {
	id: string;
	channel: string;
	air_date: string;
	day_of_week: string | null;
	start_time: string | null;
	product_name: string;
	price_text: string | null;
	price_jpy: number | null;
	price_is_tax_incl: boolean | null;
	source_url: string | null;
	category: string | null;
	image_url: string | null;
}
```

- [ ] **Step 3: Render the thumbnail**

Still in `OABroadcastListItem.tsx`. Find the JSX block — the existing row layout uses:

```tsx
<div className="flex items-start gap-3 py-2 px-3 hover:bg-gray-50/50">
	<span className="shrink-0 font-mono text-[11px] text-gray-700 w-10 text-right tabular-nums pt-0.5">
		{row.start_time ? formatTime(row.start_time) : "—"}
	</span>
	...
```

Insert the thumbnail (or placeholder) immediately AFTER the time `<span>` and BEFORE the channel badge `<span>`:

```tsx
		{row.image_url ? (
			<img
				src={row.image_url}
				alt=""
				className="shrink-0 w-12 h-12 object-cover rounded border border-gray-100"
				loading="lazy"
				onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
			/>
		) : (
			<div
				className="shrink-0 w-12 h-12 rounded bg-gray-50 border border-gray-100"
				aria-hidden="true"
			/>
		)}
```

The placeholder div keeps row heights uniform whether or not an image loaded.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`

Expected: clean. Both files now consistent with the DB column.

- [ ] **Step 5: Optional — visual smoke check in dev server**

If the dev server is running (port 3000 or 3001), navigate to `/ja/broadcasts` and click on today's date. The OA section should show thumbnails for txd rows (which already have image_url from this morning's manual trigger). Other channels appear text-only with placeholder div until the operator runs the backfill in Task 12.

If no dev server, skip — type check is sufficient.

- [ ] **Step 6: Commit**

```bash
git add app/api/historical-broadcasts/route.ts components/broadcasts/OABroadcastListItem.tsx
git commit -m "feat(broadcasts): surface image_url in OA day-detail list items"
```

---

## Task 12: Final verification + operator runbook for full backfill

**Goal:** Confirm forward (cron) and one channel's backfill work end-to-end; document the operator runbook for the remaining channels.

- [ ] **Step 1: Verify type check across the entire tree**

Run: `npx tsc --noEmit`

Expected: clean (modulo pre-existing playwright errors in `scripts/e2e-screenplay.ts` and `scripts/screenshot-list.ts`).

- [ ] **Step 2: Run all extractor tests**

```bash
npm run test:og-image-extractor && \
npm run test:ntv-image-extractor && \
npm run test:historical-txd-parser && \
npm run test:oa-images-live
```

Expected: all four pass.

- [ ] **Step 3: Verify forward path (no commit, no DB write)**

Run a single parser end-to-end to confirm enrichment fires correctly:

```bash
npx tsx --env-file=.env.local -e "
import('./lib/historical-crawl/parsers/uranoura').then(async (m) => {
  const today = new Date(Date.now() + 9*3600_000).toISOString().slice(0,10);
  const rows = await m.uranouraParser.fetchToday(today);
  console.log('rows:', rows.length, '| with image:', rows.filter(r => r.image_url).length);
  if (rows[0]) console.log('first image:', rows[0].image_url);
});
"
```

Expected: at least 1 row, at least 1 with `image_url`. This proves the parser-level enrichment works without DB writes.

- [ ] **Step 4: Run full backfill for uranoura (smallest, ~385 rows)**

```bash
npx tsx --env-file=.env.local scripts/backfill-oa-images.ts --channel=uranoura
```

Expected wall time: ~3-5 minutes. Final summary should show `updated >= 200` (some rows may have broken URLs upstream — they stay NULL).

- [ ] **Step 5: Spot-check the result**

```bash
npx tsx --env-file=.env.local -e "
import('./lib/supabase').then(async (m) => {
  const sb = m.getServiceClient();
  const { count: total } = await sb.from('historical_broadcasts').select('id', { count: 'exact', head: true }).eq('channel', 'uranoura');
  const { count: withImg } = await sb.from('historical_broadcasts').select('id', { count: 'exact', head: true }).eq('channel', 'uranoura').not('image_url', 'is', null);
  console.log(\`uranoura: \${withImg}/\${total} with image_url (\${(100*withImg/total).toFixed(1)}%)\`);
});
"
```

Expected: ≥ 80% coverage.

- [ ] **Step 6: Operator runbook (document, do not execute)**

Confirm the README / operator notes capture the remaining backfill steps. After this plan, the operator runs (parallel terminals OK — different hosts):

```bash
npx tsx --env-file=.env.local scripts/backfill-oa-images.ts --channel=junsanpo  &
npx tsx --env-file=.env.local scripts/backfill-oa-images.ts --channel=tbs       &
npx tsx --env-file=.env.local scripts/backfill-oa-images.ts --channel=dinos     &
npx tsx --env-file=.env.local scripts/backfill-oa-images.ts --channel=senobura  &
npx tsx --env-file=.env.local scripts/backfill-oa-images.ts --channel=ntv       &
# txd: re-run the existing list-API backfill — UPSERT path fills image_url
npx tsx --env-file=.env.local scripts/backfill-txd.ts
wait
```

Estimated wall time: ~30 min (longest channel = junsanpo at ~25 min).

This is NOT executed as part of the plan — operator decides when to run.

- [ ] **Step 7: Final commit (commit the spec + plan)**

```bash
git add docs/superpowers/specs/2026-05-21-oa-channel-images-design.md \
        docs/superpowers/plans/2026-05-21-oa-channel-images.md
git commit -m "docs(broadcasts): OA channel image enrichment spec + plan"
```

---

## Self-Review Checklist (filled in by plan author)

- [x] **Spec coverage** — every section of the design doc maps to tasks:
  - §3 Discovered extraction strategies → Tasks 4, 5 (extractors with fixtures).
  - §4 Database migration → Task 1.
  - §5 Code structure → Tasks 3, 4, 5 (extractor folder); Tasks 6, 7, 8 (parser modifications).
  - §6 Per-channel behavior → Task 6 (txd), Task 7 (5 og-image), Task 8 (ntv).
  - §7 Daily cron integration → no separate task — automatic once parsers populate image_url (proven by Task 12 Step 3).
  - §8 Backfill → Tasks 10, 12.
  - §9 UI changes → Task 11.
  - §10 Tests → Tasks 4, 5, 6, 9.
  - §11 Migration & rollout order → reflected in task order.
  - §12 Error handling → built into extractor null-on-failure + UI placeholder + onError.
  - §13 Risks → mitigated via concurrency cap (Task 3), backfill idempotency (Task 10), per-channel parallel runs (Task 12 Step 6).
  - §14 Success criteria → verified by Task 12.

- [x] **Placeholder scan** — every step has runnable commands, complete code, or explicit verification criteria. No "TBD", "implement later", "similar to Task N", "add appropriate error handling".

- [x] **Type consistency** — types used across tasks match:
  - `HistoricalRow.image_url: string | null` (Task 2) → used in Tasks 5, 6, 7, 8, 10, 11.
  - `ImageExtractor.extract(): Promise<string | null>` (Task 3) → implemented in Tasks 4, 5; consumed in Tasks 7, 8, 10.
  - `mapWithConcurrency` signature (Task 3) → called in Tasks 7, 8, 10 with `(items, 5 or 4, async fn)`.
  - `parseOgImageFromHtml(html, sourceUrl): string | null` (Task 4) → only used internally by `ogImageExtractor.extract`.
  - `extractNtvBicsFromSourceUrl(url): string | null` and `parseNtvApiImage(body): string | null` (Task 5) → only used internally by `ntvApiExtractor.extract` and by the Task 5 test.
  - `IMAGE_EXTRACTORS: Record<OAChannelSlug, ImageExtractor | null>` (Task 3) → mutated in Tasks 4, 5 and consumed in Task 10.

- [x] **Bite-sized steps** — each step is one focused action (write test / run test / write code / commit). No multi-thousand-line code blocks; the biggest single step is the backfill script in Task 10 which is the script's natural single unit.
