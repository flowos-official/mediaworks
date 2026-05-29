# Fast Preview Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the MD-strategy streaming preview surface real instances of the searched product (e.g. 包丁) within ~1s, replacing the generic pool preview, without depending on `PHASE_0_5_SEARCH_INTENT_ENABLED`.

**Architecture:** A new pure-ish module `lib/strategy/fast-preview-search.ts` derives a preview keyword (`specific_keyword.normalized ?? category_hints[0]`), runs ONE Rakuten keyword search, and maps results to `DiscoveredProduct[]`. A new workflow step in `lib/workflows/md-strategy.workflow.ts` runs it right after the pool preview and emits a second `preliminary_discovery` event (client already replaces on it — no client change). Display-only; nothing persisted.

**Tech Stack:** TypeScript, Next.js workflow steps (`"use step"`), Rakuten Ichiba API client (`lib/rakuten.ts`), tsx smoke scripts.

**Spec:** `docs/superpowers/specs/2026-05-29-fast-preview-search-design.md`

---

## File Structure

- **Create** `lib/strategy/fast-preview-search.ts` — `derivePreviewKeyword`, `runFastPreviewSearch`, `mergePreviewByKeyword`, internal `rakutenItemToDiscoveredProduct`. No `import "server-only"` (must be tsx-importable per CLAUDE.md).
- **Create** `scripts/test-fast-preview.ts` — deterministic unit assertions for keyword derivation + merge, plus a creds-guarded live Rakuten check.
- **Modify** `lib/workflows/md-strategy.workflow.ts` — add `runFastPreviewSearchStep` + a second `preliminary_discovery` emit; add import.
- **Modify** `package.json` — add `test:fast-preview` script.

---

### Task 1: `fast-preview-search.ts` — keyword derivation (TDD, pure)

**Files:**
- Create: `lib/strategy/fast-preview-search.ts`
- Test: `scripts/test-fast-preview.ts`

- [ ] **Step 1: Write the failing test** — create `scripts/test-fast-preview.ts`:

```ts
import { derivePreviewKeyword, mergePreviewByKeyword, runFastPreviewSearch } from "@/lib/strategy/fast-preview-search";
import { emptyDiscoverIntent } from "@/lib/strategy/discover-intent";
import type { DiscoveredProduct } from "@/lib/md-strategy";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { console.log(`PASS: ${msg}`); }
  else { console.error(`FAIL: ${msg}`); failures++; }
}

// 1) specific_keyword.normalized takes priority (flag ON)
const iSpecific = emptyDiscoverIntent();
iSpecific.intent_tier = "specific_keyword";
iSpecific.specific_keyword = { raw: "包丁", normalized: "包丁", aliases: ["ナイフ"], confidence: 0.95 };
iSpecific.category_hints = ["キッチン用品"];
assert(derivePreviewKeyword(iSpecific) === "包丁", "specific_keyword.normalized wins");

// 2) category_hints[0] fallback (flag OFF — legacy prompt still fills category_hints)
const iBroad = emptyDiscoverIntent();
iBroad.category_hints = ["包丁", "三徳包丁"];
assert(derivePreviewKeyword(iBroad) === "包丁", "category_hints[0] fallback when no specific_keyword");

// 3) null when no signal
assert(derivePreviewKeyword(emptyDiscoverIntent()) === null, "null when no keyword signal");
assert(derivePreviewKeyword(undefined) === null, "null for undefined intent");

// 4) mergePreviewByKeyword: pool keyword-matches first, dedup by source_url
const pool = [
  { name: "スーパーストーンバリア包丁", source_url: "u1" } as DiscoveredProduct,
  { name: "EMSストレッチブーツ", source_url: "u2" } as DiscoveredProduct,
];
const fresh = [
  { name: "三徳包丁 18cm", source_url: "u3" } as DiscoveredProduct,
  { name: "スーパーストーンバリア包丁", source_url: "u1" } as DiscoveredProduct, // dup url
];
const merged = mergePreviewByKeyword(pool, fresh, "包丁");
assert(merged.length === 2, "merge dedups u1 → [u1, u3]");
assert(merged[0].source_url === "u1", "pool knife match placed first");
assert(!merged.some((m) => m.source_url === "u2"), "non-matching pool item not injected");

// 5) live integration (guarded on Rakuten creds)
(async () => {
  if (process.env.RAKUTEN_APPLICATION_ID && process.env.RAKUTEN_ACCESS_KEY) {
    const products = await runFastPreviewSearch({ intent: iBroad });
    assert(products.length > 0, "live Rakuten returns products for 包丁");
    const knifeish = products.filter((p) => /包丁|ナイフ|三徳|牛刀|ペティ/.test(p.name)).length;
    console.log(`[live] ${products.length} products, ${knifeish} knife-ish`);
    assert(knifeish > 0, "≥1 knife-ish product from live search");
  } else {
    console.log("SKIP live: no Rakuten creds");
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --env-file=.env.local scripts/test-fast-preview.ts`
Expected: FAIL — `Cannot find module '@/lib/strategy/fast-preview-search'` (module not created yet).

- [ ] **Step 3: Create `lib/strategy/fast-preview-search.ts` with keyword derivation + merge + mapping + search**

```ts
/**
 * Fast preview search — runs ONE Rakuten keyword search so the streaming
 * preview surfaces the actually-searched product (~1s) instead of the
 * generic pool top. Display-only: results are NOT persisted (the final
 * curated discoverNewProducts owns persistence). Independent of the
 * PHASE_0_5_SEARCH_INTENT_ENABLED flag — falls back to category_hints[0],
 * which the legacy goal prompt still populates when the flag is off.
 *
 * No `import "server-only"` — this module is imported directly by
 * scripts/test-fast-preview.ts under tsx (see CLAUDE.md).
 */
import { rakutenItemSearch, rakutenRankingSearch, type RakutenItem } from "@/lib/rakuten";
import type { DiscoverIntent } from "@/lib/strategy/discover-intent";
import type { DiscoveredProduct } from "@/lib/md-strategy";

const PREVIEW_TARGET = 15;
const PREVIEW_FETCH = 12;

/** specific_keyword.normalized (flag on) ?? first non-empty category_hint (flag off) ?? null. */
export function derivePreviewKeyword(intent: DiscoverIntent | null | undefined): string | null {
  if (!intent) return null;
  const sk = intent.specific_keyword?.normalized?.trim();
  if (sk) return sk;
  const cat = intent.category_hints?.find((c) => c.trim().length > 0)?.trim();
  return cat && cat.length > 0 ? cat : null;
}

function parsePriceRangeLocal(priceRange: string): { min: number; max: number } | null {
  const cleaned = priceRange.replace(/[¥,、]/g, "").replace(/〜/g, "-");
  const match = cleaned.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (!match) return null;
  return { min: parseInt(match[1], 10), max: parseInt(match[2], 10) };
}

function formatPriceJpy(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return "価格未取得";
  return `¥${price.toLocaleString("ja-JP")}`;
}

function rakutenItemToDiscoveredProduct(item: RakutenItem): DiscoveredProduct {
  const popularity =
    item.reviewCount && item.reviewAverage
      ? `レビュー${item.reviewCount}件・平均★${item.reviewAverage.toFixed(1)}`
      : "—";
  // Honest social-proof proxy (NOT a fabricated TV-fit): review avg → 0-100.
  const reviewProxy = Math.min(100, Math.max(0, Math.round((item.reviewAverage ?? 0) * 20)));
  return {
    name: item.itemName.slice(0, 80),
    reason: "検索結果（暫定） — 戦略分析完了後に精緻化されます",
    japan_fit_score: reviewProxy,
    estimated_demand: item.reviewCount > 0 ? `レビュー${item.reviewCount}件` : "—",
    supply_source: item.shopName || "楽天",
    estimated_price_jpy: formatPriceJpy(item.itemPrice),
    source: "rakuten",
    source_url: item.itemUrl,
    signal_basis: `楽天検索（暫定） ${popularity}`,
    japan_market_fit: {
      popularity_evidence: popularity,
      trend_context: "検索結果（暫定）",
      why_japan_now: "暫定先行表示 — 戦略分析完了後に精緻化されます",
    },
    pool_source: "fresh_search",
  };
}

export interface FastPreviewSearchInput {
  intent?: DiscoverIntent;
  priceRange?: string;
}

/** Run ONE Rakuten keyword search and map to DiscoveredProduct[]. [] on no-keyword / failure / empty. */
export async function runFastPreviewSearch(
  input: FastPreviewSearchInput,
): Promise<DiscoveredProduct[]> {
  const keyword = derivePreviewKeyword(input.intent);
  if (!keyword) return [];
  try {
    let res = await rakutenItemSearch(keyword, "-reviewCount", PREVIEW_FETCH);
    if (res.items.length === 0) res = await rakutenRankingSearch(keyword);
    const priceRange = input.priceRange ? parsePriceRangeLocal(input.priceRange) : null;
    const seen = new Set<string>();
    const products: DiscoveredProduct[] = [];
    for (const item of res.items) {
      if (!item.itemUrl || !item.itemName || seen.has(item.itemUrl)) continue;
      if (priceRange && item.itemPrice > 0 && (item.itemPrice < priceRange.min || item.itemPrice > priceRange.max)) continue;
      seen.add(item.itemUrl);
      products.push(rakutenItemToDiscoveredProduct(item));
      if (products.length >= PREVIEW_TARGET) break;
    }
    return products;
  } catch (err) {
    console.warn(`[fast-preview] search failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Merge pool rows whose name contains the preview keyword (higher-signal,
 * e.g. a TV-channel 包丁) ahead of the fresh Rakuten results, de-duped by
 * source_url, capped at `target`. Non-matching pool rows are dropped.
 */
export function mergePreviewByKeyword(
  pool: DiscoveredProduct[],
  fresh: DiscoveredProduct[],
  keyword: string | null,
  target = PREVIEW_TARGET,
): DiscoveredProduct[] {
  const needle = keyword?.toLowerCase().trim() ?? "";
  const poolMatches =
    needle.length >= 2 ? pool.filter((p) => p.name.toLowerCase().includes(needle)) : [];
  const merged: DiscoveredProduct[] = [];
  const seen = new Set<string>();
  for (const p of [...poolMatches, ...fresh]) {
    if (!p.source_url || seen.has(p.source_url)) continue;
    seen.add(p.source_url);
    merged.push(p);
    if (merged.length >= target) break;
  }
  return merged;
}
```

- [ ] **Step 4: Run test to verify deterministic assertions pass**

Run: `npx tsx --env-file=.env.local scripts/test-fast-preview.ts`
Expected: PASS for assertions 1-4; assertion 5 either PASS (`[live] N products, M knife-ish`) or `SKIP live`. Final line `ALL PASS`, exit 0.

- [ ] **Step 5: Run tsc**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/strategy/fast-preview-search.ts scripts/test-fast-preview.ts
git commit -m "feat(strategy): fast-preview Rakuten search module (flag-independent preview keyword)"
```

---

### Task 2: Add `test:fast-preview` npm script

**Files:**
- Modify: `package.json` (scripts block, near other `test:*` entries)

- [ ] **Step 1: Add the script line** — in `package.json` `"scripts"`, add alongside the existing `test:*` entries:

```json
"test:fast-preview": "tsx --env-file=.env.local scripts/test-fast-preview.ts",
```

- [ ] **Step 2: Verify it runs**

Run: `npm run test:fast-preview`
Expected: same output as Task 1 Step 4 (`ALL PASS`).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(strategy): add test:fast-preview script"
```

---

### Task 3: Wire fast-preview into the MD workflow

**Files:**
- Modify: `lib/workflows/md-strategy.workflow.ts` (import; new step fn; second emit in entrypoint)

- [ ] **Step 1: Add the import** — extend the existing import from `@/lib/strategy/intent-projection` area; add a new import line near line 18-20:

```ts
import { runFastPreviewSearch, derivePreviewKeyword, mergePreviewByKeyword } from "@/lib/strategy/fast-preview-search";
```

- [ ] **Step 2: Add the step function** — insert after `runPreliminaryDiscoveryStep` (after its `runPreliminaryDiscoveryStep.maxRetries = 0;`, ~line 189):

```ts
// ---------------------------------------------------------------------------
// Step: fast preview search — ONE Rakuten keyword search so the hero shows the
// actually-searched product (~1s) instead of the generic pool top. Runs right
// after the pool preview; emits a second preliminary_discovery event that the
// client replaces the preview with. Display-only (not persisted). Independent
// of the Phase 0.5 flag (keyword falls back to category_hints[0]).
// ---------------------------------------------------------------------------
async function runFastPreviewSearchStep(
	input: MDWorkflowInput,
	preliminary: DiscoveredProduct[],
	parsedGoal: ParsedGoal | null,
): Promise<DiscoveredProduct[]> {
	"use step";
	try {
		const intent = parsedGoal ? projectParsedGoalToIntent(parsedGoal) : undefined;
		const fresh = await runFastPreviewSearch({ intent, priceRange: input.priceRange });
		if (fresh.length === 0) return [];
		const merged = mergePreviewByKeyword(preliminary, fresh, derivePreviewKeyword(intent));
		console.log(`[md-workflow] fast preview: ${merged.length} products (fresh=${fresh.length})`);
		return merged;
	} catch (err) {
		console.warn(
			`[md-workflow] fast preview failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
		);
		return [];
	}
}
runFastPreviewSearchStep.maxRetries = 0;
```

- [ ] **Step 2b: Run tsc to confirm the new step compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Emit the second preview** — in `mdStrategyWorkflow`, immediately AFTER the preliminary emit block (the `await emitProgressStep({ skill: "preliminary_discovery", status: "complete", ... data: { products: preliminary } });` ending ~line 350) and BEFORE `const outputs: Record<string, unknown> = {};`, insert:

```ts
	// Replace the pool preview with a fast keyword search (~1s) so the hero
	// shows the actually-searched product. Non-fatal; pool preview stands on miss.
	const fastPreview = await runFastPreviewSearchStep(input, preliminary, preRunParsedGoal);
	if (fastPreview.length > 0) {
		await emitProgressStep({
			skill: "preliminary_discovery",
			status: "complete",
			index: -1,
			total: 7,
			data: { products: fastPreview },
		});
	}
```

- [ ] **Step 4: Run tsc**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Lint the changed files**

Run: `npm run lint`
Expected: no new errors in `lib/strategy/fast-preview-search.ts` or `lib/workflows/md-strategy.workflow.ts`.

- [ ] **Step 6: Commit**

```bash
git add lib/workflows/md-strategy.workflow.ts
git commit -m "feat(strategy): emit fast-preview search as second preliminary_discovery event"
```

---

### Task 4: Manual verification note (no code)

- [ ] **Step 1:** Confirm the client requires no change — `components/analytics/MDStrategyPanel.tsx:546-553` already replaces `preliminaryProducts` on every `preliminary_discovery` complete event. The second emit (fast preview) therefore replaces the pool cards with no client edit. Record this in the PR description; no code change in this task.

- [ ] **Step 2 (optional, deferred):** Relabel the hero pill to "検索結果（暫定）" when items carry `pool_source === "fresh_search"`. Not required for v1 — the per-item `reason`/`signal_basis` already say 暫定. Leave out unless requested.

---

## Self-Review

**Spec coverage:**
- Option A new workflow step → Task 3 ✓
- Flag-independent keyword (`specific_keyword.normalized ?? category_hints[0]`) → Task 1 `derivePreviewKeyword` ✓
- New `lib/strategy/fast-preview-search.ts` (`runFastPreviewSearch` + `mergePreviewByKeyword`) → Task 1 ✓
- Single Rakuten call, ranking fallback, price filter, dedupe, display-only → Task 1 `runFastPreviewSearch` ✓
- Pool-knife merge first → Task 1 `mergePreviewByKeyword` + Task 3 wiring ✓
- Second `preliminary_discovery` emit, no client change → Task 3 + Task 4 ✓
- Non-fatal / pool preview stands on failure → Task 3 try/catch + `maxRetries = 0` ✓
- Test (flag on/off keyword + live) → Task 1 Step 1 + Task 2 ✓
- No `server-only` (tsx-importable) → Task 1 module header ✓
- Out-of-scope items (flag flip, final pool-forward bug) → intentionally NOT in plan ✓

**Placeholder scan:** none — every code step contains full code; commands have expected output.

**Type consistency:** `derivePreviewKeyword`, `runFastPreviewSearch`, `mergePreviewByKeyword`, `FastPreviewSearchInput` names identical across Task 1 (def) and Tasks 2-3 (use). `DiscoveredProduct` fields match `lib/md-strategy.ts:420-477` (name, reason, japan_fit_score, estimated_demand, supply_source, estimated_price_jpy, source, source_url, signal_basis, japan_market_fit{popularity_evidence,trend_context,why_japan_now}, pool_source). `RakutenItem` fields match `lib/rakuten.ts:13-25`. `ProgressEvent` shape matches `lib/md-strategy.ts:1902-1909` (skill/status/index/total/data).
