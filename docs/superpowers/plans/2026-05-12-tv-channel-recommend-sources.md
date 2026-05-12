# TV Channel Recommend Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the home_shopping discovery page surface products from the 12 Japanese TV-shopping channels (Excel rows 1–25) before non-TV-channel candidates, sourced from the existing `broadcasts` table (shopch/qvc) plus Brave `site:`-restricted search for the other 10.

**Architecture:** Add a `tv_channel` source type to the discovery pipeline. Two new pool-builder passes — Pass C reads from `broadcasts`, Pass D runs budgeted `site:<domain>` Brave searches. Candidates get a `tvChannelSource` field that's persisted to a new `discovered_products.tv_channel_source` column, paired with a generated `tv_tier` column (0=TV, 1=other). The orchestrator partitions candidates by tier; the API and UI order by `(tv_tier ASC, tv_fit_score DESC)`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (PostgreSQL), tsx-based test scripts using `node:assert/strict`, Brave Web Search API, Gemini.

**Spec reference:** `docs/superpowers/specs/2026-05-12-tv-channel-recommend-sources-design.md`

---

## File Structure

**Create:**
- `supabase/migrations/20260512_add_tv_channel_source.sql` — schema migration
- `lib/discovery/tv-channels.ts` — channel registry (12 entries)
- `scripts/test-tv-channel-mapping.ts` — Candidate-mapping regression test
- `scripts/test-discovery-partition.ts` — orchestrator partition test
- `scripts/test-tv-channel-derive.ts` — `tvChannelSource` derivation test
- `scripts/test-pool-tv-channel.ts` — Pass C/D pool-builder tests

**Modify:**
- `lib/discovery/types.ts` — extend `CandidateSource`, `PoolItem`, `Candidate`
- `lib/discovery/tv-channels.ts` — (created above; helper for sort+join)
- `lib/discovery/pool.ts` — add `fetchTvChannelFromBroadcasts`, `fetchTvChannelFromBraveSite`, extend dedup
- `lib/discovery/curate.ts` — derive `tvChannelSource` during PoolItem→Candidate mapping
- `lib/discovery/orchestrator.ts` — partition + concat
- `lib/discovery/save.ts` — write `tv_channel_source` + `DiscoveredProductRow` type
- `app/api/discovery/today/route.ts` — order by `tv_tier` then `tv_fit_score`
- `app/[locale]/analytics/discovery/home/page.tsx` — two sections + section headings
- `components/discovery/ProductCard.tsx` — channel badge row + extend `DiscoveredProductRow` type
- `messages/en.json`, `messages/ja.json` — section heading keys
- `scripts/verify-discovery-run.ts` — print tv-tier ratio
- `CLAUDE.md` — document the feature and new env vars
- `package.json` — add npm scripts for the 4 new tests

---

## Task 1: Schema migration

**Files:**
- Create: `supabase/migrations/20260512_add_tv_channel_source.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260512_add_tv_channel_source.sql`:

```sql
-- TV channel recommendation source: tier-1 priority signal for discovery.
-- tv_channel_source: comma-joined alphabetically-sorted slugs (e.g. "qvc,shopch"); NULL when none.
-- tv_tier: generated 0/1 boolean-shaped key so ORDER BY produces "TV first, then others".

ALTER TABLE discovered_products
  ADD COLUMN tv_channel_source text,
  ADD COLUMN tv_tier int
    GENERATED ALWAYS AS (CASE WHEN tv_channel_source IS NULL THEN 1 ELSE 0 END) STORED;

CREATE INDEX discovered_products_tier_idx
  ON discovered_products (session_id, tv_tier ASC, tv_fit_score DESC);
```

- [ ] **Step 2: Apply the migration locally**

Run via the Supabase CLI (or whatever method the team uses — `npm run test:migrations` may confirm the migration file is well-formed):

```bash
npm run test:migrations
```

Expected: PASS — script reports `20260512_add_tv_channel_source.sql` as a valid migration entry. (If the script doesn't auto-discover new migrations, check `scripts/check-migrations.ts` and follow whatever pattern it expects.)

- [ ] **Step 3: Verify the columns exist in dev DB**

```bash
psql "$SUPABASE_DB_URL" -c "\d discovered_products" | grep -E "tv_channel_source|tv_tier"
```

Expected output:
```
 tv_channel_source           | text                        |           |          |
 tv_tier                     | integer                     |           |          | generated always as (CASE WHEN tv_channel_source IS NULL THEN 1 ELSE 0 END) stored
```

(Or — if Supabase migrations are pushed via dashboard / supabase CLI: confirm in the SQL editor that the columns appear in `discovered_products`.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260512_add_tv_channel_source.sql
git commit -m "feat(discovery): add tv_channel_source + tv_tier columns"
```

---

## Task 2: Channel registry

**Files:**
- Create: `lib/discovery/tv-channels.ts`

- [ ] **Step 1: Write the registry**

Create `lib/discovery/tv-channels.ts`:

```ts
/**
 * Registry of Japanese TV-shopping channels used as priority signal in discovery.
 * `scraped: true` channels are sourced from the `broadcasts` table (populated by
 * Broadcast Calendar Phase A). `scraped: false` channels are sourced via
 * Brave site:-restricted search.
 *
 * Source: docs/検索参考サイト (2).xlsx rows 1-25.
 */

export interface TvChannel {
	/** Stable identifier persisted in DB. */
	slug: string;
	/** Japanese display name for UI. */
	name: string;
	/** Site identifier used for Brave `site:` queries. May include a path prefix
	 *  when two channels share a host (せのぶら / らくらく茂 both live on
	 *  shop.asahi.co.jp). */
	siteQuery: string;
	/** True when the channel is populated by the broadcasts cron. */
	scraped: boolean;
}

export const TV_CHANNELS: readonly TvChannel[] = [
	{ slug: "shopch",    name: "ショップチャンネル",     siteQuery: "shopch.jp",                            scraped: true  },
	{ slug: "qvc",       name: "QVC",                  siteQuery: "qvc.jp",                              scraped: true  },
	{ slug: "ntv",       name: "日テレ",                siteQuery: "shop.ntv.co.jp",                      scraped: false },
	{ slug: "tbs",       name: "TBS",                  siteQuery: "tbs.co.jp/shopping",                  scraped: false },
	{ slug: "dinos",     name: "ディノス",              siteQuery: "dinos.co.jp/tv",                      scraped: false },
	{ slug: "ropping",   name: "ロッピングライフ",       siteQuery: "ropping.tv-asahi.co.jp",              scraped: false },
	{ slug: "senobura",  name: "せのぶら本舗",          siteQuery: "shop.asahi.co.jp/category/SENOBURA",  scraped: false },
	{ slug: "rakurakum", name: "らくらく茂",            siteQuery: "shop.asahi.co.jp/category/RAKURAKU",  scraped: false },
	{ slug: "ichiban",   name: "いちばん本舗",          siteQuery: "shop.tokai-tv.com",                   scraped: false },
	{ slug: "kachimo",   name: "カチモ",                siteQuery: "kachimo.jp",                          scraped: false },
	{ slug: "kaidoki",   name: "買いドキ！マーケット",   siteQuery: "satv.shop",                           scraped: false },
	{ slug: "kantv",     name: "関テレ",                siteQuery: "ktvolm.jp",                           scraped: false },
];

/** Look up a channel by its slug. Returns undefined if not registered. */
export function getChannelBySlug(slug: string): TvChannel | undefined {
	return TV_CHANNELS.find((c) => c.slug === slug);
}

/** Map a Phase A broadcasts.channel value to a TvChannel slug. */
export function broadcastsChannelToSlug(channel: "shopch" | "qvc"): string {
	return channel;
}

/**
 * Convert a list of slugs to the canonical persisted form:
 * alphabetical sort + comma-join. Returns null when the input is empty.
 * The alphabetical sort is what makes the persisted value deterministic
 * (so "qvc,shopch" never appears as "shopch,qvc" and equality holds).
 */
export function serializeChannelSlugs(slugs: readonly string[]): string | null {
	if (slugs.length === 0) return null;
	const unique = Array.from(new Set(slugs));
	unique.sort();
	return unique.join(",");
}

/** Inverse of serializeChannelSlugs. Returns [] for null/empty. */
export function parseChannelSlugs(value: string | null | undefined): string[] {
	if (!value) return [];
	return value.split(",").map((s) => s.trim()).filter(Boolean);
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/discovery/tv-channels.ts
git commit -m "feat(discovery): add TV channel registry"
```

---

## Task 3: Extend domain types

**Files:**
- Modify: `lib/discovery/types.ts`

- [ ] **Step 1: Extend `CandidateSource`, `PoolItem`, `Candidate`**

In `lib/discovery/types.ts`, modify line 8:

```ts
export type CandidateSource = "rakuten" | "brave" | "tv_channel" | "other";
```

Then extend `PoolItem` (currently lines 36–51) by adding two optional fields after `context?: Context;`:

```ts
export interface PoolItem {
	name: string;
	productUrl: string;
	thumbnailUrl?: string;
	priceJpy?: number;
	category?: string;
	reviewCount?: number;
	reviewAvg?: number;
	sellerName?: string;
	stockStatus?: string;
	source: CandidateSource;
	rakutenItemCode?: string;
	seedKeyword: string;
	track: Track;
	context?: Context;
	/** Primary channel slug for a tv_channel-sourced PoolItem. */
	tvChannel?: string;
	/** All channel slugs that surfaced the same product (post-dedup merge). */
	tvChannelMatches?: string[];
}
```

Extend `Candidate` (lines 62–69) by adding one field:

```ts
export interface Candidate extends PoolItem {
	tvFitScore: number;
	tvFitReason: string;
	isTvApplicable: boolean;
	isLiveApplicable: boolean;
	scoreBreakdown: CurationScore;
	context: Context;
	/** Comma-joined alphabetically-sorted channel slugs, or null. */
	tvChannelSource?: string | null;
}
```

- [ ] **Step 2: Verify TypeScript still compiles**

```bash
npx tsc --noEmit
```

Expected: No errors (the new fields are all optional; existing code paths are unaffected).

- [ ] **Step 3: Commit**

```bash
git add lib/discovery/types.ts
git commit -m "feat(discovery): extend types with tv_channel source and fields"
```

---

## Task 4: tvChannelSource derivation helper (TDD)

**Files:**
- Modify: `lib/discovery/tv-channels.ts` (add helper)
- Create: `scripts/test-tv-channel-derive.ts`
- Modify: `package.json` (new npm script)

- [ ] **Step 1: Write the failing test**

Create `scripts/test-tv-channel-derive.ts`:

```ts
import assert from "node:assert/strict";
import { deriveTvChannelSource } from "@/lib/discovery/tv-channels";
import type { PoolItem } from "@/lib/discovery/types";

const base: PoolItem = {
	name: "X",
	productUrl: "https://example.com/x",
	source: "tv_channel",
	seedKeyword: "kw",
	track: "tv_proven",
};

// 1. No channel info → null
assert.equal(deriveTvChannelSource(base), null);

// 2. Single channel via tvChannel
assert.equal(
	deriveTvChannelSource({ ...base, tvChannel: "shopch" }),
	"shopch",
);

// 3. tvChannelMatches takes precedence; output is alphabetically sorted
assert.equal(
	deriveTvChannelSource({
		...base,
		tvChannel: "shopch",
		tvChannelMatches: ["shopch", "qvc"],
	}),
	"qvc,shopch",
);

// 4. tvChannelMatches with duplicates is deduped
assert.equal(
	deriveTvChannelSource({
		...base,
		tvChannelMatches: ["qvc", "qvc", "shopch"],
	}),
	"qvc,shopch",
);

// 5. Empty tvChannelMatches falls back to null (NOT empty string)
assert.equal(
	deriveTvChannelSource({ ...base, tvChannelMatches: [] }),
	null,
);

console.log("PASS: deriveTvChannelSource");
```

Add an npm script to `package.json` after the existing test scripts:

```json
"test:tv-channel-derive": "tsx --env-file=.env.local scripts/test-tv-channel-derive.ts",
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test:tv-channel-derive
```

Expected: FAIL with "Cannot find module" or "deriveTvChannelSource is not exported".

- [ ] **Step 3: Implement the helper**

In `lib/discovery/tv-channels.ts`, append after `parseChannelSlugs`:

```ts
import type { PoolItem } from "./types";

/**
 * Derive the persisted `tv_channel_source` value for a PoolItem.
 * Returns null when no channel hit exists. Output is alphabetically
 * sorted and deduplicated, matching the contract of `serializeChannelSlugs`.
 */
export function deriveTvChannelSource(item: PoolItem): string | null {
	const slugs: string[] = [];
	if (item.tvChannelMatches && item.tvChannelMatches.length > 0) {
		slugs.push(...item.tvChannelMatches);
	} else if (item.tvChannel) {
		slugs.push(item.tvChannel);
	}
	return serializeChannelSlugs(slugs);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run test:tv-channel-derive
```

Expected: `PASS: deriveTvChannelSource`

- [ ] **Step 5: Commit**

```bash
git add lib/discovery/tv-channels.ts scripts/test-tv-channel-derive.ts package.json
git commit -m "feat(discovery): add deriveTvChannelSource helper with tests"
```

---

## Task 5: Pool builder Pass C — broadcasts source (TDD)

**Files:**
- Modify: `lib/discovery/pool.ts`
- Create: `scripts/test-pool-tv-channel.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test for Pass C normalization + grouping**

Create `scripts/test-pool-tv-channel.ts`:

```ts
import assert from "node:assert/strict";
import { __test } from "@/lib/discovery/pool";

// __test exposes pure helpers for unit testing.

// Test A: normalizeDescription
{
	const f = __test.normalizeDescription;
	assert.equal(f("  Hello  WORLD  "), "hello world");
	assert.equal(f("ＡＢＣ ＤＥＦ"), "abc def"); // NFKC
	assert.equal(f("  クッキング\tクックル  "), "クッキング クックル");
}

// Test B: matchAnySeed (substring match against normalized form)
{
	const f = __test.matchAnySeed;
	assert.equal(f("blender mixer 300w", ["mixer"]), true);
	assert.equal(f("blender mixer 300w", ["air fryer"]), false);
	assert.equal(f("ＢＬＥＮＤＥＲ", ["blender"]), false); // normalize done by caller
}

// Test C: groupBroadcastRows — same normalized name across channels → one item with both slugs
{
	const f = __test.groupBroadcastRows;
	const rows = [
		{ channel: "shopch", description: "美顔器 EH-XS10", thumbnail_url: "t1", source_url: "u1", air_date: "2026-05-10" },
		{ channel: "qvc",    description: "美顔器 EH-XS10", thumbnail_url: "t2", source_url: "u2", air_date: "2026-05-11" },
		{ channel: "shopch", description: "別商品", thumbnail_url: "t3", source_url: "u3", air_date: "2026-05-09" },
	];
	const out = f(rows);
	assert.equal(out.length, 2);
	const merged = out.find((p) => p.name.startsWith("美顔器"));
	assert.ok(merged);
	assert.deepEqual(merged!.tvChannelMatches?.slice().sort(), ["qvc", "shopch"]);
	// Most recent slot's thumbnail/url wins (2026-05-11 > 2026-05-10)
	assert.equal(merged!.thumbnailUrl, "t2");
	assert.equal(merged!.productUrl, "u2");
	// Display name preserves original (longest seen)
	assert.equal(merged!.name, "美顔器 EH-XS10");
}

console.log("PASS: pool tv_channel helpers");
```

Add to `package.json`:

```json
"test:pool-tv-channel": "tsx --env-file=.env.local scripts/test-pool-tv-channel.ts",
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test:pool-tv-channel
```

Expected: FAIL with "Cannot find module" or "__test.normalizeDescription is not a function".

- [ ] **Step 3: Implement the helpers and Pass C**

In `lib/discovery/pool.ts`, modify the existing imports and add new code.

Top of file, add to imports:

```ts
import { getServiceClient } from "@/lib/supabase";
import { TV_CHANNELS, broadcastsChannelToSlug } from "./tv-channels";
```

Add constants near the existing throttle constants (after `BRAVE_PER_KEYWORD = 5;`):

```ts
const TV_CHANNEL_BROADCAST_WINDOW_DAYS = Number(
	process.env.TV_CHANNEL_BROADCAST_WINDOW_DAYS ?? 30,
);
```

Add the new pure helpers (after `extractRakutenCode`):

```ts
/**
 * Normalize a description for comparison. Original strings are preserved
 * separately for display.
 */
function normalizeDescription(s: string): string {
	return s
		.normalize("NFKC")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/** Substring match against the normalized description. Seeds are matched as
 *  given (assume seedKeyword strings are short and already in canonical form). */
function matchAnySeed(normalized: string, seeds: readonly string[]): boolean {
	for (const s of seeds) {
		if (!s) continue;
		if (normalized.includes(s.toLowerCase())) return true;
	}
	return false;
}

interface BroadcastRow {
	channel: "shopch" | "qvc";
	description: string;
	thumbnail_url: string | null;
	source_url: string;
	air_date: string; // YYYY-MM-DD
}

/**
 * Group broadcast rows by normalized description.
 * - tvChannelMatches: all channels that aired the product, alphabetical.
 * - thumbnail/url: most recent slot wins.
 * - name: longest original description seen (preserves type-numbers / full-width).
 */
function groupBroadcastRows(rows: readonly BroadcastRow[]): PoolItem[] {
	const groups = new Map<
		string,
		{
			displayName: string;
			channels: Set<string>;
			latest: { airDate: string; thumb: string | null; url: string };
		}
	>();

	for (const row of rows) {
		if (!row.description) continue;
		const key = normalizeDescription(row.description);
		if (!key) continue;
		const slug = broadcastsChannelToSlug(row.channel);
		const existing = groups.get(key);
		if (!existing) {
			groups.set(key, {
				displayName: row.description,
				channels: new Set([slug]),
				latest: { airDate: row.air_date, thumb: row.thumbnail_url, url: row.source_url },
			});
			continue;
		}
		existing.channels.add(slug);
		// Keep longest original description as display.
		if (row.description.length > existing.displayName.length) {
			existing.displayName = row.description;
		}
		// Most recent slot's thumbnail/url.
		if (row.air_date > existing.latest.airDate) {
			existing.latest = {
				airDate: row.air_date,
				thumb: row.thumbnail_url,
				url: row.source_url,
			};
		}
	}

	const items: PoolItem[] = [];
	for (const [, group] of groups) {
		const channelList = Array.from(group.channels).sort();
		items.push({
			name: group.displayName,
			productUrl: group.latest.url,
			thumbnailUrl: group.latest.thumb ?? undefined,
			source: "tv_channel",
			seedKeyword: "", // filled in by caller after seed match
			track: "tv_proven",
			tvChannel: channelList[0],
			tvChannelMatches: channelList,
		});
	}
	return items;
}

/**
 * Pass C: read recent broadcast slots, group by normalized description,
 * filter to descriptions matching any seed keyword. Returns one PoolItem
 * per surviving group. Fail-open on DB error.
 */
async function fetchTvChannelFromBroadcasts(
	plan: CategoryPlan,
	windowDays = TV_CHANNEL_BROADCAST_WINDOW_DAYS,
): Promise<PoolItem[]> {
	const sb = getServiceClient();
	const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000)
		.toISOString()
		.slice(0, 10);
	const { data, error } = await sb
		.from("broadcasts")
		.select("channel, description, thumbnail_url, source_url, air_date")
		.gte("air_date", since)
		.not("description", "is", null);

	if (error) {
		console.warn(`[pool] broadcasts SELECT failed: ${error.message}`);
		return [];
	}
	const rows = (data ?? []) as BroadcastRow[];
	const grouped = groupBroadcastRows(rows);

	const seeds = [...plan.tv_proven, ...plan.exploration]
		.map((s) => s.toLowerCase().trim())
		.filter(Boolean);

	const result: PoolItem[] = [];
	for (const item of grouped) {
		const normalized = normalizeDescription(item.name);
		const matchedSeed = seeds.find((s) => normalized.includes(s));
		if (!matchedSeed) continue;
		result.push({
			...item,
			seedKeyword: matchedSeed,
			track: plan.tv_proven.map((s) => s.toLowerCase()).includes(matchedSeed)
				? "tv_proven"
				: "exploration",
		});
	}
	return result;
}
```

Export the pure helpers under `__test` (extend the existing block at the bottom of the file):

```ts
export const __test = {
	RAKUTEN_THROTTLE_MS,
	RAKUTEN_PER_KEYWORD,
	BRAVE_PER_KEYWORD,
	normalizeDescription,
	matchAnySeed,
	groupBroadcastRows,
	fetchTvChannelFromBroadcasts,
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run test:pool-tv-channel
```

Expected: `PASS: pool tv_channel helpers`

- [ ] **Step 5: Commit**

```bash
git add lib/discovery/pool.ts scripts/test-pool-tv-channel.ts package.json
git commit -m "feat(discovery): add Pass C broadcasts source for tv_channel pool"
```

---

## Task 6: Pool builder Pass D — Brave site:-restricted search

**Files:**
- Modify: `lib/discovery/pool.ts`

- [ ] **Step 1: Implement Pass D**

In `lib/discovery/pool.ts`, after the Pass C `fetchTvChannelFromBroadcasts` function, add:

```ts
const TV_CHANNEL_BRAVE_BUDGET = Number(process.env.TV_CHANNEL_BRAVE_BUDGET ?? 50);
const TV_CHANNEL_BRAVE_CONCURRENCY = 4;
const TV_CHANNEL_BRAVE_PER_CALL = 5;

/**
 * Pass D: for each non-scraped channel, run budgeted Brave `site:<query>`
 * searches over the day's keywords. Round-robin so every channel gets at
 * least one call before any channel doubles. Stops at the budget limit.
 * Fail-open per-call.
 */
async function fetchTvChannelFromBraveSite(
	plan: CategoryPlan,
	channels: ReadonlyArray<{ slug: string; siteQuery: string; scraped: boolean }>,
	budget: number,
): Promise<PoolItem[]> {
	const targets = channels.filter((c) => !c.scraped);
	if (targets.length === 0 || budget <= 0) return [];

	const allKws = [
		...plan.tv_proven.map((kw) => ({ kw, track: "tv_proven" as Track })),
		...plan.exploration.map((kw) => ({ kw, track: "exploration" as Track })),
	];
	if (allKws.length === 0) return [];

	// Round-robin (channel cycle outer, keyword cycle inner) up to budget.
	const tasks: Array<{
		channel: (typeof targets)[number];
		keyword: string;
		track: Track;
	}> = [];
	const maxRounds = Math.ceil(budget / targets.length);
	outer: for (let k = 0; k < maxRounds; k++) {
		for (const channel of targets) {
			const slot = allKws[(tasks.length) % allKws.length];
			tasks.push({ channel, keyword: slot.kw, track: slot.track });
			if (tasks.length >= budget) break outer;
		}
	}

	const items: PoolItem[] = [];
	let cursor = 0;
	const worker = async () => {
		while (cursor < tasks.length) {
			const idx = cursor++;
			const task = tasks[idx];
			const query = `${task.keyword} site:${task.channel.siteQuery}`;
			try {
				const results = await braveSearchItems(query, TV_CHANNEL_BRAVE_PER_CALL);
				for (const r of results) {
					if (!r.url) continue;
					items.push({
						name: r.title || r.url,
						productUrl: r.url,
						source: "tv_channel",
						seedKeyword: task.keyword,
						track: task.track,
						tvChannel: task.channel.slug,
					});
				}
			} catch (err) {
				console.warn(
					`[pool] brave site:${task.channel.siteQuery} "${task.keyword}" failed:`,
					err instanceof Error ? err.message : String(err),
				);
			}
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(TV_CHANNEL_BRAVE_CONCURRENCY, tasks.length) },
			() => worker(),
		),
	);
	return items;
}
```

Also extend the `__test` export with `fetchTvChannelFromBraveSite` so future tests can exercise it:

```ts
export const __test = {
	RAKUTEN_THROTTLE_MS,
	RAKUTEN_PER_KEYWORD,
	BRAVE_PER_KEYWORD,
	normalizeDescription,
	matchAnySeed,
	groupBroadcastRows,
	fetchTvChannelFromBroadcasts,
	fetchTvChannelFromBraveSite,
};
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add lib/discovery/pool.ts
git commit -m "feat(discovery): add Pass D Brave site: search for non-scraped channels"
```

---

## Task 7: Integrate Passes C+D into `buildPool` with channel-aware dedup

**Files:**
- Modify: `lib/discovery/pool.ts`

- [ ] **Step 1: Modify `buildPool` to call Pass C and Pass D and merge with channel-aware dedup**

In `lib/discovery/pool.ts`, replace the existing `buildPool` function (current lines 130–168) with this version:

```ts
/**
 * Build the candidate pool for a category plan.
 * Returns unique items across Rakuten + Brave + TV channel sources.
 *
 * Dedup strategy:
 * - Rakuten + Brave + Pass D (Brave site:): all carry product URLs → URL dedup.
 *   When a Pass D item collides with an existing Rakuten/Brave entry, channel
 *   info is merged onto the existing entry (so it gets tier-1 status).
 * - Pass C (broadcasts): no product URL exists; keyed by normalized description
 *   within Pass C only, NOT merged with Rakuten/Brave items.
 */
export async function buildPool(plan: CategoryPlan): Promise<PoolItem[]> {
	const tvKws = plan.tv_proven.map((kw) => ({ kw, track: "tv_proven" as Track }));
	const expKws = plan.exploration.map((kw) => ({ kw, track: "exploration" as Track }));
	const allKws = [...tvKws, ...expKws];

	const urlIndexed = new Map<string, PoolItem>(); // normalizedUrl → item

	const addUrlItem = (item: PoolItem) => {
		const key = normalizeUrlForDedup(item.productUrl);
		const existing = urlIndexed.get(key);
		if (!existing) {
			urlIndexed.set(key, item);
			return;
		}
		// Merge tv_channel info onto existing entry.
		if (item.tvChannel || item.tvChannelMatches) {
			const merged = new Set<string>();
			if (existing.tvChannelMatches) {
				for (const s of existing.tvChannelMatches) merged.add(s);
			} else if (existing.tvChannel) {
				merged.add(existing.tvChannel);
			}
			if (item.tvChannelMatches) {
				for (const s of item.tvChannelMatches) merged.add(s);
			} else if (item.tvChannel) {
				merged.add(item.tvChannel);
			}
			const sorted = Array.from(merged).sort();
			existing.tvChannelMatches = sorted;
			if (!existing.tvChannel) existing.tvChannel = sorted[0];
		}
	};

	// Rakuten — sequential with throttle
	for (const { kw, track } of allKws) {
		const items = await fetchRakutenForKeyword(kw, track);
		for (const it of items) addUrlItem(it);
		await new Promise((r) => setTimeout(r, RAKUTEN_THROTTLE_MS));
	}

	// Brave general — parallel
	const braveBatches = await Promise.allSettled(
		allKws.map(({ kw, track }) => fetchBraveForKeyword(kw, track)),
	);
	for (const batch of braveBatches) {
		if (batch.status !== "fulfilled") continue;
		for (const it of batch.value) addUrlItem(it);
	}

	// Pass D — Brave site:-restricted (10 non-scraped channels)
	const passD = await fetchTvChannelFromBraveSite(
		plan,
		TV_CHANNELS,
		TV_CHANNEL_BRAVE_BUDGET,
	);
	for (const it of passD) addUrlItem(it);

	// Pass C — broadcasts (shopch + qvc). Keyed by normalized name, separate
	// accumulator (no shared URLs with Rakuten/Brave items).
	const passC = await fetchTvChannelFromBroadcasts(plan);

	return [...urlIndexed.values(), ...passC];
}
```

Note: `TV_CHANNELS` is imported at the top of the file (from Task 5 Step 3). Ensure that import is present.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Re-run the pool tests to ensure no regression**

```bash
npm run test:pool-tv-channel
```

Expected: `PASS: pool tv_channel helpers`

- [ ] **Step 4: Commit**

```bash
git add lib/discovery/pool.ts
git commit -m "feat(discovery): integrate Pass C and Pass D into buildPool with channel-aware dedup"
```

---

## Task 8: Curate.ts derives `tvChannelSource` (TDD)

**Files:**
- Modify: `lib/discovery/curate.ts`
- Create: `scripts/test-tv-channel-mapping.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-tv-channel-mapping.ts`:

```ts
import assert from "node:assert/strict";
import { __test } from "@/lib/discovery/curate";
import type { PoolItem } from "@/lib/discovery/types";

const poolItem: PoolItem = {
	name: "X",
	productUrl: "https://example.com/x",
	source: "tv_channel",
	seedKeyword: "kw",
	track: "tv_proven",
	tvChannel: "shopch",
	tvChannelMatches: ["shopch", "qvc"],
};

const candidate = __test.poolItemToCandidate(poolItem, {
	tvFitScore: 88,
	tvFitReason: "test",
	isTvApplicable: true,
	isLiveApplicable: false,
	scoreBreakdown: {
		review_signal: 20,
		tv_category_match: 20,
		trend_signal: 15,
		price_fit: 15,
		purchase_signal: 18,
		total: 88,
	},
	context: "home_shopping",
});

assert.equal(candidate.tvChannelSource, "qvc,shopch");
assert.equal(candidate.tvChannel, "shopch");
assert.deepEqual(candidate.tvChannelMatches, ["shopch", "qvc"]);

const noChannel: PoolItem = {
	name: "Y",
	productUrl: "https://example.com/y",
	source: "rakuten",
	seedKeyword: "kw",
	track: "tv_proven",
};
const candidate2 = __test.poolItemToCandidate(noChannel, {
	tvFitScore: 50,
	tvFitReason: "test",
	isTvApplicable: true,
	isLiveApplicable: false,
	scoreBreakdown: {
		review_signal: 10,
		tv_category_match: 10,
		trend_signal: 10,
		price_fit: 10,
		purchase_signal: 10,
		total: 50,
	},
	context: "home_shopping",
});
assert.equal(candidate2.tvChannelSource, null);

console.log("PASS: curate poolItemToCandidate sets tvChannelSource");
```

Add to `package.json`:

```json
"test:tv-channel-mapping": "tsx --env-file=.env.local scripts/test-tv-channel-mapping.ts",
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm run test:tv-channel-mapping
```

Expected: FAIL with "__test.poolItemToCandidate is not a function" or "tvChannelSource is undefined".

- [ ] **Step 3: Extract the PoolItem→Candidate mapping into a tested helper**

In `lib/discovery/curate.ts`:

Add to imports at the top:

```ts
import { deriveTvChannelSource } from "./tv-channels";
```

Add the helper near the bottom (before `export const __test` if it exists, or before the end of file otherwise). Insert this BEFORE the existing `const candidates: Candidate[] = [];` loop:

```ts
interface CurationFields {
	tvFitScore: number;
	tvFitReason: string;
	isTvApplicable: boolean;
	isLiveApplicable: boolean;
	scoreBreakdown: CurationScore;
	context: Context;
}

function poolItemToCandidate(
	source: PoolItem,
	fields: CurationFields,
): Candidate {
	return {
		...source,
		context: fields.context,
		tvFitScore: Math.max(0, Math.min(100, fields.tvFitScore)),
		tvFitReason: fields.tvFitReason,
		isTvApplicable: fields.isTvApplicable,
		isLiveApplicable: fields.isLiveApplicable,
		scoreBreakdown: fields.scoreBreakdown,
		tvChannelSource: deriveTvChannelSource(source),
	};
}
```

Replace the existing candidate-construction loop (currently inside `curatePool`, around lines 184–196) with:

```ts
	const candidates: Candidate[] = [];
	for (const c of items) {
		const source = sampled[c.index];
		if (!source) continue;
		candidates.push(
			poolItemToCandidate(source, {
				tvFitScore: c.tv_fit_score,
				tvFitReason: c.tv_fit_reason,
				isTvApplicable: c.is_tv_applicable,
				isLiveApplicable: c.is_live_applicable,
				scoreBreakdown: c.score_breakdown,
				context,
			}),
		);
	}
```

Add at the bottom of the file:

```ts
export const __test = {
	poolItemToCandidate,
};
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm run test:tv-channel-mapping
```

Expected: `PASS: curate poolItemToCandidate sets tvChannelSource`

- [ ] **Step 5: Commit**

```bash
git add lib/discovery/curate.ts scripts/test-tv-channel-mapping.ts package.json
git commit -m "feat(discovery): curate maps PoolItem.tvChannel* to Candidate.tvChannelSource"
```

---

## Task 9: Orchestrator partition (TDD)

**Files:**
- Modify: `lib/discovery/orchestrator.ts`
- Create: `scripts/test-discovery-partition.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-discovery-partition.ts`:

```ts
import assert from "node:assert/strict";
import { __test } from "@/lib/discovery/orchestrator";
import type { Candidate } from "@/lib/discovery/types";

function mkCandidate(score: number, tvSrc: string | null): Candidate {
	return {
		name: `c${score}`,
		productUrl: `https://x/${score}`,
		source: tvSrc ? "tv_channel" : "rakuten",
		seedKeyword: "k",
		track: "tv_proven",
		context: "home_shopping",
		tvFitScore: score,
		tvFitReason: "r",
		isTvApplicable: true,
		isLiveApplicable: false,
		scoreBreakdown: {
			review_signal: 0,
			tv_category_match: 0,
			trend_signal: 0,
			price_fit: 0,
			purchase_signal: 0,
			total: score,
		},
		tvChannelSource: tvSrc,
	};
}

// Mixed input: tier-1 (with tvChannelSource) must come first regardless of score.
const input: Candidate[] = [
	mkCandidate(95, null),    // tier-2, highest score
	mkCandidate(40, "shopch"),// tier-1, low score
	mkCandidate(70, null),    // tier-2
	mkCandidate(60, "qvc"),   // tier-1
];

const out = __test.partitionByTier(input);

// Order: all tier-1 first (score-DESC), then all tier-2 (score-DESC).
assert.deepEqual(
	out.map((c) => c.name),
	["c60", "c40", "c95", "c70"],
);

console.log("PASS: partitionByTier orders TV channel candidates first, score-DESC within tier");
```

Add to `package.json`:

```json
"test:discovery-partition": "tsx --env-file=.env.local scripts/test-discovery-partition.ts",
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm run test:discovery-partition
```

Expected: FAIL — `__test.partitionByTier is not a function`.

- [ ] **Step 3: Implement the partition helper and wire it into `runStage1`**

In `lib/discovery/orchestrator.ts`:

Add at the bottom of the file, BEFORE the closing of `runStage1`'s return:

```ts
/**
 * Partition candidates into tier-1 (TV channel hit) and tier-2 (everything else),
 * sort each tier by tvFitScore DESC, then concatenate.
 * This is the single enforcement point for the "TV channel first" requirement.
 */
function partitionByTier(candidates: Candidate[]): Candidate[] {
	const tier1 = candidates.filter((c) => c.tvChannelSource);
	const tier2 = candidates.filter((c) => !c.tvChannelSource);
	tier1.sort((a, b) => b.tvFitScore - a.tvFitScore);
	tier2.sort((a, b) => b.tvFitScore - a.tvFitScore);
	return [...tier1, ...tier2];
}

export const __test = {
	partitionByTier,
};
```

Then modify the existing `runStage1` return — currently at the end:

```ts
	// Step 4: apply realtime hot-set boost and re-sort. Done after iteration so
	// late-added candidates are eligible too.
	applyRakutenHotBoost(candidates, hotCodes);

	return {
		candidates,
		plan,
		poolSize: pool.length,
		iterations,
	};
```

Change to:

```ts
	// Step 4: apply realtime hot-set boost and re-sort. Done after iteration so
	// late-added candidates are eligible too.
	applyRakutenHotBoost(candidates, hotCodes);

	// Step 5: partition into TV-channel tier and other tier, then concatenate.
	// This is the strict enforcement of the "TV channel first" ordering.
	const partitioned = partitionByTier(candidates);

	return {
		candidates: partitioned,
		plan,
		poolSize: pool.length,
		iterations,
	};
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm run test:discovery-partition
```

Expected: `PASS: partitionByTier orders TV channel candidates first, score-DESC within tier`

- [ ] **Step 5: Commit**

```bash
git add lib/discovery/orchestrator.ts scripts/test-discovery-partition.ts package.json
git commit -m "feat(discovery): partition candidates into TV-channel tier first"
```

---

## Task 10: Persist `tv_channel_source`

**Files:**
- Modify: `lib/discovery/save.ts`

- [ ] **Step 1: Add `tv_channel_source` to `DiscoveredProductRow` and the row builder**

In `lib/discovery/save.ts`, modify the `DiscoveredProductRow` interface (currently lines 76–99) — add a new line just before `context`:

```ts
	tv_channel_source: string | null;
	context: Candidate["context"];
```

Modify `buildDiscoveredProductRows` (currently lines 101–129) — add the field in the returned object (in the same alphabetical neighborhood as `track`):

```ts
		track: candidate.track,
		tv_channel_source: candidate.tvChannelSource ?? null,
		is_tv_applicable: candidate.isTvApplicable,
```

- [ ] **Step 2: Extend the existing `scripts/test-discovery-row-mapping.ts` to cover the new field**

Open `scripts/test-discovery-row-mapping.ts`. Add a `tvChannelSource: "qvc,shopch"` field to the test `Candidate` object after `track: "tv_proven",`:

```ts
	track: "tv_proven",
	tvChannelSource: "qvc,shopch",
	context: "home_shopping",
```

Add an assertion after the existing ones:

```ts
assert.equal(rows[0].tv_channel_source, "qvc,shopch");
```

- [ ] **Step 3: Run the existing test to verify it passes**

```bash
npm run test:discovery-row-mapping
```

Expected: `PASS: discovery row mapping keeps category and seed_keyword separate` (and the new assertion does not throw).

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add lib/discovery/save.ts scripts/test-discovery-row-mapping.ts
git commit -m "feat(discovery): persist tv_channel_source on discovered_products"
```

---

## Task 11: API reads with tier-aware ordering

**Files:**
- Modify: `app/api/discovery/today/route.ts`

- [ ] **Step 1: Change the order clause**

Open `app/api/discovery/today/route.ts`. Replace lines 35–39 (the products query construction):

```ts
	let q = sb
		.from("discovered_products")
		.select("*")
		.eq("session_id", session.id)
		.order("tv_fit_score", { ascending: false });
```

with:

```ts
	let q = sb
		.from("discovered_products")
		.select("*")
		.eq("session_id", session.id)
		.order("tv_tier", { ascending: true })
		.order("tv_fit_score", { ascending: false });
```

- [ ] **Step 2: Verify the route TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Smoke-test the endpoint against the dev DB**

```bash
npm run dev
# in another shell:
curl -s "http://localhost:3000/api/discovery/today?context=home_shopping" | jq '.products | map({name, tv_channel_source, tv_fit_score}) | .[:10]'
```

Expected: any rows with non-null `tv_channel_source` appear before rows with `null`, and within each group, `tv_fit_score` descends. (If no tier-1 rows exist yet, the next discovery run will produce them — that's fine.)

- [ ] **Step 4: Commit**

```bash
git add app/api/discovery/today/route.ts
git commit -m "feat(discovery): API orders products by tv_tier then tv_fit_score"
```

---

## Task 12: UI — extend `DiscoveredProductRow` type and add channel badges

**Files:**
- Modify: `components/discovery/ProductCard.tsx`

- [ ] **Step 1: Extend the `DiscoveredProductRow` type**

In `components/discovery/ProductCard.tsx`, modify the type at lines 14–36 — change the `source` line and add `tv_channel_source`:

```ts
	source: "rakuten" | "brave" | "tv_channel" | "other" | null;
	tv_channel_source?: string | null;
	enrichment_status?: EnrichmentStatus | null;
```

Also update the source-badge logic at lines 122–131 to handle `"tv_channel"`. Replace those lines:

```tsx
				<span
					className={`text-[10px] px-2 py-0.5 rounded-full font-bold shrink-0 ${
						product.source === "rakuten"
							? "bg-red-100 text-red-700"
							: product.source === "tv_channel"
							? "bg-purple-100 text-purple-700"
							: "bg-blue-100 text-blue-700"
					}`}
				>
					{product.source === "rakuten"
						? "楽天"
						: product.source === "tv_channel"
						? "TV"
						: "Web"}
				</span>
```

- [ ] **Step 2: Add a channel-badge row below the source badge**

In the same file, modify the imports at the top to add the channel registry lookup:

```ts
import { getChannelBySlug, parseChannelSlugs } from "@/lib/discovery/tv-channels";
```

Add a derivation just inside the `ProductCard` function, after the existing `const isTV = product.track === "tv_proven";` line:

```ts
	const channelSlugs = parseChannelSlugs(product.tv_channel_source ?? null);
```

Insert a new badge row inside the metadata column. Locate the existing flex-wrap badge row at lines 174–193 (the `{broadcastBadge}` row). Just BEFORE the closing `</div>` of that flex-wrap container, add:

```tsx
							{channelSlugs.map((slug) => {
								const ch = getChannelBySlug(slug);
								return (
									<span
										key={slug}
										className="inline-flex items-center text-[10px] px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200 font-semibold"
										title={ch?.name ?? slug}
									>
										{ch?.name ?? slug}
									</span>
								);
							})}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add components/discovery/ProductCard.tsx
git commit -m "feat(discovery): ProductCard renders TV channel badges"
```

---

## Task 13: UI — split discovery home into two sections

**Files:**
- Modify: `app/[locale]/analytics/discovery/home/page.tsx`
- Modify: `messages/en.json`, `messages/ja.json`

- [ ] **Step 1: Add i18n keys**

In `messages/ja.json`, find the `"discovery"` block and add two keys (preserve existing keys; alphabetical order is not required since the file is hand-edited):

```json
"tvChannelSectionTitle": "📺 TV通販チャネル掲載中",
"otherSectionTitle": "その他の候補",
```

In `messages/en.json`, add the equivalent English strings under the same `"discovery"` block:

```json
"tvChannelSectionTitle": "📺 On TV shopping channels",
"otherSectionTitle": "Other candidates",
```

- [ ] **Step 2: Partition the rendered list into two sections**

In `app/[locale]/analytics/discovery/home/page.tsx`, locate the `filtered` rendering block (currently lines 83–92):

```tsx
						<div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-2">
							{filtered.map((p) => (
								<ProductCard key={p.id} product={p} />
							))}
							{filtered.length === 0 && (
								<div className="col-span-full py-12 text-center text-sm text-gray-400">
									(no products match the current filter)
								</div>
							)}
						</div>
```

Replace with:

```tsx
						{(() => {
							const tier1 = filtered.filter(
								(p) => (p as { tv_channel_source?: string | null }).tv_channel_source,
							);
							const tier2 = filtered.filter(
								(p) => !(p as { tv_channel_source?: string | null }).tv_channel_source,
							);
							return (
								<>
									{tier1.length > 0 && (
										<section className="mt-4">
											<h3 className="text-sm font-semibold text-gray-800 mb-2">
												{t("tvChannelSectionTitle")} ({tier1.length})
											</h3>
											<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
												{tier1.map((p) => (
													<ProductCard key={p.id} product={p} />
												))}
											</div>
										</section>
									)}
									{tier2.length > 0 && (
										<section className="mt-6">
											<h3 className="text-sm font-semibold text-gray-800 mb-2">
												{t("otherSectionTitle")} ({tier2.length})
											</h3>
											<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
												{tier2.map((p) => (
													<ProductCard key={p.id} product={p} />
												))}
											</div>
										</section>
									)}
									{filtered.length === 0 && (
										<div className="py-12 text-center text-sm text-gray-400">
											(no products match the current filter)
										</div>
									)}
								</>
							);
						})()}
```

- [ ] **Step 3: Update the `filtered` sort to preserve tier order**

Currently, when the user picks `sort === "score"` or `sort === "price"`, the sort would mix tiers. Locate the `filtered` useMemo (currently lines 47–55) and replace:

```ts
	const filtered = useMemo(() => {
		let list = products;
		if (status === "uncategorized") list = list.filter((p) => !(p as unknown as { user_action?: string }).user_action);
		else if (status !== "all")
			list = list.filter((p) => (p as unknown as { user_action?: string }).user_action === status);
		if (sort === "score") list = [...list].sort((a, b) => (b.tv_fit_score ?? 0) - (a.tv_fit_score ?? 0));
		else if (sort === "price") list = [...list].sort((a, b) => (b.price_jpy ?? 0) - (a.price_jpy ?? 0));
		return list;
	}, [products, status, sort]);
```

with:

```ts
	const filtered = useMemo(() => {
		let list = products;
		if (status === "uncategorized") list = list.filter((p) => !(p as unknown as { user_action?: string }).user_action);
		else if (status !== "all")
			list = list.filter((p) => (p as unknown as { user_action?: string }).user_action === status);

		// Sort tier-first, then by user-chosen criterion inside each tier.
		const tierOf = (p: DiscoveredProductRow) =>
			(p as unknown as { tv_channel_source?: string | null }).tv_channel_source
				? 0
				: 1;
		const sortFn = (a: DiscoveredProductRow, b: DiscoveredProductRow) => {
			const ta = tierOf(a);
			const tb = tierOf(b);
			if (ta !== tb) return ta - tb;
			if (sort === "price") return (b.price_jpy ?? 0) - (a.price_jpy ?? 0);
			// score is the default
			return (b.tv_fit_score ?? 0) - (a.tv_fit_score ?? 0);
		};
		list = [...list].sort(sortFn);
		return list;
	}, [products, status, sort]);
```

- [ ] **Step 4: Smoke test in browser**

```bash
npm run dev
```

Open `http://localhost:3000/ja/analytics/discovery/home`. Confirm:
- Two sections render with their headings and counts.
- TV channel badges show on tier-1 cards.
- Sort/filter controls do not move tier-2 cards above tier-1 cards.
- If no tier-1 data exists yet (no broadcast matches), only the "その他の候補" section renders. This is expected on a fresh DB.

- [ ] **Step 5: Commit**

```bash
git add app/[locale]/analytics/discovery/home/page.tsx messages/en.json messages/ja.json
git commit -m "feat(discovery): split discovery home into TV channel and other sections"
```

---

## Task 14: Verify-discovery-run script reports tier ratio

**Files:**
- Modify: `scripts/verify-discovery-run.ts`

- [ ] **Step 1: Add `tv_channel_source` to the SELECT and report tier ratio**

In `scripts/verify-discovery-run.ts`:

Extend the `DiscoveredRow` interface (currently lines 13–28) — add a new line before `is_tv_applicable`:

```ts
	tv_channel_source: string | null;
	is_tv_applicable: boolean;
```

Extend the `.select(...)` call (currently lines 76–77) by appending `tv_channel_source`:

```ts
		.select(
			"name, price_jpy, category, seed_keyword, tv_fit_score, tv_fit_reason, broadcast_tag, track, review_count, review_avg, rakuten_item_code, seller_name, is_tv_applicable, is_live_applicable, tv_channel_source",
		)
```

In the distributions section (after the existing counters at lines 87–93), add:

```ts
	let tvTier = 0;
	const channelHits = new Map<string, number>();
```

In the row loop (lines 95–121), add after the existing per-row aggregation (after `if (r.tv_fit_reason.includes("楽天リアルタイムランキング上位")) hotSetBoosts++;`):

```ts
		if (r.tv_channel_source) {
			tvTier++;
			for (const slug of r.tv_channel_source.split(",")) {
				channelHits.set(slug, (channelHits.get(slug) ?? 0) + 1);
			}
		}
```

In the distributions output block (after the existing `console.log` for boost annotations, line 138), add:

```ts
	console.log(
		`   tv-tier: ${tvTier}/${rows.length}  channels: ${[...channelHits.entries()].map(([k, v]) => `${k}=${v}`).join(" ") || "(none)"}`,
	);
```

- [ ] **Step 2: Run the verify script against the dev DB**

```bash
npm run verify:broadcasts  # just sanity check the script still works
npx tsx --env-file=.env.local scripts/verify-discovery-run.ts
```

Expected: output now contains a `tv-tier: <n>/<total>  channels: <slug>=<count> ...` line under the Distributions section.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-discovery-run.ts
git commit -m "chore(discovery): report tv-tier ratio in verify-discovery-run"
```

---

## Task 15: Document the feature in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a Discovery TV Channel section**

In `CLAUDE.md`, find the `### Broadcast Calendar (Phase A — read-only)` section (around line 51). Immediately AFTER its bullet list, before the `### Supabase Schema (key tables)` heading, insert:

```markdown
### Discovery TV Channel Source (extends home_shopping)

- Discovery pipeline tags candidates from 12 Japanese TV-shopping channels as a tier-1 priority signal so they appear above other candidates on `/[locale]/analytics/discovery/home`.
- Sources: existing `broadcasts` table for shopch + qvc (Phase A); Brave `site:` search for the other 10 channels listed in `docs/検索参考サイト (2).xlsx`.
- Persistence: `discovered_products.tv_channel_source` (comma-joined alphabetical slugs, nullable) + `tv_tier int` generated column (0=TV, 1=other) for sorting.
- Ordering: `runStage1` in `lib/discovery/orchestrator.ts` partitions candidates after scoring; API and UI both sort by `(tv_tier ASC, tv_fit_score DESC)`.
- Env knobs: `TV_CHANNEL_BRAVE_BUDGET` (default 50) caps daily Brave site:-search calls; `TV_CHANNEL_BROADCAST_WINDOW_DAYS` (default 30) sets the broadcasts lookback.
- Channel registry: `lib/discovery/tv-channels.ts` lists all 12 with slug/name/siteQuery/scraped flags. Only `scraped: true` channels (shopch, qvc) read from `broadcasts`; the rest go through Brave site: search.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document discovery TV channel source"
```

---

## Self-Review

**Spec coverage check** — every section in `2026-05-12-tv-channel-recommend-sources-design.md` maps to at least one task:

| Spec section | Tasks |
|---|---|
| §1 Schema changes | Task 1 |
| §2 Channel registry | Task 2 |
| §3 Type extensions | Task 3 |
| §4 Pool builder (Pass C) | Task 5 |
| §4 Pool builder (Pass D) | Task 6 |
| §4 Pool merge / dedup | Task 7 |
| §5 Curate passthrough | Task 8 |
| §6 Orchestrator partition | Task 9 |
| §7 Persistence | Task 10 |
| §8 Read API | Task 11 |
| §9 UI (ProductCard) | Task 12 |
| §9 UI (page sections, i18n) | Task 13 |
| §10 Configuration (env vars) | Tasks 5, 6 (env reads) + Task 15 (doc) |
| §11 Error handling | Tasks 5, 6 (`fail-open` catches) |
| §12 Verification (regression test) | Task 8 (mapping) + Task 9 (partition) + Task 5 (helpers) |
| §12 Verification (verify script line) | Task 14 |

**Cross-task type consistency check:**
- `deriveTvChannelSource` (Task 4) is consumed by `poolItemToCandidate` (Task 8). ✓
- `partitionByTier` (Task 9) reads `Candidate.tvChannelSource` (Task 3). ✓
- `DiscoveredProductRow` (Task 10) writes `tv_channel_source` matching the DB column added in Task 1. ✓
- API order (Task 11) reads `tv_tier` from the generated column (Task 1). ✓
- UI partition (Task 13) reads `tv_channel_source` populated by Task 10. ✓

**No placeholder scan:** Each step contains the exact code or command to run. No "TBD", "implement later", or "similar to Task N" references.

---

## Out of scope (deferred to future plans)

- Cheerio scrapers for the 10 non-scraped channels (Broadcast Calendar Phase B-ish work).
- Per-channel weighting / user "primary channel" preference.
- Applying the partition to `/analytics/discovery/live` (live_commerce context).
- Name-based fuzzy dedup between broadcasts items and Rakuten items (currently accepted as a known limitation, see spec §11).
- Wiring up the dormant `/api/recommend` endpoint or the unused `recommend.*` i18n keys.
