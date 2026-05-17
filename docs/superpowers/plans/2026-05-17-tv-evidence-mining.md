# TV Evidence Mining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach a deterministic JSON record (`tv_evidence`) to every new `discovered_products` row describing how similar products have actually been televised in Japan, and use it as (1) a capped score bonus, (2) report grounding context, (3) a UI badge.

**Architecture:** A new pure module `lib/discovery/tv-evidence.ts` runs three SQL aggregates against `broadcasts` / `historical_broadcasts` / `qvc_products`, emits a TvEvidence JSON, and exposes an `applyEvidenceBonus(candidates, evidenceMap)` mutator that fits between the existing `applyRecentBroadcastPenalty` and `saveDiscoveredProducts` steps in the daily-discovery cron. A weekly refresh cron re-runs evidence for stale rows. A small badge in the discovery UI shows the raw numbers.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres (jsonb + GIN), tsx test scripts (project convention — no vitest/jest), shadcn/ui, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-05-17-tv-evidence-mining-design.md`

**Spec deviations confirmed during plan write-up:**
- Spec §4 said category matching uses `CATEGORY_MAPPING` from `lib/strategy/pool-query.ts`. That mapping is UI-label → DB-category; both `discovered_products.category` and `broadcasts.category` are DB-side but use different vocabularies (Rakuten genre strings vs. whitelist labels). The implementation uses the `splitCategoryToKeywords` pattern proven in `lib/discovery/competitor-trend-boost.ts` — split both sides into keywords, match on any shared keyword ≥2 chars.
- Cron schedule moved from "Sunday 17:00 UTC" to "Sunday 17:30 UTC" to avoid colliding with the existing `qvc-monthly-refresh` cron (`0 17 * * *`).

---

## File Structure

| File | Type | Responsibility |
|---|---|---|
| `supabase/migrations/2026-05-17_tv_evidence.sql` | new | Adds `tv_evidence jsonb`, `tv_evidence_at timestamptz`, GIN index |
| `lib/discovery/types.ts` | modify | Adds `TvEvidence` interface |
| `lib/discovery/tv-evidence.ts` | new | Pure compute + score-bonus mutator |
| `lib/discovery/save.ts` | modify | Includes `tv_evidence` in insert payload |
| `app/api/cron/daily-discovery-home/route.ts` | modify | Hook evidence compute + bonus into pipeline |
| `app/api/cron/daily-discovery-live/route.ts` | modify | Same hook as home cron |
| `app/api/cron/refresh-tv-evidence/route.ts` | new | Weekly batch refresh of stale rows |
| `app/api/discovery/[productId]/tv-evidence/route.ts` | new | Member/admin read API |
| `components/discovery/TvEvidenceBadge.tsx` | new | Compact badge for discovery UI |
| `lib/strategy/pool-query.ts` | modify | Add `tv_evidence` to select + PoolRow type |
| `lib/md-strategy.ts` | modify | Surface evidence into Gemini prompt + recommendation |
| `vercel.json` | modify | Function timeout + cron schedule for refresh job |
| `scripts/fixtures/tv-evidence/*` | new | Fixture broadcast rows + expected JSON |
| `scripts/test-tv-evidence-unit.ts` | new | Pure-function tests (no DB) |
| `scripts/test-tv-evidence-integration.ts` | new | Live Supabase integration test |
| `scripts/check-tv-evidence.ts` | new | Diagnostic — print evidence for one product id |
| `package.json` | modify | npm scripts: `test:tv-evidence-unit`, `test:tv-evidence-integration`, `test:tv-evidence` |

---

## Task 1: Migration — add tv_evidence columns

**Files:**
- Create: `supabase/migrations/2026-05-17_tv_evidence.sql`

- [ ] **Step 1: Write the migration**

```sql
-- TV Evidence Mining: per-candidate broadcast history aggregate.
-- Spec: docs/superpowers/specs/2026-05-17-tv-evidence-mining-design.md

ALTER TABLE discovered_products
  ADD COLUMN IF NOT EXISTS tv_evidence jsonb;

ALTER TABLE discovered_products
  ADD COLUMN IF NOT EXISTS tv_evidence_at timestamptz;

-- GIN index for keyset queries (e.g. find products with channel breakdown
-- containing 'qvc'). Partial — most rows will be null until the first
-- refresh cron run completes.
CREATE INDEX IF NOT EXISTS idx_discovered_products_tv_evidence_gin
  ON discovered_products USING gin (tv_evidence)
  WHERE tv_evidence IS NOT NULL;

-- Index to find stale rows quickly in the weekly refresh cron.
CREATE INDEX IF NOT EXISTS idx_discovered_products_tv_evidence_at
  ON discovered_products (tv_evidence_at NULLS FIRST);

-- No new RLS policy needed: columns inherit table-level RLS on
-- discovered_products. Verify in the migration runner output that existing
-- policies cover member/admin reads + viewer denial. If they don't,
-- that is a pre-existing bug — fix it before merging this migration.
```

- [ ] **Step 2: Verify migration syntax**

Run: `npm run test:migrations`
Expected: PASS — script reads each migration and confirms valid SQL.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-05-17_tv_evidence.sql
git commit -m "feat(discovery): tv_evidence column + indexes"
```

---

## Task 2: Add TvEvidence type

**Files:**
- Modify: `lib/discovery/types.ts`

- [ ] **Step 1: Add the interface**

Append to `lib/discovery/types.ts` after the `CPackage` interface:

```ts
export interface TvEvidenceSample {
	channel: string;
	air_date: string; // YYYY-MM-DD
	title: string;
	price_jpy: number | null;
}

export interface TvEvidenceTimeslot {
	channel: "qvc" | "shopch";
	dow: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
	hour_bucket: number; // 0..23
	count: number;
}

export interface TvEvidencePriceStats {
	median: number;
	p25: number;
	p75: number;
	count: number;
}

export interface TvEvidenceMatchBasis {
	category_keywords: string[]; // empty if no category
	price_band: [number, number] | null;
	name_tokens: string[];
}

export interface TvEvidence {
	matched_at: string; // ISO timestamp
	match_basis: TvEvidenceMatchBasis;
	airing_count: number;
	recent_30d_count: number;
	recent_90d_count: number;
	channel_breakdown: Record<string, number>;
	price_jpy: TvEvidencePriceStats | null;
	top_timeslots: TvEvidenceTimeslot[];
	samples: TvEvidenceSample[];
	evidence_strength: number; // 0..1
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS — no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/discovery/types.ts
git commit -m "feat(discovery): TvEvidence types"
```

---

## Task 3: Pure helpers — keyword splitting, percentile, name tokenizer

**Files:**
- Create: `lib/discovery/tv-evidence.ts`
- Create: `scripts/test-tv-evidence-unit.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing tests**

Create `scripts/test-tv-evidence-unit.ts`:

```ts
import { __test } from "../lib/discovery/tv-evidence";

const { splitCategoryToKeywords, tokenizeName, percentile } = __test;

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${msg}`);
	}
}

// splitCategoryToKeywords
assert(
	JSON.stringify(splitCategoryToKeywords("美容・運動")) === JSON.stringify(["美容", "運動"]),
	'splitCategoryToKeywords("美容・運動") → ["美容","運動"]',
);
assert(
	JSON.stringify(splitCategoryToKeywords("化粧品")) === JSON.stringify(["化粧品"]),
	"single-token category passes through",
);
assert(
	JSON.stringify(splitCategoryToKeywords("a/b・c")) === JSON.stringify(["a", "b", "c"]),
	"slash + middle-dot both split",
);
assert(
	splitCategoryToKeywords("").length === 0,
	"empty input → empty array",
);
assert(
	JSON.stringify(splitCategoryToKeywords("お・x")) === JSON.stringify(["お"]),
	"tokens <2 chars filtered (Japanese counted by chars, ASCII single char dropped)",
);

// tokenizeName
assert(
	JSON.stringify(tokenizeName("無印良品 美容液 30ml")) === JSON.stringify(["無印良品", "美容液", "30ml"]),
	"tokenizeName splits on whitespace and drops short tokens",
);
assert(
	tokenizeName("a b c").length === 0,
	"all-short tokens → empty",
);
assert(
	tokenizeName("セラム").length === 1 && tokenizeName("セラム")[0] === "セラム",
	"single Japanese token kept",
);

// percentile
assert(percentile([1, 2, 3, 4, 5], 0.5) === 3, "median of [1..5] = 3");
assert(percentile([1, 2, 3, 4], 0.5) === 2.5, "median of [1..4] = 2.5");
assert(percentile([10], 0.5) === 10, "single-element percentile = element");
assert(percentile([], 0.5) === 0, "empty array percentile = 0");

if (process.exitCode === 1) process.exit(1);
console.log("\nAll unit tests passed.");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx scripts/test-tv-evidence-unit.ts`
Expected: FAIL — `Cannot find module '../lib/discovery/tv-evidence'`.

- [ ] **Step 3: Write the implementation**

Create `lib/discovery/tv-evidence.ts`:

```ts
/**
 * TV Evidence Mining — deterministic per-candidate broadcast history.
 * Spec: docs/superpowers/specs/2026-05-17-tv-evidence-mining-design.md
 */

/**
 * Split a Japanese composite category into atomic keywords (≥2 chars).
 * Mirrors the pattern in lib/discovery/competitor-trend-boost.ts so the
 * two modules behave identically on shared inputs.
 */
export function splitCategoryToKeywords(category: string): string[] {
	if (!category) return [];
	return category
		.split(/[・\/／,、]/)
		.map((s) => s.trim().normalize("NFKC"))
		.filter((s) => s.length >= 2);
}

/**
 * Tokenize a product name into substrings suitable for ILIKE matching:
 * - Split on whitespace and a small set of punctuation
 * - Drop tokens shorter than 3 characters (catches noise like "x", "ml")
 *   — Japanese tokens of length 2 are kept as a special case via the
 *   length-3 filter only when string is ASCII; full-width chars count
 *   as 1 codepoint each, so 3-char Japanese tokens still survive.
 *   For simplicity, all tokens use the same ≥3 codepoint rule. Short
 *   Japanese names like "セラム" (3 chars) qualify; "30ml" (4) qualifies;
 *   "a" or "b" (1 char) does not.
 * - Keep at most 3 tokens to bound query cost.
 */
export function tokenizeName(name: string): string[] {
	if (!name) return [];
	return name
		.normalize("NFKC")
		.split(/[\s・\/／,、|\-]+/)
		.map((s) => s.trim())
		.filter((s) => s.length >= 3)
		.slice(0, 3);
}

/**
 * Compute the q-th percentile of a numeric array using linear interpolation
 * between closest ranks. Returns 0 for empty input.
 *
 * Note: This is a simple definition; we don't need exact statistical
 * accuracy — the values feed a Gemini prompt where one yen of precision
 * is irrelevant.
 */
export function percentile(values: number[], q: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = (sorted.length - 1) * q;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export const __test = {
	splitCategoryToKeywords,
	tokenizeName,
	percentile,
};
```

- [ ] **Step 4: Add npm script and re-run tests**

Modify `package.json` (insert near the other `test:` scripts):

```json
"test:tv-evidence-unit": "tsx scripts/test-tv-evidence-unit.ts",
```

Run: `npm run test:tv-evidence-unit`
Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**

```bash
git add lib/discovery/tv-evidence.ts scripts/test-tv-evidence-unit.ts package.json
git commit -m "feat(discovery): tv-evidence pure helpers"
```

---

## Task 4: Aggregate function — broadcast rows → TvEvidence shape

**Files:**
- Modify: `lib/discovery/tv-evidence.ts`
- Modify: `scripts/test-tv-evidence-unit.ts`

- [ ] **Step 1: Extend tests to cover aggregation**

Append to `scripts/test-tv-evidence-unit.ts` (before the `if (process.exitCode...)` line):

```ts
import { aggregateBroadcastRows, type BroadcastRow } from "../lib/discovery/tv-evidence";

// aggregateBroadcastRows
const todayIso = new Date().toISOString().slice(0, 10);
const daysAgoIso = (n: number) =>
	new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const rows: BroadcastRow[] = [
	{ source: "broadcasts", channel: "qvc", air_date: daysAgoIso(5), start_time: "14:00:00", title: "セラムA", price_jpy: 5000 },
	{ source: "broadcasts", channel: "qvc", air_date: daysAgoIso(10), start_time: "14:00:00", title: "セラムB", price_jpy: 6000 },
	{ source: "broadcasts", channel: "shopch", air_date: daysAgoIso(40), start_time: "20:00:00", title: "セラムC", price_jpy: 8000 },
	{ source: "historical", channel: "japanet", air_date: daysAgoIso(100), start_time: null, title: "セラムD", price_jpy: 7000 },
	{ source: "historical", channel: "japanet", air_date: daysAgoIso(200), start_time: null, title: "セラムE", price_jpy: 7500 },
];

const ev = aggregateBroadcastRows(rows, {
	category_keywords: ["美容"],
	price_band: [3000, 9000],
	name_tokens: ["セラム"],
});

assert(ev.airing_count === 5, "airing_count = 5");
assert(ev.recent_30d_count === 2, "recent_30d_count = 2 (5d, 10d)");
assert(ev.recent_90d_count === 3, "recent_90d_count = 3 (5d, 10d, 40d)");
assert(ev.channel_breakdown.qvc === 2, "qvc breakdown = 2");
assert(ev.channel_breakdown.shopch === 1, "shopch breakdown = 1");
assert(ev.channel_breakdown.japanet === 2, "japanet breakdown = 2");
assert(ev.price_jpy !== null && ev.price_jpy.count === 5, "all 5 prices included");
assert(ev.price_jpy?.median === 7000, "median price = 7000");
assert(ev.top_timeslots.length > 0, "at least one timeslot bucket");
assert(
	ev.top_timeslots[0].channel === "qvc" && ev.top_timeslots[0].hour_bucket === 14,
	"top timeslot is qvc 14:00",
);
assert(ev.samples.length <= 5, "samples capped at 5");
assert(ev.samples[0].air_date === daysAgoIso(5), "samples sorted by recency");

// Empty input
const emptyEv = aggregateBroadcastRows([], {
	category_keywords: [],
	price_band: null,
	name_tokens: [],
});
assert(emptyEv.airing_count === 0, "empty input → airing_count 0");
assert(emptyEv.price_jpy === null, "empty input → price_jpy null");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:tv-evidence-unit`
Expected: FAIL — `aggregateBroadcastRows is not exported`.

- [ ] **Step 3: Implement aggregateBroadcastRows**

Append to `lib/discovery/tv-evidence.ts`:

```ts
import type { TvEvidence, TvEvidenceMatchBasis, TvEvidenceTimeslot } from "./types";

const DOW: Array<TvEvidenceTimeslot["dow"]> = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface BroadcastRow {
	source: "broadcasts" | "historical" | "qvc_products";
	channel: string;
	air_date: string; // YYYY-MM-DD
	start_time: string | null; // HH:MM:SS, null for historical
	title: string;
	price_jpy: number | null;
}

function daysBetween(a: string, b: string): number {
	return Math.floor(
		(Date.parse(b) - Date.parse(a)) / 86_400_000,
	);
}

function bucketTimeslot(row: BroadcastRow): TvEvidenceTimeslot | null {
	if (!row.start_time) return null;
	if (row.channel !== "qvc" && row.channel !== "shopch") return null;
	const hour = parseInt(row.start_time.slice(0, 2), 10);
	if (!Number.isFinite(hour)) return null;
	const dow = DOW[new Date(row.air_date + "T00:00:00Z").getUTCDay()];
	return {
		channel: row.channel as "qvc" | "shopch",
		dow,
		hour_bucket: hour,
		count: 1,
	};
}

export function aggregateBroadcastRows(
	rows: BroadcastRow[],
	basis: TvEvidenceMatchBasis,
): TvEvidence {
	const now = new Date().toISOString().slice(0, 10);

	let recent30 = 0;
	let recent90 = 0;
	const channelCounts: Record<string, number> = {};
	const prices: number[] = [];
	const timeslotMap = new Map<string, TvEvidenceTimeslot>();

	for (const r of rows) {
		const age = daysBetween(r.air_date, now);
		if (age <= 30) recent30 += 1;
		if (age <= 90) recent90 += 1;
		channelCounts[r.channel] = (channelCounts[r.channel] ?? 0) + 1;
		if (r.price_jpy !== null && r.price_jpy > 0) prices.push(r.price_jpy);
		const slot = bucketTimeslot(r);
		if (slot) {
			const key = `${slot.channel}-${slot.dow}-${slot.hour_bucket}`;
			const prev = timeslotMap.get(key);
			if (prev) prev.count += 1;
			else timeslotMap.set(key, slot);
		}
	}

	const samples = [...rows]
		.sort((a, b) => (a.air_date < b.air_date ? 1 : -1))
		.slice(0, 5)
		.map((r) => ({
			channel: r.channel,
			air_date: r.air_date,
			title: r.title.slice(0, 200),
			price_jpy: r.price_jpy,
		}));

	const top_timeslots = [...timeslotMap.values()]
		.sort((a, b) => b.count - a.count)
		.slice(0, 5);

	const price_jpy = prices.length > 0
		? {
				median: Math.round(percentile(prices, 0.5)),
				p25: Math.round(percentile(prices, 0.25)),
				p75: Math.round(percentile(prices, 0.75)),
				count: prices.length,
			}
		: null;

	const distinct_channels = Object.keys(channelCounts).length;
	const price_completeness = basis.price_band === null ? 0.5 : 1.0;

	const base = Math.min(1, Math.log10(1 + rows.length) / 2.5);
	const recency = Math.min(1, recent30 / 10);
	const diversity = Math.min(1, distinct_channels / 4);
	const evidence_strength = Math.round(
		(0.5 * base + 0.3 * recency + 0.2 * diversity) * price_completeness * 100,
	) / 100;

	return {
		matched_at: new Date().toISOString(),
		match_basis: basis,
		airing_count: rows.length,
		recent_30d_count: recent30,
		recent_90d_count: recent90,
		channel_breakdown: channelCounts,
		price_jpy,
		top_timeslots,
		samples,
		evidence_strength,
	};
}
```

Extend the `__test` export at bottom:

```ts
export const __test = {
	splitCategoryToKeywords,
	tokenizeName,
	percentile,
	aggregateBroadcastRows,
};
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test:tv-evidence-unit`
Expected: PASS — all assertions including aggregation green.

- [ ] **Step 5: Commit**

```bash
git add lib/discovery/tv-evidence.ts scripts/test-tv-evidence-unit.ts
git commit -m "feat(discovery): tv-evidence aggregator"
```

---

## Task 5: DB query function — fetch matching broadcast rows for a candidate

**Files:**
- Modify: `lib/discovery/tv-evidence.ts`
- Create: `scripts/test-tv-evidence-integration.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the integration test**

Create `scripts/test-tv-evidence-integration.ts`:

```ts
import { fetchMatchingBroadcastRows, computeTvEvidence } from "../lib/discovery/tv-evidence";
import { getServiceClient } from "../lib/supabase";

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
	console.error("SUPABASE_SERVICE_ROLE_KEY not set; skipping live integration test.");
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

	// Pick a real candidate with a category and price to exercise all 3 axes.
	const { data: candidates, error } = await sb
		.from("discovered_products")
		.select("id, name, category, price_jpy")
		.not("category", "is", null)
		.not("price_jpy", "is", null)
		.limit(5);

	if (error) {
		console.error("Failed to load test candidates:", error.message);
		process.exit(1);
	}
	if (!candidates || candidates.length === 0) {
		console.error("No suitable candidates in DB — populate discovered_products first.");
		process.exit(0); // soft-skip, not fail
	}

	for (const c of candidates) {
		console.log(`\n=== Candidate: ${c.name.slice(0, 40)} (${c.category}, ¥${c.price_jpy}) ===`);
		const rows = await fetchMatchingBroadcastRows(sb, {
			name: c.name,
			category: c.category,
			price_jpy: c.price_jpy,
		});
		console.log(`  matched broadcast rows: ${rows.length}`);

		const ev = await computeTvEvidence(sb, {
			name: c.name,
			category: c.category,
			price_jpy: c.price_jpy,
		});
		if (ev === null) {
			console.log(`  evidence: null (no category match)`);
			continue;
		}
		console.log(`  airing_count=${ev.airing_count}, strength=${ev.evidence_strength}`);
		assert(ev.airing_count === rows.length, "evidence airing_count matches row count");
		assert(
			ev.evidence_strength >= 0 && ev.evidence_strength <= 1,
			"evidence_strength in [0,1]",
		);
		if (ev.price_jpy) {
			assert(ev.price_jpy.median > 0, "price median positive when present");
		}
	}

	if (process.exitCode === 1) process.exit(1);
	console.log("\nIntegration test passed.");
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
```

- [ ] **Step 2: Add npm scripts**

Modify `package.json` to add:

```json
"test:tv-evidence-integration": "tsx --env-file=.env.local scripts/test-tv-evidence-integration.ts",
"test:tv-evidence": "npm run test:tv-evidence-unit && npm run test:tv-evidence-integration",
```

- [ ] **Step 3: Run to verify failure**

Run: `npm run test:tv-evidence-integration`
Expected: FAIL — `fetchMatchingBroadcastRows is not exported`.

- [ ] **Step 4: Implement fetchMatchingBroadcastRows and computeTvEvidence**

Append to `lib/discovery/tv-evidence.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export interface CandidateInput {
	name: string;
	category: string | null;
	price_jpy: number | null;
}

const PRICE_BAND_RATIO = 0.25;
const HISTORICAL_LOOKBACK_DAYS = 365 * 2; // 2 years; older rows rarely useful

function priceBandFor(price: number | null): [number, number] | null {
	if (price === null || price <= 0) return null;
	return [
		Math.round(price * (1 - PRICE_BAND_RATIO)),
		Math.round(price * (1 + PRICE_BAND_RATIO)),
	];
}

function cutoffIso(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export async function fetchMatchingBroadcastRows(
	sb: SupabaseClient,
	candidate: CandidateInput,
): Promise<BroadcastRow[]> {
	const categoryKeywords = splitCategoryToKeywords(candidate.category ?? "");
	if (categoryKeywords.length === 0) return [];

	const priceBand = priceBandFor(candidate.price_jpy);
	const nameTokens = tokenizeName(candidate.name);
	const cutoff = cutoffIso(HISTORICAL_LOOKBACK_DAYS);

	// 1. broadcasts (shopch + qvc). Category match required; we filter further
	//    in-process because broadcasts.category is a single string, not array.
	const bRes = await sb
		.from("broadcasts")
		.select("channel, air_date, start_time, program_title, category, product_ids")
		.gte("air_date", cutoff)
		.not("category", "is", null);

	if (bRes.error) {
		console.warn(`[tv-evidence] broadcasts query failed: ${bRes.error.message}`);
		return [];
	}

	// 2. historical_broadcasts (8 OA channels, date-only, price).
	const hRes = await sb
		.from("historical_broadcasts")
		.select("channel, air_date, product_name, price_jpy, category")
		.gte("air_date", cutoff)
		.not("category", "is", null);

	if (hRes.error) {
		console.warn(`[tv-evidence] historical query failed: ${hRes.error.message}`);
	}

	// 3. qvc_products price lookup keyed by product id for broadcasts join.
	//    Only fetch if we actually have qvc broadcasts that need price.
	const qvcProductIds = new Set<string>();
	for (const row of (bRes.data ?? []) as Array<{ channel: string; product_ids: string[] | null }>) {
		if (row.channel !== "qvc" || !row.product_ids) continue;
		for (const id of row.product_ids) qvcProductIds.add(id);
	}
	const qPriceMap = new Map<string, number>();
	if (qvcProductIds.size > 0) {
		const qRes = await sb
			.from("qvc_products")
			.select("product_id, price_text")
			.in("product_id", [...qvcProductIds]);
		if (!qRes.error && qRes.data) {
			for (const q of qRes.data as Array<{ product_id: string; price_text: string | null }>) {
				if (!q.price_text) continue;
				const m = q.price_text.match(/([0-9][0-9,]{2,})\s*円/);
				if (!m) continue;
				const n = parseInt(m[1].replace(/,/g, ""), 10);
				if (Number.isFinite(n) && n > 0) qPriceMap.set(q.product_id, n);
			}
		}
	}

	const candidateKwSet = new Set(categoryKeywords);

	function categoryMatches(broadcastCategory: string): boolean {
		const bKws = splitCategoryToKeywords(broadcastCategory);
		return bKws.some((k) => candidateKwSet.has(k));
	}

	function nameMatches(title: string): boolean {
		if (nameTokens.length === 0) return false;
		const hay = title.normalize("NFKC").toLowerCase();
		return nameTokens.some((t) => hay.includes(t.toLowerCase()));
	}

	function priceMatches(p: number | null): boolean {
		if (priceBand === null) return false;
		if (p === null) return false;
		return p >= priceBand[0] && p <= priceBand[1];
	}

	const out: BroadcastRow[] = [];

	for (const row of (bRes.data ?? []) as Array<{
		channel: string;
		air_date: string;
		start_time: string;
		program_title: string;
		category: string | null;
		product_ids: string[] | null;
	}>) {
		if (!row.category || !categoryMatches(row.category)) continue;
		const inferredPrice =
			row.channel === "qvc" && row.product_ids?.[0]
				? qPriceMap.get(row.product_ids[0]) ?? null
				: null;
		// Require price OR name corroboration in addition to category, unless
		// the candidate provided neither (price=null AND no name tokens) — in
		// which case category alone is the floor.
		const noCorroborationAvailable = priceBand === null && nameTokens.length === 0;
		const corroborated =
			noCorroborationAvailable ||
			priceMatches(inferredPrice) ||
			nameMatches(row.program_title);
		if (!corroborated) continue;
		out.push({
			source: "broadcasts",
			channel: row.channel,
			air_date: row.air_date,
			start_time: row.start_time,
			title: row.program_title,
			price_jpy: inferredPrice,
		});
	}

	for (const row of (hRes.data ?? []) as Array<{
		channel: string;
		air_date: string;
		product_name: string;
		price_jpy: number | null;
		category: string | null;
	}>) {
		if (!row.category || !categoryMatches(row.category)) continue;
		const noCorroborationAvailable = priceBand === null && nameTokens.length === 0;
		const corroborated =
			noCorroborationAvailable ||
			priceMatches(row.price_jpy) ||
			nameMatches(row.product_name);
		if (!corroborated) continue;
		out.push({
			source: "historical",
			channel: row.channel,
			air_date: row.air_date,
			start_time: null,
			title: row.product_name,
			price_jpy: row.price_jpy,
		});
	}

	return out;
}

export async function computeTvEvidence(
	sb: SupabaseClient,
	candidate: CandidateInput,
): Promise<TvEvidence | null> {
	const categoryKeywords = splitCategoryToKeywords(candidate.category ?? "");
	if (categoryKeywords.length === 0) return null;

	const rows = await fetchMatchingBroadcastRows(sb, candidate);
	if (rows.length === 0) return null;

	return aggregateBroadcastRows(rows, {
		category_keywords: categoryKeywords,
		price_band: priceBandFor(candidate.price_jpy),
		name_tokens: tokenizeName(candidate.name),
	});
}
```

- [ ] **Step 5: Run integration test**

Run: `npm run test:tv-evidence-integration`
Expected: PASS — at least one candidate produces non-null evidence; assertions all green. (If DB has zero candidates, script exits with `process.exit(0)` and logs "soft-skip".)

- [ ] **Step 6: Commit**

```bash
git add lib/discovery/tv-evidence.ts scripts/test-tv-evidence-integration.ts package.json
git commit -m "feat(discovery): tv-evidence DB query + computeTvEvidence"
```

---

## Task 6: Score bonus mutator

**Files:**
- Modify: `lib/discovery/tv-evidence.ts`
- Modify: `scripts/test-tv-evidence-unit.ts`

- [ ] **Step 1: Write failing tests**

Append to `scripts/test-tv-evidence-unit.ts`:

```ts
import { applyEvidenceBonus } from "../lib/discovery/tv-evidence";

const baseCandidate = (score: number) => ({
	name: "test",
	productUrl: "https://example.com/x",
	source: "rakuten" as const,
	seedKeyword: "kw",
	track: "tv_proven" as const,
	context: "home_shopping" as const,
	tvFitScore: score,
	tvFitReason: "test",
	isTvApplicable: true,
	isLiveApplicable: false,
	scoreBreakdown: { review_signal: 0, tv_category_match: 0, trend_signal: 0, price_fit: 0, purchase_signal: 0, total: 0 },
});

const c1 = baseCandidate(50);
const c2 = baseCandidate(60);

const evMap = new Map([
	[c1.productUrl, { evidence_strength: 0.8 } as any],
	[c2.productUrl, null],
]);

const bonusCount = applyEvidenceBonus([c1, c2], evMap);

assert(bonusCount === 1, "exactly one candidate received a bonus");
assert(c1.tvFitScore === 50 + Math.round(0.8 * 15), "c1 bonus = round(0.8*15) = 12");
assert(c2.tvFitScore === 60, "c2 unchanged (null evidence)");
assert(c1.tvFitReason.includes("実測"), "c1 reason annotated");

// Cap at 100
const c3 = baseCandidate(95);
const evMap2 = new Map([[c3.productUrl, { evidence_strength: 1.0 } as any]]);
applyEvidenceBonus([c3], evMap2);
assert(c3.tvFitScore === 100, "score capped at 100");
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:tv-evidence-unit`
Expected: FAIL — `applyEvidenceBonus is not exported`.

- [ ] **Step 3: Implement applyEvidenceBonus**

Append to `lib/discovery/tv-evidence.ts`:

```ts
import type { Candidate } from "./types";

const EVIDENCE_BONUS_MAX = 15;

export function applyEvidenceBonus(
	candidates: Candidate[],
	evidenceByUrl: Map<string, TvEvidence | null>,
): number {
	let count = 0;
	for (const c of candidates) {
		const ev = evidenceByUrl.get(c.productUrl);
		if (!ev) continue;
		const bonus = Math.round(ev.evidence_strength * EVIDENCE_BONUS_MAX);
		if (bonus === 0) continue;
		const next = Math.min(100, c.tvFitScore + bonus);
		if (next === c.tvFitScore) continue;
		c.tvFitScore = next;
		c.tvFitReason = `${c.tvFitReason} [実測放送${ev.airing_count}回]`.slice(0, 200);
		count += 1;
	}
	candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);
	return count;
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:tv-evidence-unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/discovery/tv-evidence.ts scripts/test-tv-evidence-unit.ts
git commit -m "feat(discovery): applyEvidenceBonus"
```

---

## Task 7: Save integration — persist tv_evidence to DB row

**Files:**
- Modify: `lib/discovery/save.ts`

- [ ] **Step 1: Read save.ts to locate the insert payload**

Run: `grep -n "saveDiscoveredProducts\|insert\|tv_fit_score" lib/discovery/save.ts`
Identify the function that builds the row payload (look for an object containing `tv_fit_score:` near an `.insert(` call).

- [ ] **Step 2: Extend SaveBatch type and payload**

In `lib/discovery/save.ts`:

1. Add to the `SaveBatch` interface:
```ts
tvEvidence: import("./types").TvEvidence | null;
```

2. In the row-building code (search for `tv_fit_score:` in the file), add to the same object literal:
```ts
tv_evidence: batch.tvEvidence,
tv_evidence_at: batch.tvEvidence ? new Date().toISOString() : null,
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS — all callers of `saveDiscoveredProducts` will error until updated in Task 8 (that's OK; we fix them next).

If unexpected non-call-site errors appear, fix them before continuing.

- [ ] **Step 4: Commit**

```bash
git add lib/discovery/save.ts
git commit -m "feat(discovery): persist tv_evidence on save"
```

---

## Task 8: Wire evidence into daily-discovery-home cron

**Files:**
- Modify: `app/api/cron/daily-discovery-home/route.ts`

- [ ] **Step 1: Add evidence compute + bonus after existing boosts**

Modify `app/api/cron/daily-discovery-home/route.ts`. After the existing `applyCompetitorTrendBoost(...)` call (around line 87), insert:

```ts
		// TV evidence: per-candidate broadcast-history aggregate.
		// Spec: docs/superpowers/specs/2026-05-17-tv-evidence-mining-design.md
		const sb = getServiceClient();
		const evidenceEntries = await Promise.all(
			orchestrated.candidates.map(async (c) => {
				const ev = await computeTvEvidence(sb, {
					name: c.name,
					category: c.category ?? null,
					price_jpy: c.priceJpy ?? null,
				}).catch((err) => {
					console.warn(`[tv-evidence] compute failed for ${c.productUrl}:`, err?.message ?? err);
					return null;
				});
				return [c.productUrl, ev] as const;
			}),
		);
		const evidenceMap = new Map(evidenceEntries);
		applyEvidenceBonus(orchestrated.candidates, evidenceMap);
```

Add the imports at the top:

```ts
import { applyEvidenceBonus, computeTvEvidence } from "@/lib/discovery/tv-evidence";
```

Note: `getServiceClient` is already imported in this file.

- [ ] **Step 2: Update the `batch` construction to pass tvEvidence to save**

Replace the existing batch construction (currently around line 89-96):

```ts
		const batch = orchestrated.candidates.map((c) => {
			const bc = broadcastMap.get(c.productUrl);
			return {
				candidate: c,
				broadcastTag: bc?.tag ?? ("unknown" as const),
				broadcastSources: bc?.sources ?? [],
				tvEvidence: evidenceMap.get(c.productUrl) ?? null,
			};
		});
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/daily-discovery-home/route.ts
git commit -m "feat(discovery): wire tv-evidence into home cron"
```

---

## Task 9: Wire evidence into daily-discovery-live cron (same pattern)

**Files:**
- Modify: `app/api/cron/daily-discovery-live/route.ts`

- [ ] **Step 1: Apply the same changes as Task 8**

Make identical changes to `app/api/cron/daily-discovery-live/route.ts`:
1. Add imports for `applyEvidenceBonus, computeTvEvidence`.
2. Insert the evidence compute block after `applyCompetitorTrendBoost`.
3. Add `tvEvidence: evidenceMap.get(c.productUrl) ?? null` to the batch object literal.

The exact insertion point may differ by a few lines — search for `applyCompetitorTrendBoost` and place the new block immediately after.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/cron/daily-discovery-live/route.ts
git commit -m "feat(discovery): wire tv-evidence into live cron"
```

---

## Task 10: Weekly refresh cron

**Files:**
- Create: `app/api/cron/refresh-tv-evidence/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Write the cron handler**

Create `app/api/cron/refresh-tv-evidence/route.ts`:

```ts
import { type NextRequest, NextResponse } from "next/server";
import { computeTvEvidence } from "@/lib/discovery/tv-evidence";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 300;

const BATCH_SIZE = 50;
const STALE_DAYS = 7;
const MAX_ROWS_PER_RUN = 2000; // safety cap; full backlog will need ~5 runs

function verifyCronAuth(req: NextRequest): boolean {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true; // dev mode
	return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
	if (!verifyCronAuth(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const sb = getServiceClient();
	const cutoff = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();

	// Find candidates whose evidence is null OR older than STALE_DAYS.
	// Index idx_discovered_products_tv_evidence_at handles this query.
	const { data: rows, error } = await sb
		.from("discovered_products")
		.select("id, name, category, price_jpy")
		.or(`tv_evidence_at.is.null,tv_evidence_at.lt.${cutoff}`)
		.limit(MAX_ROWS_PER_RUN);

	if (error) {
		console.error("[refresh-tv-evidence] query failed:", error.message);
		return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
	}

	const total = rows?.length ?? 0;
	let updated = 0;
	let failed = 0;
	const start = Date.now();

	for (let i = 0; i < total; i += BATCH_SIZE) {
		const chunk = rows!.slice(i, i + BATCH_SIZE);
		const evidences = await Promise.all(
			chunk.map(async (r) => {
				try {
					const ev = await computeTvEvidence(sb, {
						name: r.name,
						category: r.category,
						price_jpy: r.price_jpy,
					});
					return { id: r.id, ev };
				} catch (err) {
					console.warn(`[refresh-tv-evidence] ${r.id} failed:`, err);
					return null;
				}
			}),
		);

		const updates = evidences.filter((e): e is { id: string; ev: ReturnType<typeof computeTvEvidence> extends Promise<infer U> ? U : never } => e !== null);

		for (const u of updates) {
			const upd = await sb
				.from("discovered_products")
				.update({
					tv_evidence: u.ev,
					tv_evidence_at: new Date().toISOString(),
				})
				.eq("id", u.id);
			if (upd.error) {
				console.warn(`[refresh-tv-evidence] update ${u.id} failed:`, upd.error.message);
				failed += 1;
			} else {
				updated += 1;
			}
		}
	}

	const log = {
		event: "refresh-tv-evidence.summary",
		total,
		updated,
		failed,
		durationMs: Date.now() - start,
	};
	console.log(JSON.stringify(log));
	return NextResponse.json({ ok: true, ...log });
}
```

- [ ] **Step 2: Register cron + function timeout in vercel.json**

Modify `vercel.json`:

In `"functions"` block, add:
```json
"app/api/cron/refresh-tv-evidence/route.ts": {
  "maxDuration": 300
}
```

In `"crons"` array, add:
```json
{
  "path": "/api/cron/refresh-tv-evidence",
  "schedule": "30 17 * * 0"
}
```

(`30 17 * * 0` = Sunday 17:30 UTC = Monday 02:30 JST, avoiding the daily `0 17` qvc-monthly-refresh.)

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Smoke-test the route locally**

Run: `npm run dev`
In a separate terminal: `curl -s "http://localhost:3000/api/cron/refresh-tv-evidence" | head -c 500`
Expected: `{"ok":true,"event":"refresh-tv-evidence.summary",...}` (dev-mode auth bypass kicks in since CRON_SECRET unset locally).
If `CRON_SECRET` is set locally, prefix the curl with `-H "authorization: Bearer $CRON_SECRET"`.

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/refresh-tv-evidence/route.ts vercel.json
git commit -m "feat(discovery): weekly tv-evidence refresh cron"
```

---

## Task 11: GET API for UI badge

**Files:**
- Create: `app/api/discovery/[productId]/tv-evidence/route.ts`

- [ ] **Step 1: Write the route handler**

Create `app/api/discovery/[productId]/tv-evidence/route.ts`:

```ts
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";

export async function GET(
	_request: Request,
	context: { params: Promise<{ productId: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { productId } = await context.params;
	if (!productId) {
		return NextResponse.json({ error: "missing productId" }, { status: 400 });
	}

	const { data, error } = await auth.sb
		.from("discovered_products")
		.select("id, tv_evidence, tv_evidence_at")
		.eq("id", productId)
		.maybeSingle();

	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
	if (!data) {
		return NextResponse.json({ error: "not found" }, { status: 404 });
	}
	return NextResponse.json({
		id: data.id,
		tv_evidence: data.tv_evidence,
		tv_evidence_at: data.tv_evidence_at,
	});
}
```

- [ ] **Step 2: Smoke-test the route**

Start dev: `npm run dev`
With a logged-in browser session and a known product id, hit:
`http://localhost:3000/api/discovery/<some-id>/tv-evidence`
Expected: 200 with `tv_evidence` field (may be null if not yet computed).
Without login: 401.
As viewer role: 403.

- [ ] **Step 3: Commit**

```bash
git add app/api/discovery/[productId]/tv-evidence/route.ts
git commit -m "feat(discovery): tv-evidence GET API"
```

---

## Task 12: UI badge component

**Files:**
- Create: `components/discovery/TvEvidenceBadge.tsx`

- [ ] **Step 1: Locate the discovery list component**

Run: `grep -rn "tvFitScore\|tv_fit_score" components/ app/ --include="*.tsx" | grep -i "discover" | head`
Identify the file that renders one candidate card in the discovery list. Common location: `components/discovery/DiscoveryCard.tsx` or `app/[locale]/analytics/discovery/...`.

- [ ] **Step 2: Write the badge component**

Create `components/discovery/TvEvidenceBadge.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { TvEvidence } from "@/lib/discovery/types";

interface Props {
	productId: string;
}

export default function TvEvidenceBadge({ productId }: Props) {
	const [ev, setEv] = useState<TvEvidence | null | "loading" | "error">("loading");

	useEffect(() => {
		let cancelled = false;
		fetch(`/api/discovery/${productId}/tv-evidence`)
			.then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
			.then((data: { tv_evidence: TvEvidence | null }) => {
				if (!cancelled) setEv(data.tv_evidence);
			})
			.catch(() => {
				if (!cancelled) setEv("error");
			});
		return () => {
			cancelled = true;
		};
	}, [productId]);

	if (ev === "loading" || ev === "error" || ev === null) return null;

	const channelSummary = Object.entries(ev.channel_breakdown)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([ch, n]) => `${ch.toUpperCase()} ${n}回`)
		.join(" · ");

	const priceText = ev.price_jpy
		? ` · 中央値 ¥${ev.price_jpy.median.toLocaleString()}`
		: "";

	return (
		<Badge variant="outline" className="text-xs font-normal" title={`実測放送データ (強度 ${(ev.evidence_strength * 100).toFixed(0)}%)`}>
			📺 {channelSummary} · 30日内 {ev.recent_30d_count}回{priceText}
		</Badge>
	);
}
```

- [ ] **Step 3: Mount the badge in the discovery list**

Insert `<TvEvidenceBadge productId={item.id} />` in the relevant card render — near the `tvFitScore` display. Add the import:
```tsx
import TvEvidenceBadge from "@/components/discovery/TvEvidenceBadge";
```

If multiple list components exist (`/analytics/discovery/home`, `/analytics/discovery/live`, etc.), add to all.

- [ ] **Step 4: Visual check**

Start dev: `npm run dev`
Navigate to `/ja/analytics/discovery/home`.
Confirm the badge renders for candidates that have evidence, and does not appear (no broken-state markup) for those without.

- [ ] **Step 5: Commit**

```bash
git add components/discovery/TvEvidenceBadge.tsx <list-component-path>
git commit -m "feat(discovery): tv-evidence UI badge"
```

---

## Task 13: Strategy integration — pool-query + Gemini prompt

**Files:**
- Modify: `lib/strategy/pool-query.ts`
- Modify: `lib/md-strategy.ts`

- [ ] **Step 1: Add tv_evidence to PoolRow + select**

In `lib/strategy/pool-query.ts`:

1. Extend the `PoolRow` interface (just before the closing `}`):
```ts
	tv_evidence: import("@/lib/discovery/types").TvEvidence | null;
```

2. Find the `.select(...)` call that lists columns (in `loadPoolForContext` or similar function) and add `, tv_evidence` to the comma-separated column list.

- [ ] **Step 2: Pipe tv_evidence into the strategy DiscoveryPoolItem**

In `lib/md-strategy.ts`, find the `poolItems = rows.map((r) => ({ ... }))` block (around line 557). Add a field:
```ts
				tv_evidence: r.tv_evidence,
```

Update the inline `DiscoveryPoolItem` interface (search for `interface DiscoveryPoolItem` in the same file) to add:
```ts
	tv_evidence?: import("@/lib/discovery/types").TvEvidence | null;
```

- [ ] **Step 3: Inject evidence into the Gemini prompt**

Locate the prompt construction inside `discoverNewProducts` (search for `poolText` or the multi-line template string that lists pool items). For each pool item that has `tv_evidence`, append a one-line summary to its description string:

```ts
		const evidenceLine = item.tv_evidence
			? `\n  実測放送: ${item.tv_evidence.airing_count}回 (直近30日 ${item.tv_evidence.recent_30d_count}回, 中央値 ¥${item.tv_evidence.price_jpy?.median ?? "—"})`
			: "";
```

Append `${evidenceLine}` inside the `poolText` template per item. Concrete edit location: where each item is formatted (look for `name`, `price`, `snippet` being concatenated).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Run existing strategy tests to confirm no regression**

Run: `npm run test:strategy-pool`
Expected: PASS — pool-query tests still green.

- [ ] **Step 6: Commit**

```bash
git add lib/strategy/pool-query.ts lib/md-strategy.ts
git commit -m "feat(strategy): inject tv-evidence into discoverNewProducts prompt"
```

---

## Task 14: Diagnostic script

**Files:**
- Create: `scripts/check-tv-evidence.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the script**

Create `scripts/check-tv-evidence.ts`:

```ts
import { computeTvEvidence } from "../lib/discovery/tv-evidence";
import { getServiceClient } from "../lib/supabase";

async function main() {
	const id = process.argv[2];
	if (!id) {
		console.error("Usage: tsx scripts/check-tv-evidence.ts <discovered_product_id>");
		process.exit(1);
	}

	const sb = getServiceClient();
	const { data, error } = await sb
		.from("discovered_products")
		.select("id, name, category, price_jpy, tv_evidence, tv_evidence_at, tv_fit_score, tv_fit_reason")
		.eq("id", id)
		.single();

	if (error || !data) {
		console.error("Lookup failed:", error?.message ?? "not found");
		process.exit(1);
	}

	console.log(`Product: ${data.name}`);
	console.log(`  category: ${data.category}`);
	console.log(`  price_jpy: ${data.price_jpy}`);
	console.log(`  tv_fit_score: ${data.tv_fit_score}`);
	console.log(`  tv_fit_reason: ${data.tv_fit_reason}`);
	console.log(`  stored tv_evidence_at: ${data.tv_evidence_at}`);

	console.log("\nRecomputing live...");
	const fresh = await computeTvEvidence(sb, {
		name: data.name,
		category: data.category,
		price_jpy: data.price_jpy,
	});

	console.log("\nLive result:");
	console.log(JSON.stringify(fresh, null, 2));

	console.log("\nStored result:");
	console.log(JSON.stringify(data.tv_evidence, null, 2));
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
```

- [ ] **Step 2: Add npm alias**

Modify `package.json`, add:
```json
"check:tv-evidence": "tsx --env-file=.env.local scripts/check-tv-evidence.ts",
```

- [ ] **Step 3: Smoke test**

Pick any real id from `discovered_products`:
```bash
npm run check:tv-evidence -- <some-id>
```
Expected: prints product fields, recomputed live evidence, and stored evidence side-by-side.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-tv-evidence.ts package.json
git commit -m "feat(discovery): tv-evidence diagnostic script"
```

---

## Task 15: Final verification — full test suite + first-run refresh

**Files:** none (verification only)

- [ ] **Step 1: Apply migration**

Run: `npm run test:migrations` to confirm syntax.
Apply the migration to staging Supabase using the project's existing migration workflow (likely via Supabase CLI or dashboard — check `docs/superpowers/specs/2026-05-13-auth-and-tiered-access-design.md` if unsure).

- [ ] **Step 2: Type-check end-to-end**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings, no new errors).

- [ ] **Step 4: Run full evidence test suite**

Run: `npm run test:tv-evidence`
Expected: PASS — unit + integration.

- [ ] **Step 5: Trigger the refresh cron manually once**

After the migration is applied:
```bash
curl -s "http://localhost:3000/api/cron/refresh-tv-evidence" -H "authorization: Bearer $CRON_SECRET" | head -c 1000
```
Expected: `{"ok":true,"total":<N>,"updated":<N>,"failed":0,...}`.

- [ ] **Step 6: Spot-check 5 candidates via diagnostic**

```bash
# pick 5 ids with high tv_fit_score
psql "$DATABASE_URL" -c "select id from discovered_products order by tv_fit_score desc limit 5;" | tail -n +3 | head -5
# run diagnostic for each
npm run check:tv-evidence -- <id1>
# ... repeat for 5 ids
```
Confirm: evidence_strength is reasonable (0.2–0.9 for typical candidates), channel breakdown includes channels you'd expect for the category, samples list 5 plausible past broadcasts.

- [ ] **Step 7: Final commit (if any cleanup) and push**

```bash
git status
# if changes exist:
git add <files>
git commit -m "chore(discovery): final tv-evidence verification cleanup"
# Confirm with user before pushing per CLAUDE.md preference.
```

---

## Self-Review (completed during plan write)

1. **Spec coverage:** §1 goal covered by Tasks 4–13; §2 non-goals respected (no ML, no script corpus, no dashboard, no Gemini in compute); §3 data sources used in Task 5; §4 matching covered (with the documented deviation from `CATEGORY_MAPPING` to `splitCategoryToKeywords`); §5 JSON shape implemented in Tasks 2 + 4; §6 file inventory matches the file table; §7 score integration in Task 6 + 8 + 9 (cap, recency precedence preserved); §8 report grounding in Task 13 (strategy first, analyze path deferred as spec stated); §9 fail-open behavior in Tasks 5 + 6 + 10; §10 RLS noted in Task 1 migration + Task 11 API; §11 perf targets achievable (3 SQL queries, no Gemini); §12 test plan implemented in Tasks 3–6 + 15; §13 rollout via Task 15.

2. **Placeholders:** None found. `<list-component-path>` and `<id1>` etc. are intentional run-time placeholders the engineer fills based on grep output — they're documented in the prior step's grep command.

3. **Type consistency:** `TvEvidence`, `BroadcastRow`, `CandidateInput` defined once in Task 2 / Task 4 / Task 5 and reused everywhere. `applyEvidenceBonus` signature: `(candidates: Candidate[], evidenceByUrl: Map<string, TvEvidence | null>) => number` — consistent across Task 6 and Tasks 8/9 wire-up.

4. **Scope:** Single PR, single worktree. Migration is additive and nullable, so it can be applied independently of code changes without breaking anything.
