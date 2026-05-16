# Channel Category Whitelist Implementation Plan (Phase 1-C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach a `category` to every QVC + ShopCh broadcast slot, then drop slots whose category is **not** in the user-provided whitelist. New rows in `broadcasts` and `historical_broadcasts` carry the category; legacy rows stay NULL.

**Architecture:**
- **DB layer**: add `category text` to `broadcasts` + `historical_broadcasts` + `qvc_products`. Add `channel_categories` whitelist table seeded with QVC 7 + ShopCh 5 (from `project-channel-category-whitelist` memory).
- **QVC**: extend `lib/qvc-products/fetcher.ts` parser to extract category from the product page's breadcrumb / JSON-LD. The daily `enrich-qvc-products` cron already fetches these pages and stores them in `qvc_products`; category becomes a cached column. Slot → category by taking the first `product_id` from `data-products` and looking up `qvc_products.category`.
- **ShopCh**: slots have no product IDs and the HTML has no per-slot category attribute. Classify with a single Gemini batch call per crawl: send slot `program_title + description` for all ~24 daily slots in one prompt, get back a `category` for each slot (one of the 5 whitelist values or `null` for "not in scope").
- **Filter**: a `lib/broadcasts/category-filter.ts` helper loads the whitelist on startup, exposes `isAllowed(channel, category)`. The persist step drops slots whose category is unknown/not allowed.

**Tech Stack:** Next.js, Supabase (postgres + RLS), cheerio, `gemini-3-flash-preview` via `@google/generative-ai` (already in use across discovery/curation pipelines).

---

## Context an engineer needs

- The channel whitelist is the user's curation criterion. Source of truth: memory file `project-channel-category-whitelist.md`. **The category strings are Japanese; store and match them verbatim — do not translate.**
- QVC scraper: `lib/broadcasts/qvc.ts::scrapeQVCFromHTML` returns `ScrapedSlot[]`. Each slot has `data-products="754899|754900|..."` as a `|`-separated id list. Persist happens via `lib/broadcasts/persist.ts`.
- QVC products: `qvc_products` table (`supabase/migrations/2026-05-12_qvc_products.sql`) caches `name`, `description`, OG images, video. The daily cron and `enrich:qvc-products` npm script populate it via `lib/qvc-products/fetcher.ts::parseQvcProductHTML`. Extending this parser adds category to the cache.
- ShopCh scraper: `lib/broadcasts/shopch.ts`. Slots have title + description but no product IDs.
- Existing Gemini integration: `lib/discovery/curate.ts` is the closest reference for prompt + JSON-output pattern. Use the same model id and structured-JSON response style.
- Cron paths (non-user-initiated) keep using `getServiceClient()`. Per CLAUDE.md.

## File Structure

**Create:**
- `supabase/migrations/2026-05-17_channel_categories_and_columns.sql` — adds 3 category columns (broadcasts, historical_broadcasts, qvc_products) + `channel_categories` table + 12-row seed.
- `lib/broadcasts/category-filter.ts` — `loadWhitelist()`, `isAllowed(channel, category)`, plus normalization (trim + NFKC).
- `lib/broadcasts/shopch-category.ts` — `classifyShopChSlotsWithGemini(slots)`.

**Modify:**
- `lib/broadcasts/types.ts` — add `category: string | null` to `ScrapedSlot`.
- `lib/qvc-products/fetcher.ts` — extract category from breadcrumb + JSON-LD; return on `QvcProductDetail`.
- `lib/qvc-products/enrich.ts` — write the new `category` column.
- `lib/broadcasts/qvc.ts` — after scraping, look up category from `qvc_products` for each slot's first product id, attach `category`, then drop disallowed slots.
- `lib/broadcasts/shopch.ts` — after scraping, classify with Gemini batch, attach `category`, drop disallowed slots.
- `lib/broadcasts/persist.ts` — write `category` column on insert.
- `CLAUDE.md` — document the whitelist + drop policy under Broadcast Calendar.

---

## Task 1: Migration — category columns + whitelist table + seed

**Files:**
- Create: `supabase/migrations/2026-05-17_channel_categories_and_columns.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Phase 1-C: per-slot category metadata + user-curated whitelist.
-- Slots are persisted ONLY if their category is in the whitelist.

ALTER TABLE broadcasts            ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE historical_broadcasts ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE qvc_products          ADD COLUMN IF NOT EXISTS category text;

CREATE INDEX IF NOT EXISTS idx_broadcasts_category
  ON broadcasts (channel, category) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_historical_broadcasts_category
  ON historical_broadcasts (channel, category) WHERE category IS NOT NULL;

-- Whitelist: which categories are eligible for ingestion per channel.
CREATE TABLE IF NOT EXISTS channel_categories (
  channel     text NOT NULL,
  category    text NOT NULL,
  is_allowed  boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, category)
);

ALTER TABLE channel_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS read_member ON channel_categories;
CREATE POLICY read_member ON channel_categories
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('member','admin')));

DROP POLICY IF EXISTS write_admin ON channel_categories;
CREATE POLICY write_admin ON channel_categories
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

-- Seed: user-curated whitelist (2026-05-17 メモリ参照).
INSERT INTO channel_categories (channel, category) VALUES
  ('qvc',    'ビューティー'),
  ('qvc',    'ファッション小物'),
  ('qvc',    '健康・ダイエット'),
  ('qvc',    'ホーム'),
  ('qvc',    'キッチングッズ'),
  ('qvc',    'レジャー・ホビー'),
  ('qvc',    '家電'),
  ('shopch', '靴・バッグ・小物・インナー'),
  ('shopch', 'コスメ'),
  ('shopch', '美容・ダイエット・フィットネス'),
  ('shopch', 'ホーム・インテリア'),
  ('shopch', '家電')
ON CONFLICT (channel, category) DO NOTHING;
```

- [ ] **Step 2: Apply locally**

In Supabase SQL editor, paste and run. Verify:

```sql
SELECT channel, COUNT(*) FROM channel_categories GROUP BY channel;
-- expected: qvc=7, shopch=5

SELECT column_name FROM information_schema.columns
WHERE table_name IN ('broadcasts','historical_broadcasts','qvc_products')
  AND column_name='category';
-- expected: 3 rows
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-05-17_channel_categories_and_columns.sql
git commit -m "feat(category): broadcasts/historical/qvc_products.category column + channel_categories seed"
```

---

## Task 2: QVC product parser — extract category

**Files:**
- Modify: `lib/qvc-products/fetcher.ts` (interface + parser)

QVC product pages expose category via two paths (best-effort, in order):
1. `<script type="application/ld+json">` containing `Product` schema with `category` field
2. Breadcrumb DOM (`nav.breadcrumb a` or `.breadcrumb li`) — top-level breadcrumb is the category, e.g. "ビューティー"

- [ ] **Step 1: Extend the interface and parser**

```ts
export interface QvcProductDetail {
  id: string;
  name: string | null;
  description: string | null;
  category: string | null; // NEW
  image_url: string | null;
  image_urls: string[];
  video_url: string | null;
  price_text: string | null;
  source_url: string;
}

function extractCategoryFromHTML($: cheerio.CheerioAPI): string | null {
  // 1) JSON-LD Product schema.
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
        const t = obj["@type"];
        if (t === "Product" && typeof obj.category === "string") {
          const cat = clean(obj.category as string);
          if (cat) return cat.split("/").pop()?.trim() ?? null;
        }
      }
    } catch {
      // ignore parse failures; fall through
    }
  }

  // 2) Breadcrumb fallback — first non-home crumb is usually the top category.
  const crumb = $(".breadcrumb a, nav[aria-label='breadcrumb'] a")
    .map((_, el) => clean($(el).text()))
    .toArray()
    .filter((s): s is string => s !== null);
  // Drop "Home" / "ホーム" only when followed by a deeper crumb to avoid
  // hiding actual ホーム category for the home-goods top page.
  const interesting = crumb.filter((c) => c !== "QVC.jp" && c !== "Home");
  return interesting[0] ?? null;
}
```

In `parseQvcProductHTML`, call `extractCategoryFromHTML($)` and include `category` in the returned object.

- [ ] **Step 2: Verify against fixture**

If fixtures are available for a QVC product page (`scripts/fixtures/qvc-product-*.html`), run the parser. Otherwise verify live:

```bash
npx tsx --env-file=.env.local -e "
import { fetchQvcProduct } from './lib/qvc-products/fetcher';
const d = await fetchQvcProduct('754899');
console.log({ id: d?.id, name: d?.name, category: d?.category });
"
```

Expected: `category` is a non-empty Japanese string matching one of the QVC whitelist values (or close to it — normalization handled in Task 4).

- [ ] **Step 3: Update enrich to persist category**

In `lib/qvc-products/enrich.ts`, locate the upsert call and add `category: detail.category` to the row payload.

- [ ] **Step 4: Commit**

```bash
git add lib/qvc-products/fetcher.ts lib/qvc-products/enrich.ts
git commit -m "feat(category): qvc product parser extracts category"
```

---

## Task 3: Category filter helper

**Files:**
- Create: `lib/broadcasts/category-filter.ts`
- Modify: `lib/broadcasts/types.ts` — add `category: string | null` to `ScrapedSlot`

- [ ] **Step 1: Write the helper**

```ts
// lib/broadcasts/category-filter.ts
import { getServiceClient } from "@/lib/supabase";

/**
 * Normalize a category string: trim + NFKC unicode form so 全角/半角 mismatches
 * between site HTML and seed text don't cause false-negatives in the
 * whitelist match.
 */
export function normalizeCategory(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.normalize("NFKC").replace(/\s+/g, "").trim() || null;
}

let cache: { byChannel: Map<string, Set<string>>; loadedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Load the whitelist (channel → Set<normalized category>) once per crawl
 * with a 5-minute in-process cache so the daily cron makes a single DB
 * call regardless of slot count.
 */
export async function loadWhitelist(force = false): Promise<Map<string, Set<string>>> {
  if (!force && cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.byChannel;
  }
  const sb = getServiceClient();
  const { data, error } = await sb
    .from("channel_categories")
    .select("channel, category")
    .eq("is_allowed", true);
  if (error || !data) {
    console.warn("[category-filter] loadWhitelist failed:", error?.message);
    cache = { byChannel: new Map(), loadedAt: Date.now() };
    return cache.byChannel;
  }
  const byChannel = new Map<string, Set<string>>();
  for (const row of data as { channel: string; category: string }[]) {
    const set = byChannel.get(row.channel) ?? new Set();
    const norm = normalizeCategory(row.category);
    if (norm) set.add(norm);
    byChannel.set(row.channel, set);
  }
  cache = { byChannel, loadedAt: Date.now() };
  return byChannel;
}

export function isAllowed(
  byChannel: Map<string, Set<string>>,
  channel: string,
  category: string | null,
): boolean {
  if (!category) return false;
  const norm = normalizeCategory(category);
  if (!norm) return false;
  const set = byChannel.get(channel);
  if (!set) return false;
  return set.has(norm);
}
```

- [ ] **Step 2: Add `category` to ScrapedSlot type**

Open `lib/broadcasts/types.ts`. Inside the `ScrapedSlot` interface, add `category: string | null` (alongside existing fields).

- [ ] **Step 3: Commit**

```bash
git add lib/broadcasts/category-filter.ts lib/broadcasts/types.ts
git commit -m "feat(category): whitelist load + ScrapedSlot.category"
```

---

## Task 4: QVC scraper — attach category + drop disallowed

**Files:**
- Modify: `lib/broadcasts/qvc.ts`

The current `scrapeQVCForDate` returns slots without category. After scraping, we look up each slot's first product id in `qvc_products`, attach `category`, drop slots without an allowed category.

- [ ] **Step 1: Extract category-lookup helper**

After the existing `scrapeQVCForDate` function, add:

```ts
async function attachQVCCategories(slots: ScrapedSlot[]): Promise<ScrapedSlot[]> {
  if (slots.length === 0) return slots;
  const firstIds = slots
    .map((s) => s.product_ids?.[0])
    .filter((x): x is string => !!x);
  if (firstIds.length === 0) return slots.map((s) => ({ ...s, category: null }));

  const sb = getServiceClient();
  const { data, error } = await sb
    .from("qvc_products")
    .select("id, category")
    .in("id", firstIds);
  if (error || !data) {
    console.warn("[qvc] category lookup failed:", error?.message);
    return slots.map((s) => ({ ...s, category: null }));
  }
  const byId = new Map<string, string | null>();
  for (const row of data as { id: string; category: string | null }[]) {
    byId.set(row.id, row.category);
  }

  return slots.map((s) => {
    const fid = s.product_ids?.[0] ?? null;
    return { ...s, category: fid ? (byId.get(fid) ?? null) : null };
  });
}
```

Then in `scrapeQVCForDate`, after computing `slots`, call:

```ts
const enriched = await attachQVCCategories(slots);
const wl = await loadWhitelist();
const allowed = enriched.filter((s) => isAllowed(wl, "qvc", s.category));
return {
  channel: "qvc",
  date: iso,
  slots: allowed,
  ok: true,
  health: computeHealth(allowed, true),
};
```

Add imports:
```ts
import { getServiceClient } from "@/lib/supabase";
import { loadWhitelist, isAllowed } from "./category-filter";
```

- [ ] **Step 2: Note the chicken-and-egg edge case**

The first time a new QVC product appears, `qvc_products` won't have its category yet. The daily `enrich:qvc-products` cron runs separately to populate the cache. So today's slot may get filtered out as "no category" even if it's actually a beauty product. Add this caveat to the function's JSDoc and accept it — the slot will be re-scraped on a subsequent backfill or simply be present from the next day onward.

- [ ] **Step 3: Commit**

```bash
git add lib/broadcasts/qvc.ts
git commit -m "feat(category): QVC scraper filters slots by qvc_products.category whitelist match"
```

---

## Task 5: ShopCh Gemini classifier

**Files:**
- Create: `lib/broadcasts/shopch-category.ts`

- [ ] **Step 1: Write the classifier**

```ts
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ScrapedSlot } from "./types";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = "gemini-3-flash-preview";

const SHOPCH_CATEGORIES = [
  "靴・バッグ・小物・インナー",
  "コスメ",
  "美容・ダイエット・フィットネス",
  "ホーム・インテリア",
  "家電",
] as const;

interface GeminiResult {
  results?: Array<{ index: number; category: string | null }>;
}

/**
 * Batch-classify ShopCh slots against the 5-item whitelist using a single
 * Gemini call. Returns the input slots with `category` filled (or null for
 * "not in whitelist"). Fail-open: on Gemini error every slot gets null
 * and will be filtered out downstream — losing a day's ingest is better
 * than persisting unclassified noise.
 */
export async function classifyShopChSlots(slots: ScrapedSlot[]): Promise<ScrapedSlot[]> {
  if (slots.length === 0) return slots;

  const block = slots
    .map(
      (s, i) =>
        `[${i}] title: ${s.program_title}\n    description: ${(s.description ?? "").slice(0, 200)}`,
    )
    .join("\n\n");

  const prompt = `日本のショップチャンネル(QVCとは別社)放送スロットを以下のカテゴリのいずれか1つに分類してください。該当無しならnullを返してください。

【カテゴリ一覧 — このうち1つを正確にコピー】
- ${SHOPCH_CATEGORIES.join("\n- ")}

【スロット一覧】
${block}

【出力 — JSONのみ、前置き/後書きなし】
{
  "results": [
    {"index": 0, "category": "コスメ"},
    {"index": 1, "category": null}
  ]
}`;

  try {
    const model = genAI.getGenerativeModel({ model: MODEL_ID });
    const res = await model.generateContent(prompt);
    const text = res.response.text();
    const match = text.match(/\{[\s\S]+\}/);
    if (!match) throw new Error("no JSON in classification response");
    const parsed = JSON.parse(match[0]) as GeminiResult;
    const byIndex = new Map<number, string | null>();
    for (const r of parsed.results ?? []) {
      // Validate: must be one of the 5 or null
      if (r.category === null || (SHOPCH_CATEGORIES as readonly string[]).includes(r.category)) {
        byIndex.set(r.index, r.category);
      }
    }
    return slots.map((s, i) => ({ ...s, category: byIndex.get(i) ?? null }));
  } catch (err) {
    console.warn(
      "[shopch-category] Gemini classification failed, all slots will drop:",
      err instanceof Error ? err.message : String(err),
    );
    return slots.map((s) => ({ ...s, category: null }));
  }
}
```

- [ ] **Step 2: Smoke test**

Once Task 6 wires this in, the daily cron is the test. For an isolated dry-run, write a one-off `scripts/smoke-shopch-classify.ts` calling `classifyShopChSlots` with 2–3 mock slots, then delete the script.

- [ ] **Step 3: Commit**

```bash
git add lib/broadcasts/shopch-category.ts
git commit -m "feat(category): Gemini-based ShopCh slot classifier"
```

---

## Task 6: ShopCh scraper — Gemini + whitelist filter

**Files:**
- Modify: `lib/broadcasts/shopch.ts`

- [ ] **Step 1: Wire classifier into the scraper exit**

Locate the equivalent of `scrapeShopChForDate` (return shape `ScrapeResult`). After computing `slots`, call:

```ts
import { classifyShopChSlots } from "./shopch-category";
import { loadWhitelist, isAllowed } from "./category-filter";

// ...inside the function, after slots is built:
const classified = await classifyShopChSlots(slots);
const wl = await loadWhitelist();
const allowed = classified.filter((s) => isAllowed(wl, "shopch", s.category));
return {
  channel: "shopch",
  date: iso,
  slots: allowed,
  ok: true,
  health: computeHealth(allowed, true),
};
```

- [ ] **Step 2: Commit**

```bash
git add lib/broadcasts/shopch.ts
git commit -m "feat(category): ShopCh scraper filters slots via Gemini + whitelist"
```

---

## Task 7: persist.ts — write category column

**Files:**
- Modify: `lib/broadcasts/persist.ts`

- [ ] **Step 1: Add `category` to the insert payload**

Find the row-mapping section (probably named `slotToRow` or inline in the upsert). Add `category: slot.category` to the row object. Since the column allows NULL, no other change needed for legacy rows.

- [ ] **Step 2: Commit**

```bash
git add lib/broadcasts/persist.ts
git commit -m "feat(category): persist slot category to broadcasts table"
```

---

## Task 8: CLAUDE.md note

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append under the Broadcast Calendar section, after the crawl-observability bullet**

```markdown
- Category whitelist (Phase 1-C, `lib/broadcasts/category-filter.ts` + `channel_categories` table): every QVC + ShopCh slot gets a `category`. QVC reads from `qvc_products.category` (extracted by the product-page parser); ShopCh runs a Gemini batch classifier on `program_title + description` against a 5-item whitelist. Slots whose category isn't in the per-channel whitelist are **dropped at ingest** — they never reach `broadcasts`. The whitelist is admin-editable (`channel_categories` table, RLS: read=member, write=admin). Other OA channels in `historical_broadcasts` are not filtered (no whitelist yet); their `category` stays NULL.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE.md): document category whitelist + drop policy"
```

---

## Task 9: Typecheck, push, PR with --base #35

- [ ] **Step 1: Typecheck**

```bash
npx tsc --noEmit
```

Filter out `.next/dev/types` noise + pre-existing `scripts/*pg` errors. Expected: clean.

- [ ] **Step 2: Push**

```bash
git push -u origin feat/channel-category-whitelist
```

- [ ] **Step 3: Open PR with base = PR #35 branch (chain dependency)**

```bash
gh pr create --base feat/historical-broadcasts-and-i18n \
  --title "feat(category): per-channel whitelist for QVC + ShopCh slots" \
  --body "$(cat <<'EOF'
## Summary
Phase 1-C: attach `category` to every QVC + ShopCh slot, persist only whitelisted categories.

- QVC: product-page parser extension, category cached in `qvc_products`.
- ShopCh: Gemini batch classification of `program_title + description` against the 5-item whitelist.
- Whitelist (12 rows) seeded by migration; admin-editable.

Depends on PR #35.

## Test plan
- [ ] Apply migration in staging.
- [ ] `npm run enrich:qvc-products` populates new category column.
- [ ] Daily cron runs; verify `broadcasts.category` populated for new rows.
- [ ] Verify slots outside whitelist (e.g. グルメ・お酒) are absent from new rows.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

- **Spec coverage**: Each user requirement → task. Whitelist storage (T1), QVC category extraction (T2), shared filter helper (T3), QVC integration (T4), ShopCh AI classifier (T5), ShopCh integration (T6), persistence (T7), docs (T8), shipping (T9).
- **Decisions baked in (no placeholders)**:
  - QVC slot → category mapping uses `product_ids[0]` (first product) — single-product slots are exact; multi-product slots inherit from the first id, accepting some loss.
  - First-day-of-new-product chicken-and-egg: documented in T4 step 2. Tomorrow's run fills the gap.
  - Gemini fail-open: drop the day rather than persist unclassified rows.
  - Existing rows stay NULL; category filter does not retroactively prune.
- **Type consistency**: `ScrapedSlot.category: string | null` defined in T3, consumed by T4/T6/T7. `QvcProductDetail.category` defined in T2, queried in T4.
- **Conventions honored**: Service client used in cron paths only (filter helper + scrapers run from cron). Migrations follow existing IF-NOT-EXISTS + idempotent patterns. RLS policies match the Group B + admin-only pattern.
- **Out of scope (intentional, for follow-up)**:
  - UI: category filter chips for `BroadcastCalendar` / `HistoricalBroadcasts` — belongs in Phase 2.
  - Other OA channels (japanet/junsanpo/etc.) — no whitelist yet; can be added by extending `channel_categories`.
  - Legacy data backfill — user opted to leave NULL.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-17-channel-category-whitelist.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task with review checkpoints.
2. **Inline Execution** — Execute tasks in this session with checkpoints for review.

Which approach?
