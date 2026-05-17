# Discovery Category Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic `raw_category → whitelist_categories[]` cache layer (lazy Gemini-classified, manually editable) and swap `fetchMatchingBroadcastRows` from keyword-intersection matching to `IN (...whitelist)` exact match, lifting the production `tv_evidence` match rate from ~0% to expected ~70-80%.

**Architecture:** New table `discovered_category_normalization` (PK: raw_category, value: whitelist_categories text[]). New module `lib/discovery/category-normalize.ts` exporting `normalizeCategory` + `normalizeCategoriesBatch` (cache hit → return; miss → Gemini Flash classify against `channel_categories` whitelist → upsert → return). `tv-evidence.ts::fetchMatchingBroadcastRows` swaps keyword intersection for `IN (...)`. One-shot backfill script populates the cache; weekly `refresh-tv-evidence` cron picks up evidence with the new matching path.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres, Google Gemini Flash, tsx test scripts (project convention).

**Spec:** `docs/superpowers/specs/2026-05-17-discovery-category-normalize-design.md`

---

## File Structure

| File | Type | Responsibility |
|---|---|---|
| `supabase/migrations/2026-05-17_discovered_category_normalization.sql` | new | Cache table + index + RLS |
| `lib/discovery/category-normalize.ts` | new | Whitelist loader + Gemini batch classifier + `normalizeCategory` + `normalizeCategoriesBatch` |
| `lib/discovery/tv-evidence.ts` | modify | Swap `splitCategoryToKeywords` (only the candidate→broadcasts direction) for `normalizeCategory` + `IN (...)` filter |
| `scripts/backfill-category-normalization.ts` | new | One-shot: SELECT DISTINCT discovered_products.category → batch-classify uncached → upsert |
| `scripts/test-category-normalize-unit.ts` | new | Pure-function tests (parse response, validate against whitelist) |
| `scripts/test-category-normalize-integration.ts` | new | Live Supabase + Gemini integration test |
| `package.json` | modify | Add npm scripts: `test:category-normalize-unit`, `test:category-normalize-integration`, `test:category-normalize`, `backfill:category-normalize` |

---

## Task 1: Migration — `discovered_category_normalization` table

**Files:**
- Create: `supabase/migrations/2026-05-17_discovered_category_normalization.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Discovery category normalization cache.
-- Spec: docs/superpowers/specs/2026-05-17-discovery-category-normalize-design.md
--
-- Maps free-form discovered_products.category strings (Rakuten genres) to
-- the curated channel_categories whitelist. First-seen raw categories are
-- classified by Gemini Flash and cached here; subsequent lookups are a
-- single PK fetch.

CREATE TABLE IF NOT EXISTS discovered_category_normalization (
  raw_category         text PRIMARY KEY,
  whitelist_categories text[] NOT NULL,                  -- 0..3 elements; empty = "no whitelist match"
  source               text NOT NULL CHECK (source IN ('gemini','manual')),
  classified_at        timestamptz NOT NULL DEFAULT now(),
  notes                text                              -- admin notes on manual overrides
);

CREATE INDEX IF NOT EXISTS idx_dcn_classified_at
  ON discovered_category_normalization (classified_at DESC);

-- RLS: Group B (member/admin only). Service role bypasses for cron paths.
ALTER TABLE public.discovered_category_normalization ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "member_read" ON public.discovered_category_normalization;
CREATE POLICY "member_read" ON public.discovered_category_normalization
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member', 'admin'));

DROP POLICY IF EXISTS "admin_write" ON public.discovered_category_normalization;
CREATE POLICY "admin_write" ON public.discovered_category_normalization
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');
```

- [ ] **Step 2: Verify migration syntax**

Run: `npm run test:migrations`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-05-17_discovered_category_normalization.sql
git commit -m "feat(discovery): category normalization cache table"
```

---

## Task 2: Pure helpers — Gemini response parser + whitelist validator

**Files:**
- Create: `lib/discovery/category-normalize.ts`
- Create: `scripts/test-category-normalize-unit.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing tests**

Create `scripts/test-category-normalize-unit.ts`:

```ts
import { __test } from "../lib/discovery/category-normalize";

const { parseGeminiResponse, validateAgainstWhitelist } = __test;

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${msg}`);
	}
}

// parseGeminiResponse
const valid = '{"results":[{"index":0,"matches":["家電"]},{"index":1,"matches":[]}]}';
const parsedValid = parseGeminiResponse(valid);
assert(parsedValid.length === 2, "parses 2 results");
assert(parsedValid[0].index === 0 && parsedValid[0].matches[0] === "家電", "result[0] correct");
assert(parsedValid[1].matches.length === 0, "result[1] empty matches");

const wrapped = '```json\n{"results":[{"index":0,"matches":["コスメ"]}]}\n```';
const parsedWrapped = parseGeminiResponse(wrapped);
assert(parsedWrapped.length === 1 && parsedWrapped[0].matches[0] === "コスメ", "extracts JSON from markdown fence");

const bogus = "not json at all";
const parsedBogus = parseGeminiResponse(bogus);
assert(parsedBogus.length === 0, "returns [] on unparseable input");

const malformed = '{"results":[{"index":"not a number","matches":["家電"]}]}';
const parsedMalformed = parseGeminiResponse(malformed);
assert(parsedMalformed.length === 0, "rejects non-numeric index");

// validateAgainstWhitelist
const whitelist = new Set(["家電", "コスメ", "ホーム・インテリア"]);
assert(
	JSON.stringify(validateAgainstWhitelist(["家電", "コスメ"], whitelist)) === JSON.stringify(["家電", "コスメ"]),
	"both valid pass through",
);
assert(
	JSON.stringify(validateAgainstWhitelist(["家電", "幻覚カテゴリ"], whitelist)) === JSON.stringify(["家電"]),
	"hallucinated category dropped",
);
assert(
	validateAgainstWhitelist([], whitelist).length === 0,
	"empty input returns empty",
);
assert(
	JSON.stringify(validateAgainstWhitelist(["家電", "家電"], whitelist)) === JSON.stringify(["家電"]),
	"duplicates collapsed",
);
assert(
	validateAgainstWhitelist(["家電", "コスメ", "ホーム・インテリア", "家電"], whitelist).length === 3,
	"cap at distinct whitelist length (no spurious cap of 3)",
);

if (process.exitCode === 1) process.exit(1);
console.log("\nAll unit tests passed.");
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx tsx scripts/test-category-normalize-unit.ts`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Implement the helpers**

Create `lib/discovery/category-normalize.ts`:

```ts
/**
 * Discovery category normalization — Rakuten-genre → whitelist mapping.
 * Spec: docs/superpowers/specs/2026-05-17-discovery-category-normalize-design.md
 *
 * Caches results in discovered_category_normalization (PK: raw_category).
 * Gemini Flash classifies cache misses against the channel_categories
 * whitelist. Manual rows are protected from automatic re-classification.
 */

interface GeminiResultItem {
	index: number;
	matches: string[];
}

/**
 * Parse a Gemini response into typed items. Tolerates markdown fences,
 * extra whitespace, and surrounding text. Returns [] on any parse failure;
 * caller handles fail-open behavior.
 */
export function parseGeminiResponse(text: string): GeminiResultItem[] {
	if (!text) return [];
	const match = text.match(/\{[\s\S]+\}/);
	if (!match) return [];
	try {
		const obj = JSON.parse(match[0]) as { results?: unknown };
		if (!Array.isArray(obj.results)) return [];
		const out: GeminiResultItem[] = [];
		for (const r of obj.results) {
			if (typeof r !== "object" || r === null) continue;
			const rec = r as Record<string, unknown>;
			if (typeof rec.index !== "number" || !Number.isInteger(rec.index)) continue;
			if (!Array.isArray(rec.matches)) continue;
			const matches = rec.matches.filter((m): m is string => typeof m === "string");
			out.push({ index: rec.index, matches });
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Drop hallucinated categories (not in whitelist) and deduplicate.
 * Preserves input order of first occurrence.
 */
export function validateAgainstWhitelist(
	matches: string[],
	whitelist: Set<string>,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of matches) {
		if (!whitelist.has(m)) continue;
		if (seen.has(m)) continue;
		seen.add(m);
		out.push(m);
	}
	return out;
}

export const __test = {
	parseGeminiResponse,
	validateAgainstWhitelist,
};
```

- [ ] **Step 4: Add npm script + re-run tests**

Modify `package.json`, insert near other `test:` scripts:

```json
"test:category-normalize-unit": "tsx scripts/test-category-normalize-unit.ts",
```

Run: `npm run test:category-normalize-unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/discovery/category-normalize.ts scripts/test-category-normalize-unit.ts package.json
git commit -m "feat(discovery): category-normalize pure helpers + unit tests"
```

---

## Task 3: Whitelist loader + Gemini batch classifier (no caching yet)

**Files:**
- Modify: `lib/discovery/category-normalize.ts`
- Modify: `scripts/test-category-normalize-unit.ts`

- [ ] **Step 1: Extend unit tests for buildPrompt**

Append to `scripts/test-category-normalize-unit.ts` (before the `if (process.exitCode)` check):

```ts
import { __test as __test2 } from "../lib/discovery/category-normalize";
const { buildPrompt } = __test2;

const prompt = buildPrompt(["家電", "コスメ"], ["自動 豆乳 メーカー", "口紅"]);
assert(prompt.includes("家電") && prompt.includes("コスメ"), "prompt includes whitelist");
assert(prompt.includes("[0] 自動 豆乳 メーカー"), "prompt includes input 0");
assert(prompt.includes("[1] 口紅"), "prompt includes input 1");
assert(prompt.includes("results"), "prompt asks for JSON results array");
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:category-normalize-unit`
Expected: FAIL — `buildPrompt is not exported`.

- [ ] **Step 3: Implement loadWhitelist + buildPrompt + classifyBatchViaGemini**

Append to `lib/discovery/category-normalize.ts`:

```ts
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { SupabaseClient } from "@supabase/supabase-js";

const MODEL_ID = "gemini-3-flash-preview";
const BATCH_SIZE = 50; // matches ShopCh classifier batching

let _genAI: GoogleGenerativeAI | null = null;
function genAI(): GoogleGenerativeAI {
	if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
	return _genAI;
}

/**
 * Load distinct whitelist categories from channel_categories. Returns the
 * union across all channels — we don't differentiate per-channel for
 * normalization since broadcasts.category is queried by exact value
 * across both shopch and qvc.
 *
 * Fail-open: empty array on DB error (caller treats as "no whitelist
 * available" → classification skipped).
 */
export async function loadWhitelist(sb: SupabaseClient): Promise<string[]> {
	const { data, error } = await sb
		.from("channel_categories")
		.select("category")
		.eq("is_allowed", true);
	if (error || !data) {
		console.warn(`[category-normalize] whitelist load failed: ${error?.message ?? "no data"}`);
		return [];
	}
	const seen = new Set<string>();
	for (const row of data as Array<{ category: string }>) {
		if (row.category) seen.add(row.category);
	}
	return [...seen].sort();
}

/**
 * Build the Gemini classification prompt. Pure function — testable without
 * the API key.
 */
export function buildPrompt(whitelist: string[], inputs: string[]): string {
	const inputBlock = inputs.map((s, i) => `[${i}] ${s}`).join("\n");
	return `日本の家庭用通販商品のカテゴリ文字列を、以下のホワイトリストに分類してください。
複数該当する場合は最大3つ、該当無しは空配列を返してください。
ホワイトリストにない文字列は絶対に出力しないでください。

【ホワイトリスト — このうちから正確にコピー】
- ${whitelist.join("\n- ")}

【入力】
${inputBlock}

【出力 — JSONのみ、前置き/後書きなし】
{ "results": [
  {"index": 0, "matches": ["家電"]},
  {"index": 1, "matches": []}
]}`;
}

/**
 * Single Gemini call to classify a batch of raw categories against the
 * whitelist. Returns a Map keyed by input string → matched whitelist
 * categories (validated, hallucinations dropped).
 *
 * Fail-open: returns an empty map on any error. Callers should treat
 * missing keys as "did not classify; do NOT cache" (no negative caching
 * on failure).
 */
export async function classifyBatchViaGemini(
	whitelist: string[],
	inputs: string[],
): Promise<Map<string, string[]>> {
	if (inputs.length === 0 || whitelist.length === 0) return new Map();

	const prompt = buildPrompt(whitelist, inputs);
	const whitelistSet = new Set(whitelist);

	try {
		const model = genAI().getGenerativeModel({ model: MODEL_ID });
		const res = await model.generateContent(prompt);
		const text = res.response.text();
		const parsed = parseGeminiResponse(text);
		const out = new Map<string, string[]>();
		for (const item of parsed) {
			if (item.index < 0 || item.index >= inputs.length) continue;
			const validated = validateAgainstWhitelist(item.matches, whitelistSet).slice(0, 3);
			out.set(inputs[item.index], validated);
		}
		return out;
	} catch (err) {
		console.warn(
			`[category-normalize] Gemini classification failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return new Map();
	}
}

// Extend __test export
Object.assign(__test, {
	loadWhitelist,
	buildPrompt,
	classifyBatchViaGemini,
	BATCH_SIZE,
});
```

- [ ] **Step 4: Run tests**

Run: `npm run test:category-normalize-unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/discovery/category-normalize.ts scripts/test-category-normalize-unit.ts
git commit -m "feat(discovery): category-normalize whitelist loader + Gemini classifier"
```

---

## Task 4: `normalizeCategory` + `normalizeCategoriesBatch` (cache integration)

**Files:**
- Modify: `lib/discovery/category-normalize.ts`
- Create: `scripts/test-category-normalize-integration.ts`
- Modify: `package.json`

- [ ] **Step 1: Implement the cache-aware public API**

Append to `lib/discovery/category-normalize.ts`:

```ts
interface CacheRow {
	raw_category: string;
	whitelist_categories: string[];
}

/**
 * Normalize a single raw category. Cache hit → immediate. Miss → Gemini
 * single-item classify (batch of 1) → upsert → return. Returns [] on
 * null/empty input or any failure (fail-open).
 *
 * Does NOT overwrite rows with source='manual'.
 */
export async function normalizeCategory(
	sb: SupabaseClient,
	rawCategory: string | null,
): Promise<string[]> {
	const raw = (rawCategory ?? "").trim();
	if (!raw) return [];

	// Cache hit?
	const hit = await sb
		.from("discovered_category_normalization")
		.select("whitelist_categories")
		.eq("raw_category", raw)
		.maybeSingle();
	if (hit.data) return hit.data.whitelist_categories as string[];

	// Miss → classify
	const whitelist = await loadWhitelist(sb);
	if (whitelist.length === 0) return [];

	const batch = await classifyBatchViaGemini(whitelist, [raw]);
	if (!batch.has(raw)) return []; // classification failed; do NOT cache

	const matches = batch.get(raw)!;
	await sb
		.from("discovered_category_normalization")
		.upsert(
			{ raw_category: raw, whitelist_categories: matches, source: "gemini" },
			{ onConflict: "raw_category", ignoreDuplicates: false },
		);
	return matches;
}

/**
 * Batch version for cron / backfill. Dedups input, fetches cached hits
 * in one IN(...) query, classifies misses in chunks of BATCH_SIZE, upserts,
 * returns a Map for every distinct input (empty array for failed
 * classifications — but those entries are NOT cached so the next call
 * will retry).
 */
export async function normalizeCategoriesBatch(
	sb: SupabaseClient,
	rawCategories: string[],
): Promise<Map<string, string[]>> {
	const deduped = [...new Set(rawCategories.map((s) => s.trim()).filter(Boolean))];
	if (deduped.length === 0) return new Map();

	const result = new Map<string, string[]>();
	for (const raw of deduped) result.set(raw, []); // default

	// Bulk cache lookup
	const hits = await sb
		.from("discovered_category_normalization")
		.select("raw_category, whitelist_categories")
		.in("raw_category", deduped);
	if (hits.data) {
		for (const row of hits.data as CacheRow[]) {
			result.set(row.raw_category, row.whitelist_categories);
		}
	}

	const misses = deduped.filter((r) => !hits.data?.some((h: CacheRow) => h.raw_category === r));
	if (misses.length === 0) return result;

	const whitelist = await loadWhitelist(sb);
	if (whitelist.length === 0) return result;

	for (let i = 0; i < misses.length; i += BATCH_SIZE) {
		const chunk = misses.slice(i, i + BATCH_SIZE);
		const classified = await classifyBatchViaGemini(whitelist, chunk);
		const upserts: Array<{ raw_category: string; whitelist_categories: string[]; source: "gemini" }> = [];
		for (const raw of chunk) {
			if (!classified.has(raw)) continue; // classification failed for this row — skip caching
			const matches = classified.get(raw)!;
			result.set(raw, matches);
			upserts.push({ raw_category: raw, whitelist_categories: matches, source: "gemini" });
		}
		if (upserts.length > 0) {
			const upd = await sb
				.from("discovered_category_normalization")
				.upsert(upserts, { onConflict: "raw_category", ignoreDuplicates: false });
			if (upd.error) {
				console.warn(`[category-normalize] batch upsert failed: ${upd.error.message}`);
			}
		}
	}
	return result;
}
```

- [ ] **Step 2: Write integration test**

Create `scripts/test-category-normalize-integration.ts`:

```ts
import { normalizeCategory, normalizeCategoriesBatch } from "../lib/discovery/category-normalize";
import { getServiceClient } from "../lib/supabase";

if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.GEMINI_API_KEY) {
	console.error("SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY missing; skipping live test.");
	process.exit(0);
}

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${msg}`);
	}
}

async function main() {
	const sb = getServiceClient();

	// Use a deliberately unusual fake raw category so we exercise the miss + upsert path
	// without polluting common production rows.
	const fakeRaw = `__test_${Date.now()}_家電`;

	console.log(`\n=== normalizeCategory (cache miss) ===`);
	const first = await normalizeCategory(sb, fakeRaw);
	console.log(`first call result: ${JSON.stringify(first)}`);
	assert(Array.isArray(first), "returns array");

	console.log(`\n=== normalizeCategory (cache hit) ===`);
	const second = await normalizeCategory(sb, fakeRaw);
	console.log(`second call result: ${JSON.stringify(second)}`);
	assert(JSON.stringify(first) === JSON.stringify(second), "cache hit returns same result");

	console.log(`\n=== normalizeCategoriesBatch ===`);
	const batchInputs = [fakeRaw, `__test_${Date.now()}_コスメ`];
	const batch = await normalizeCategoriesBatch(sb, batchInputs);
	console.log(`batch size: ${batch.size}, entries:`, [...batch.entries()]);
	assert(batch.size === 2, "batch returns entry per distinct input");

	// Cleanup test rows
	await sb
		.from("discovered_category_normalization")
		.delete()
		.like("raw_category", "__test_%");
	console.log(`\n=== Cleanup done ===`);

	if (process.exitCode === 1) process.exit(1);
	console.log("\nIntegration test passed.");
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
```

- [ ] **Step 3: Add npm scripts**

Modify `package.json`:

```json
"test:category-normalize-integration": "tsx --env-file=.env.local scripts/test-category-normalize-integration.ts",
"test:category-normalize": "npm run test:category-normalize-unit && npm run test:category-normalize-integration",
```

- [ ] **Step 4: Run integration test**

Run: `npm run test:category-normalize-integration`
Expected: PASS — produces sensible classifications + cache hit on second call. (Test inserts and cleans up `__test_*` rows so no production pollution.)

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/discovery/category-normalize.ts scripts/test-category-normalize-integration.ts package.json
git commit -m "feat(discovery): normalizeCategory + Batch with cache integration"
```

---

## Task 5: `tv-evidence.ts` integration — swap keyword intersect for whitelist `IN (...)`

**Files:**
- Modify: `lib/discovery/tv-evidence.ts`

- [ ] **Step 1: Read existing fetchMatchingBroadcastRows (lines 220-340 area)**

Locate the function. The current category-matching logic uses `splitCategoryToKeywords` on the candidate, then in-process iterates broadcast rows calling `categoryMatches(row.category)` (which also splits the broadcast category and checks keyword intersection).

- [ ] **Step 2: Replace candidate-side matching with normalize + IN(...)**

Edit `fetchMatchingBroadcastRows`:

1. Add import at top of file:
```ts
import { normalizeCategory } from "./category-normalize";
```

2. Replace the early-out and queries:

```ts
// Replace:
//   const categoryKeywords = splitCategoryToKeywords(candidate.category ?? "");
//   if (categoryKeywords.length === 0) return [];
// With:
const whitelistCategories = await normalizeCategory(sb, candidate.category);
if (whitelistCategories.length === 0) return [];
```

3. Change both broadcast queries from `.not("category", "is", null)` to `.in("category", whitelistCategories)`:

```ts
const bRes = await sb
  .from("broadcasts")
  .select("channel, air_date, start_time, program_title, category, product_ids")
  .gte("air_date", cutoff)
  .in("category", whitelistCategories);   // <-- changed

const hRes = await sb
  .from("historical_broadcasts")
  .select("channel, air_date, product_name, price_jpy, category")
  .gte("air_date", cutoff)
  .in("category", whitelistCategories);   // <-- changed
```

4. Remove the in-process `categoryMatches` helper (lines around 281-284) and its call sites:
```ts
// Remove:
//   const candidateKwSet = new Set(categoryKeywords);
//   function categoryMatches(broadcastCategory: string): boolean { ... }
// And in the row loops:
//   if (!row.category || !categoryMatches(row.category)) continue;
// Replace with:
//   if (!row.category) continue;   // <-- IN(...) already filtered, defensive only
```

Keep the corroboration filter (`priceMatches(...) || nameMatches(...) || noCorroborationAvailable`) unchanged.

5. Update `computeTvEvidence` to pass whitelist categories into `match_basis`:

```ts
// Inside computeTvEvidence, after fetchMatchingBroadcastRows returns:
return aggregateBroadcastRows(rows, {
  category_keywords: whitelistCategories,   // <-- now whitelist labels, not keyword tokens
  price_band: priceBandFor(candidate.price_jpy),
  name_tokens: tokenizeName(candidate.name),
});
```

This requires `computeTvEvidence` to call `normalizeCategory` itself (so it has the list to pass), OR `fetchMatchingBroadcastRows` returns the whitelist alongside rows. Simpler: call `normalizeCategory` once inside `computeTvEvidence`, reuse the result for both the fetch and the basis.

Refactor:

```ts
export async function computeTvEvidence(
  sb: SupabaseClient,
  candidate: CandidateInput,
): Promise<TvEvidence | null> {
  const whitelistCategories = await normalizeCategory(sb, candidate.category);
  if (whitelistCategories.length === 0) return null;

  const rows = await fetchMatchingBroadcastRows(sb, candidate, whitelistCategories);
  if (rows.length === 0) return null;

  return aggregateBroadcastRows(rows, {
    category_keywords: whitelistCategories,
    price_band: priceBandFor(candidate.price_jpy),
    name_tokens: tokenizeName(candidate.name),
  });
}
```

And update `fetchMatchingBroadcastRows` signature to accept the pre-computed list:

```ts
export async function fetchMatchingBroadcastRows(
  sb: SupabaseClient,
  candidate: CandidateInput,
  whitelistCategories?: string[],   // optional for backwards-compatible direct calls
): Promise<BroadcastRow[]> {
  const resolved = whitelistCategories ?? (await normalizeCategory(sb, candidate.category));
  if (resolved.length === 0) return [];
  // ... rest uses `resolved` in the IN(...) clauses
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run existing tv-evidence test suite**

Run: `npm run test:tv-evidence`
Expected: unit pass; integration soft-pass (no category match still acceptable but should be different now — cache lookups may need backfill to be meaningful).

- [ ] **Step 5: Commit**

```bash
git add lib/discovery/tv-evidence.ts
git commit -m "feat(discovery): tv-evidence matches via normalized whitelist categories"
```

---

## Task 6: Backfill script

**Files:**
- Create: `scripts/backfill-category-normalization.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the backfill script**

Create `scripts/backfill-category-normalization.ts`:

```ts
import { normalizeCategoriesBatch } from "../lib/discovery/category-normalize";
import { getServiceClient } from "../lib/supabase";

async function main() {
	const sb = getServiceClient();
	const start = Date.now();

	console.log("Loading distinct categories from discovered_products...");
	const { data: distinctRows, error } = await sb
		.from("discovered_products")
		.select("category")
		.not("category", "is", null);
	if (error) {
		console.error("Failed to load categories:", error.message);
		process.exit(1);
	}
	const distinct = [...new Set((distinctRows ?? []).map((r) => r.category as string).filter(Boolean))];
	console.log(`  → ${distinct.length} distinct raw categories`);

	console.log("Filtering already-cached...");
	const { data: cached } = await sb
		.from("discovered_category_normalization")
		.select("raw_category");
	const cachedSet = new Set((cached ?? []).map((r) => r.raw_category as string));
	const todo = distinct.filter((c) => !cachedSet.has(c));
	console.log(`  → ${cachedSet.size} cached, ${todo.length} to classify`);

	if (todo.length === 0) {
		console.log("Nothing to do.");
		return;
	}

	console.log("Classifying via Gemini...");
	const results = await normalizeCategoriesBatch(sb, todo);

	let withMatches = 0;
	let empty = 0;
	for (const [, matches] of results) {
		if (matches.length > 0) withMatches += 1;
		else empty += 1;
	}

	console.log(JSON.stringify({
		event: "backfill-category-normalization.summary",
		distinct: distinct.length,
		previouslyCached: cachedSet.size,
		newlyClassified: results.size,
		withMatches,
		empty,
		durationMs: Date.now() - start,
	}, null, 2));
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
```

- [ ] **Step 2: Add npm script**

Modify `package.json`:

```json
"backfill:category-normalize": "tsx --env-file=.env.local scripts/backfill-category-normalization.ts",
```

- [ ] **Step 3: Type-check (don't actually run backfill yet — wait for migration apply)**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-category-normalization.ts package.json
git commit -m "feat(discovery): category-normalize backfill script"
```

---

## Task 7: Final verification

- [ ] **Step 1: Type-check + lint**

```bash
npx tsc --noEmit          # expect 0 errors
npm run lint              # expect no new errors (test scripts may have minor warnings)
```

- [ ] **Step 2: Run full test suite for this feature**

```bash
npm run test:category-normalize    # unit + integration
npm run test:tv-evidence            # ensure tv-evidence regressions not introduced
```

- [ ] **Step 3: File inventory check**

Confirm exist:
- `supabase/migrations/2026-05-17_discovered_category_normalization.sql`
- `lib/discovery/category-normalize.ts`
- `scripts/test-category-normalize-unit.ts`
- `scripts/test-category-normalize-integration.ts`
- `scripts/backfill-category-normalization.ts`
- `docs/superpowers/specs/2026-05-17-discovery-category-normalize-design.md`
- `docs/superpowers/plans/2026-05-17-discovery-category-normalize.md`

Confirm modified:
- `lib/discovery/tv-evidence.ts` (fetchMatchingBroadcastRows + computeTvEvidence signature)
- `package.json` (4 new scripts)

- [ ] **Step 4: Print branch summary**

```bash
git log --oneline main..HEAD
git diff --stat main..HEAD
```

- [ ] **Step 5: Status report**

Output:
- All tsc + tests results
- Commit count
- Known limitations (e.g. "real-world match rate verification requires migration apply + backfill run, not in scope for this verification step")
- READY_FOR_REVIEW or NEEDS_FIXES

DO NOT apply migration to prod, DO NOT run backfill against prod, DO NOT push. Those are user-coordinated post-merge steps.

---

## Self-Review (completed during plan write)

1. **Spec coverage:** §3 schema → Task 1. §4 module → Tasks 2-4. §5 tv-evidence integration → Task 5. §6 backfill → Task 6. §7 cron interaction is unchanged (no plan task — refresh-tv-evidence picks up new code automatically). §9 failure modes covered by fail-open behavior throughout. §10 RLS in Task 1 migration. §11 perf intrinsic to design. §12 test plan → unit (Tasks 2-3) + integration (Task 4). §13 rollout → Task 7 + user-coordinated post-merge steps.

2. **Placeholders:** None found. `<id>` etc. in user-facing prose are intentional run-time variables.

3. **Type consistency:** `parseGeminiResponse` returns `GeminiResultItem[]` in Task 2; `classifyBatchViaGemini` consumes that in Task 3; `normalizeCategory`/`normalizeCategoriesBatch` consume `classifyBatchViaGemini` in Task 4 — chain is consistent. The `fetchMatchingBroadcastRows` signature change in Task 5 (optional 3rd param) is backwards-compatible for any out-of-tree callers (there are none in this repo, but defensive).

4. **Scope:** Single PR, single worktree, ~7 implementation commits + 2 doc commits. Touches one new module, one existing module, one new table. Backfill is a separate script that user runs post-deploy. Compact and focused.
