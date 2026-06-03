# テレ東マート (txd) Discovery Exclusion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop テレ東マート (`txd`) products from appearing in product search — block new intake (Brave site: fan-out) and hide already-saved rows in both the discovery board and the strategy expansion pool.

**Architecture:** One reusable slug-exclusion set + two pure helpers in `lib/discovery/tv-channels.ts`. Intake blocked in `pool.ts`; defense-in-depth at persist in `save.ts`; retroactive read-time filters in `pool-query.ts` (strategy) and `cached.ts` (discovery board). Token matching reuses the existing `parseChannelSlugs` (comma-joined slugs), so no regex false positives.

**Tech Stack:** TypeScript, Next.js, Supabase (supabase-js), `tsx` smoke-test scripts (no unit framework — assertions via `node:assert`).

**Spec:** `docs/superpowers/specs/2026-06-02-txd-discovery-exclusion-design.md`

---

## File Structure

- `lib/discovery/tv-channels.ts` — **modify**: add `EXCLUDED_DISCOVERY_SLUGS`, `hasExcludedChannel()`, `isDiscoverySearchable()`. Single source of truth for the exclusion list + matching logic.
- `lib/discovery/pool.ts` — **modify** (line 214): use `isDiscoverySearchable` in the Brave fan-out target filter.
- `lib/discovery/save.ts` — **modify** (`buildDiscoveredProductRows`, ~line 164): drop candidates whose `tvChannelSource` is excluded (defense-in-depth).
- `lib/strategy/pool-query.ts` — **modify** (`applyFilters` base filter, ~line 87): exclude rows with an excluded channel before fail-open logic runs.
- `lib/discovery/cached.ts` — **modify** (`getCachedDiscoveryToday`, ~line 51): filter excluded rows from the returned products.
- `scripts/test-txd-exclusion.ts` — **create**: assertions for the matcher, the searchable predicate, and the strategy-pool filter.
- `package.json` — **modify**: add `test:txd-exclusion` script.

---

## Task 1: Exclusion registry + helpers (test-first)

**Files:**
- Create: `scripts/test-txd-exclusion.ts`
- Modify: `lib/discovery/tv-channels.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-txd-exclusion.ts`:

```ts
/**
 * Unit assertions for txd discovery exclusion.
 * Run: npm run test:txd-exclusion
 */
import assert from "node:assert";
import {
	hasExcludedChannel,
	isDiscoverySearchable,
	TV_CHANNELS,
	EXCLUDED_DISCOVERY_SLUGS,
} from "../lib/discovery/tv-channels";

let passed = 0;
function check(label: string, cond: boolean) {
	assert.ok(cond, `FAILED: ${label}`);
	passed++;
}

// --- hasExcludedChannel: token match, no substring false positives ---
check("'txd' excluded", hasExcludedChannel("txd") === true);
check("'japanet,txd' excluded", hasExcludedChannel("japanet,txd") === true);
check("'txd,japanet' excluded", hasExcludedChannel("txd,japanet") === true);
check("'japanet' not excluded", hasExcludedChannel("japanet") === false);
check("'txdx' not excluded (no substring fp)", hasExcludedChannel("txdx") === false);
check("null not excluded", hasExcludedChannel(null) === false);
check("empty not excluded", hasExcludedChannel("") === false);

// --- registry sanity ---
check("txd is in EXCLUDED set", EXCLUDED_DISCOVERY_SLUGS.has("txd"));

// --- isDiscoverySearchable: txd blocked, others allowed ---
const txd = TV_CHANNELS.find((c) => c.slug === "txd")!;
const japanet = TV_CHANNELS.find((c) => c.slug === "japanet")!;
const qvc = TV_CHANNELS.find((c) => c.slug === "qvc")!;
check("txd NOT searchable", isDiscoverySearchable(txd) === false);
check("japanet searchable", isDiscoverySearchable(japanet) === true);
check("qvc NOT searchable (scraped)", isDiscoverySearchable(qvc) === false);

console.log(`[test:txd-exclusion] ${passed} assertions passed`);
```

- [ ] **Step 2: Add the npm script**

In `package.json`, after the `"test:tv-channel-mapping"` line, add:

```json
    "test:txd-exclusion": "tsx scripts/test-txd-exclusion.ts",
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:txd-exclusion`
Expected: FAIL — `hasExcludedChannel`/`isDiscoverySearchable`/`EXCLUDED_DISCOVERY_SLUGS` are not exported (module/import error).

- [ ] **Step 4: Implement the registry + helpers**

In `lib/discovery/tv-channels.ts`, after the `TV_CHANNELS` array (after line 56) and before `getChannelBySlug`, add:

```ts
/**
 * Channels whose products must NOT surface in discovery / strategy search.
 * Operator policy (2026-06-02): テレ東マート (txd) is excluded by default.
 * Calendar visibility (lib/broadcasts/channel-style.ts) is a SEPARATE registry
 * and is unaffected by this set.
 */
export const EXCLUDED_DISCOVERY_SLUGS: ReadonlySet<string> = new Set(["txd"]);

/**
 * True when a persisted `tv_channel_source` (comma-joined slugs) contains any
 * excluded slug as a whole token. Uses parseChannelSlugs so "txdx" never
 * matches "txd". Null/empty => false.
 */
export function hasExcludedChannel(tvChannelSource: string | null | undefined): boolean {
	return parseChannelSlugs(tvChannelSource).some((slug) =>
		EXCLUDED_DISCOVERY_SLUGS.has(slug),
	);
}

/**
 * True when a channel should be queried in the discovery Brave site: fan-out:
 * not broadcast-scraped AND not on the exclusion list.
 */
export function isDiscoverySearchable(channel: {
	slug: string;
	scraped: boolean;
}): boolean {
	return !channel.scraped && !EXCLUDED_DISCOVERY_SLUGS.has(channel.slug);
}
```

(`parseChannelSlugs` is already defined later in the same file at line 82; function hoisting makes the reference valid. If the linter objects to use-before-define, move `EXCLUDED_DISCOVERY_SLUGS` + helpers to the end of the file after `parseChannelSlugs`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:txd-exclusion`
Expected: PASS — `[test:txd-exclusion] 11 assertions passed`

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add lib/discovery/tv-channels.ts scripts/test-txd-exclusion.ts package.json
git commit -m "feat(discovery): add txd exclusion registry + matchers"
```

---

## Task 2: Block new intake in the Brave fan-out

**Files:**
- Modify: `lib/discovery/pool.ts:214`

- [ ] **Step 1: Update the import**

At the top of `lib/discovery/pool.ts`, ensure `isDiscoverySearchable` is imported from `./tv-channels`. Find the existing import from `"./tv-channels"` and add `isDiscoverySearchable` to it. If no such import exists, add:

```ts
import { isDiscoverySearchable } from "./tv-channels";
```

- [ ] **Step 2: Replace the target filter**

In `fetchTvChannelFromBraveSite` (line 214), replace:

```ts
	const targets = channels.filter((c) => !c.scraped);
```

with:

```ts
	// Excludes broadcast-scraped channels AND policy-excluded channels (txd).
	const targets = channels.filter((c) => isDiscoverySearchable(c));
```

- [ ] **Step 3: Verify the searchable assertion still passes**

Run: `npm run test:txd-exclusion`
Expected: PASS (the `isDiscoverySearchable(txd) === false` assertion already covers the predicate used here).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add lib/discovery/pool.ts
git commit -m "feat(discovery): skip txd in Brave site: fan-out"
```

---

## Task 3: Defense-in-depth at persist

**Files:**
- Modify: `lib/discovery/save.ts` (`buildDiscoveredProductRows`, ~line 164)

- [ ] **Step 1: Update the import**

In `lib/discovery/save.ts`, find the existing import from `"./tv-channels"` (it imports `deriveTvChannelSource`/`serializeChannelSlugs` etc.) and add `hasExcludedChannel`. If there is no import from `./tv-channels`, add:

```ts
import { hasExcludedChannel } from "./tv-channels";
```

- [ ] **Step 2: Filter excluded candidates before mapping**

In `buildDiscoveredProductRows` (line 164), change the body so excluded candidates never become rows. Replace:

```ts
export function buildDiscoveredProductRows(
	sessionId: string,
	batch: SaveBatch[],
): DiscoveredProductRow[] {
	return batch.map(({ candidate, broadcastTag, broadcastSources, tvEvidence }) => ({
```

with:

```ts
export function buildDiscoveredProductRows(
	sessionId: string,
	batch: SaveBatch[],
): DiscoveredProductRow[] {
	const kept = batch.filter(
		({ candidate }) => !hasExcludedChannel(candidate.tvChannelSource ?? null),
	);
	const dropped = batch.length - kept.length;
	if (dropped > 0) {
		console.log(`[save] dropped ${dropped} excluded-channel candidate(s) (e.g. txd)`);
	}
	return kept.map(({ candidate, broadcastTag, broadcastSources, tvEvidence }) => ({
```

(The closing `}));` of the `.map` and the function stay unchanged.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add lib/discovery/save.ts
git commit -m "feat(discovery): drop excluded-channel candidates at persist (defense-in-depth)"
```

---

## Task 4: Exclude txd from the strategy pool (test-first)

**Files:**
- Modify: `scripts/test-txd-exclusion.ts`
- Modify: `lib/strategy/pool-query.ts` (`applyFilters` base filter, ~line 87)

- [ ] **Step 1: Add a failing test for applyFilters**

Append to `scripts/test-txd-exclusion.ts` (before the final `console.log`):

```ts
// --- strategy pool: applyFilters excludes excluded-channel rows ---
import { __test as poolTest, type PoolRow } from "../lib/strategy/pool-query";

function row(over: Partial<PoolRow>): PoolRow {
	return {
		id: "00000000-0000-0000-0000-000000000000",
		name: "x",
		product_url: "https://example.com",
		price_jpy: null,
		category: null,
		seed_keyword: "kw",
		source: "tv_channel",
		tv_fit_score: 50,
		tv_fit_reason: null,
		tv_channel_source: null,
		tv_tier: 0,
		context: "home_shopping",
		user_action: null,
		c_package: null,
		enrichment_status: "completed",
		review_count: null,
		review_avg: null,
		seller_name: null,
		broadcast_tag: null,
		thumbnail_url: null,
		created_at: new Date().toISOString(),
		tv_evidence: null,
		...over,
	};
}

const filtered = poolTest.applyFilters(
	[
		row({ id: "11111111-1111-1111-1111-111111111111", tv_channel_source: "txd" }),
		row({ id: "22222222-2222-2222-2222-222222222222", tv_channel_source: "japanet" }),
	],
	{ context: "home_shopping" },
);
check("applyFilters drops txd row", filtered.length === 1);
check(
	"applyFilters keeps japanet row",
	filtered[0]?.tv_channel_source === "japanet",
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:txd-exclusion`
Expected: FAIL — `applyFilters drops txd row` (currently both rows survive the base filter, so `filtered.length === 2`).

- [ ] **Step 3: Add the exclusion to the base filter**

In `lib/strategy/pool-query.ts`, add the import near the top (after the existing imports, ~line 17):

```ts
import { hasExcludedChannel } from "@/lib/discovery/tv-channels";
```

In `applyFilters` (line 87), extend the strict base filter. Replace:

```ts
	// R3 + R2 — always strict
	const baseFiltered = rows.filter(
		(r) =>
			r.context === opts.context &&
			r.user_action !== "rejected" &&
			r.user_action !== "duplicate",
	);
```

with:

```ts
	// R3 + R2 — always strict. Excluded channels (txd) are a hard drop here so
	// the fail-open thresholds below operate on the already-cleaned set (an
	// all-txd pool collapses → caller's fresh-search fallback engages).
	const baseFiltered = rows.filter(
		(r) =>
			r.context === opts.context &&
			r.user_action !== "rejected" &&
			r.user_action !== "duplicate" &&
			!hasExcludedChannel(r.tv_channel_source),
	);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:txd-exclusion`
Expected: PASS — `[test:txd-exclusion] 13 assertions passed`

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/test-txd-exclusion.ts lib/strategy/pool-query.ts
git commit -m "feat(strategy): exclude txd rows from pool query"
```

---

## Task 5: Hide txd from the discovery board

**Files:**
- Modify: `lib/discovery/cached.ts` (`getCachedDiscoveryToday`, ~line 51-65)

- [ ] **Step 1: Update the import**

At the top of `lib/discovery/cached.ts`, add:

```ts
import { hasExcludedChannel } from "@/lib/discovery/tv-channels";
```

- [ ] **Step 2: Filter excluded rows from the returned products**

In `getCachedDiscoveryToday`, the products come from `productsResult.data`. Replace the return block (lines 61-65):

```ts
	return {
		session,
		products: productsResult.data ?? [],
		categoryStats,
	};
```

with:

```ts
	const products = (productsResult.data ?? []).filter(
		(p) => !hasExcludedChannel((p as { tv_channel_source: string | null }).tv_channel_source),
	);

	return {
		session,
		products,
		categoryStats,
	};
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Manual verification note**

The filter is deterministic and runs inside the `"use cache"` function, so cached payloads are already-filtered. No cache-key change is needed. (The 6h `cacheLife` means already-cached pre-change payloads refresh within 6h; force-refresh by triggering any discovery mutation which calls `invalidateDiscoveryAfterMutation`, or wait out the TTL.)

- [ ] **Step 5: Commit**

```bash
git add lib/discovery/cached.ts
git commit -m "feat(discovery): hide txd rows from discovery board"
```

---

## Task 6: Full verification

- [ ] **Step 1: Run the test suite**

Run: `npm run test:txd-exclusion`
Expected: PASS — 13 assertions passed.

- [ ] **Step 2: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new errors in the touched files.

- [ ] **Step 4: Confirm no txd leaks (optional, live DB)**

If `.env.local` is present, spot-check that the strategy pool and discovery board no longer surface txd. There is no automated live assertion in scope; the deterministic tests above cover the logic. Record the manual check result in the PR description.

---

## Self-Review

**Spec coverage:**
- §4.1 registry + helper → Task 1. ✅
- §4.2 block intake (pool.ts) → Task 2. ✅
- §4.3 defense at persist (save.ts) → Task 3. ✅
- §4.4 retroactive read filter — strategy `pool-query.ts` → Task 4; discovery `cached.ts` → Task 5. ✅ (The spec's `/api/discovery/today` path reads through `getCachedDiscoveryToday`, so filtering there covers the route.)
- §5 tests (matcher cases incl. `txdx` false-positive guard) → Task 1 + Task 4. ✅
- §6 edge case "all-txd pool collapses → fresh-search fallback" → handled by placing the exclusion in the strict base filter (Task 4 Step 3 comment). ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✅

**Type consistency:** `hasExcludedChannel(string|null|undefined)`, `isDiscoverySearchable({slug,scraped})`, `EXCLUDED_DISCOVERY_SLUGS: ReadonlySet<string>` used consistently across Tasks 1-5. `PoolRow` / `__test.applyFilters` match the exports in `pool-query.ts` (verified: `__test = { applyFilters }`, `PoolRow` exported). ✅

**Note:** Task 4's test imports `__test` and `PoolRow` from `pool-query.ts` — `pool-query.ts` imports `getServiceClient` at module load but does not call it at import time, and has no `import "server-only"`, so `tsx` can import it without a Next.js bundler. If a `server-only` import is added there later, move the `applyFilters` assertions into a route-only test.
