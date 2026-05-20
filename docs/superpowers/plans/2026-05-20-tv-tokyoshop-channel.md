# TV Tokyo Shop (テレ東マート) Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tv-tokyoshop.jp as a new OA channel (`txd`) so its daily broadcasts surface on the existing `/[locale]/broadcasts` calendar and its products feed the discovery pool via Brave site:-search, matching the treatment of the other 7 OA channels.

**Architecture:** New JSON-fetching parser in `lib/historical-crawl/parsers/txd.ts` against the discovered `https://api.tv-tokyoshop.jp/api/v1/product/SearchWithBroadcastDate` endpoint. Existing daily cron (`/api/cron/daily-historical-broadcasts`) picks up the new parser automatically via `ALL_PARSERS`. Calendar UI, historical search panel, and admin observability dashboard already iterate over channel registries, so adding the slug there flips everything on. One small extension to `politeFetch` (optional headers param) is needed because the API requires `X-User-Key: ers_v8`.

**Tech Stack:** TypeScript, Next.js 16 (App Router), Supabase (Postgres + service client), existing `politeFetch`/`cheerio` based crawler infrastructure (we skip cheerio — JSON only), bespoke fixture-based parser test scripts.

**Spec:** `docs/superpowers/specs/2026-05-20-tv-tokyoshop-channel-design.md`

---

## Pre-flight: Working directory

All file paths in this plan are relative to the worktree root:
`E:\Github\mediaworks\.claude\worktrees\research-cross-system-integration\`

Do **not** `cd` to the original repo root.

---

## Task 1: Extend `politeFetch` to accept optional headers

**Goal:** Make `politeFetch` able to override its `Accept` header and add `X-User-Key` so the JSON-API parser can use the shared timeout/retry logic.

**Files:**
- Modify: `lib/historical-crawl/fetch.ts`

- [ ] **Step 1: Read the current fetch.ts**

Read `lib/historical-crawl/fetch.ts` to confirm its structure (already known shape):
- Exports `politeFetch(url, opts)` where opts is `{ timeoutMs?, retry? }`.
- Hardcodes `Accept: text/html,application/xhtml+xml` and `Accept-Language: ja,en;q=0.8` plus `User-Agent` from `USER_AGENT`.
- Decodes Shift-JIS automatically based on Content-Type or meta tag.

- [ ] **Step 2: Extend the opts type and merge headers**

Edit `lib/historical-crawl/fetch.ts`. Change the `politeFetch` signature and the `fetch()` headers construction so that callers can pass an optional `headers` map that merges over the defaults.

Replace the function:

```typescript
export async function politeFetch(
	url: string,
	opts: {
		timeoutMs?: number;
		retry?: boolean;
		headers?: Record<string, string>;
	} = {},
): Promise<FetchResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const retry = opts.retry ?? true;

	const attempt = async (): Promise<FetchResult> => {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await fetch(url, {
				headers: {
					"User-Agent": USER_AGENT,
					Accept: "text/html,application/xhtml+xml",
					"Accept-Language": "ja,en;q=0.8",
					...(opts.headers ?? {}),
				},
				signal: ctrl.signal,
				redirect: "follow",
			});
			clearTimeout(timer);
			if (!res.ok) {
				return { ok: false, status: res.status, finalUrl: res.url, error: "HTTP " + res.status };
			}
			const buf = await res.arrayBuffer();
			const body = decodeBytes(buf, res.headers.get("content-type"));
			return { ok: true, status: res.status, body, finalUrl: res.url };
		} catch (e) {
			clearTimeout(timer);
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	};

	const first = await attempt();
	if (first.ok || (first.status && first.status >= 400 && first.status < 500)) {
		return first;
	}
	if (!retry) return first;
	return attempt();
}
```

Key behaviors:
- When `opts.headers` is absent, behavior is identical to before (the 7 existing parsers stay green).
- When provided, caller-supplied entries override the defaults (so `Accept` can be set to `application/json`).
- `User-Agent` is overridable too — but the txd parser will not override it; we want the standard `MediaWorks-Historical-Crawl/1.0` UA to keep our crawl polite and identifiable.

- [ ] **Step 3: Type-check the change**

Run: `npx tsc --noEmit`
Expected: no new errors introduced. (Pre-existing errors in unrelated files, if any, may persist.)

- [ ] **Step 4: Commit**

```bash
git add lib/historical-crawl/fetch.ts
git commit -m "feat(historical-crawl): allow politeFetch callers to pass custom headers"
```

---

## Task 2: Record a JSON fixture from the live API

**Goal:** Save a real response from the upstream API as a fixture so the parser test is deterministic and reproducible.

**Files:**
- Create: `scripts/fixtures/historical-crawl/txd-2026-05-19.json`

- [ ] **Step 1: Ensure fixtures directory exists**

Run: `mkdir -p scripts/fixtures/historical-crawl`
Expected: directory created (or already present, no error).

- [ ] **Step 2: Fetch and save a known-good response**

Run:

```bash
curl -sL \
  -A "MediaWorks-Historical-Crawl/1.0 (+contact@mediaw-b.com)" \
  -H "X-User-Key: ers_v8" \
  -H "Accept: application/json, text/plain, */*" \
  "https://api.tv-tokyoshop.jp/api/v1/product/SearchWithBroadcastDate?BroadcastDate=2026/05/19&PageOffset=1&PageDispLimit=50&ProductSearchSort=1&device_pc_flg=1&device_sp_flg=0&device_ap_flg=0" \
  -o scripts/fixtures/historical-crawl/txd-2026-05-19.json \
  -w "status=%{http_code} size=%{size_download}\n"
```

Expected: `status=200 size=<>67000` (the live response is ~67 KB; 2026-05-19 had 15 products).

- [ ] **Step 3: Spot-check the fixture**

Run: `node -e "const d=require('./scripts/fixtures/historical-crawl/txd-2026-05-19.json'); console.log({RSuccess:d.RSuccess,RCount:d.RCount,count:d.Product?.length,first:d.Product?.[0]?.Gname})"`

Expected output similar to:

```
{ RSuccess: true, RCount: 15, count: 15, first: '【2枚組】ARIKI 軽やかパンツ' }
```

If `RSuccess` is `false` or `count` is `0`, choose a different date with broadcasts (use `BroadcastDateForCalendar` from any successful response to pick a populated day) and re-fetch.

- [ ] **Step 4: Commit**

```bash
git add scripts/fixtures/historical-crawl/txd-2026-05-19.json
git commit -m "test(historical-crawl): add tv-tokyoshop API response fixture"
```

---

## Task 3: Add `txd` to type unions and channel registries

**Goal:** Three parallel one-line additions across the three registries that drive the historical crawl, the calendar UI, and the discovery pool.

**Files:**
- Modify: `lib/historical-crawl/types.ts`
- Modify: `lib/broadcasts/channel-style.ts`
- Modify: `lib/discovery/tv-channels.ts`

- [ ] **Step 1: Add `txd` to the historical-crawl slug union**

Edit `lib/historical-crawl/types.ts`. Change the `OAChannelSlug` export from:

```typescript
export type OAChannelSlug =
	| "japanet"
	| "junsanpo"
	| "ntv"
	| "tbs"
	| "dinos"
	| "senobura"
	| "uranoura";
```

to:

```typescript
export type OAChannelSlug =
	| "japanet"
	| "junsanpo"
	| "ntv"
	| "tbs"
	| "dinos"
	| "senobura"
	| "uranoura"
	| "txd";
```

- [ ] **Step 2: Add `txd` to the broadcasts channel-style registry**

Edit `lib/broadcasts/channel-style.ts`. Three edits in the same file:

a) Extend the `BroadcastChannelSlug` union by appending `| "txd"` after `| "uranoura"`.

b) Append a new entry to `OA_CHANNELS`:

```typescript
export const OA_CHANNELS: { slug: BroadcastChannelSlug; name: string }[] = [
	{ slug: "japanet", name: "ジャパネット" },
	{ slug: "junsanpo", name: "テレ朝じゅん散歩" },
	{ slug: "ntv", name: "日テレポシュレ" },
	{ slug: "tbs", name: "TBSキニナル" },
	{ slug: "dinos", name: "フジDinos" },
	{ slug: "senobura", name: "ABCせのぶら" },
	{ slug: "uranoura", name: "ABCウラのウラまで" },
	{ slug: "txd", name: "テレ東マート" },
];
```

c) Add a badge entry to `CHANNEL_BADGE`:

```typescript
export const CHANNEL_BADGE: Record<BroadcastChannelSlug, string> = {
	qvc: "bg-purple-100 text-purple-800 border-purple-200",
	shopch: "bg-red-100 text-red-800 border-red-200",
	japanet: "bg-red-100 text-red-800 border-red-200",
	junsanpo: "bg-cyan-100 text-cyan-800 border-cyan-200",
	ntv: "bg-amber-100 text-amber-800 border-amber-200",
	tbs: "bg-sky-100 text-sky-800 border-sky-200",
	dinos: "bg-rose-100 text-rose-800 border-rose-200",
	senobura: "bg-indigo-100 text-indigo-800 border-indigo-200",
	uranoura: "bg-purple-100 text-purple-800 border-purple-200",
	txd: "bg-emerald-100 text-emerald-800 border-emerald-200",
};
```

- [ ] **Step 3: Add `txd` to the discovery TV-channel registry**

Edit `lib/discovery/tv-channels.ts`. Append one entry to `TV_CHANNELS` (after `uranoura`):

```typescript
	{ slug: "uranoura",  name: "ABCウラのウラまで",      siteQuery: "shop.asahi.co.jp/category/URANADJA",  scraped: false },
	{ slug: "txd",       name: "テレ東マート",           siteQuery: "tv-tokyoshop.jp",                     scraped: false },
];
```

Rationale: `scraped: false` is correct because the flag means "sourced from the `broadcasts` table (qvc/shopch only)." txd lands in `historical_broadcasts`, so it stays in the Brave site:-search pool (Pass D) for discovery, matching the other 7 OA channels.

- [ ] **Step 4: Type-check across the three changes**

Run: `npx tsc --noEmit`
Expected: no new errors. If any new error appears, it should be in a file that exhaustively matches over `OAChannelSlug` or `BroadcastChannelSlug` — those are real consumers and must be updated, so jump to Task 6 (UI/code audit) first if that happens.

- [ ] **Step 5: Commit**

```bash
git add lib/historical-crawl/types.ts lib/broadcasts/channel-style.ts lib/discovery/tv-channels.ts
git commit -m "feat(broadcasts): register tv-tokyoshop (txd) in channel registries"
```

---

## Task 4: Create the `txd` parser

**Goal:** Implement `parseTxdResponse` (pure function, fixture-testable) and `txdParser` (live `fetchToday`), then verify against the recorded fixture.

**Files:**
- Create: `lib/historical-crawl/parsers/txd.ts`

- [ ] **Step 1: Create the parser file**

Create `lib/historical-crawl/parsers/txd.ts` with:

```typescript
import type { ChannelParser, HistoricalRow } from "../types";
import { dayOfWeekJp } from "../types";
import { politeFetch } from "../fetch";

const API_URL =
	"https://api.tv-tokyoshop.jp/api/v1/product/SearchWithBroadcastDate";
const X_USER_KEY = "ers_v8";
const PAGE_LIMIT = 50;
const MAX_PAGES = 5; // hard cap: 5 pages × 50 = 250 products/day. Defensive.

interface TxdProduct {
	ID: number;
	Gcode: string;
	Gname: string;
	MinPrice: number;
	MaxPrice: number;
	PictureCollection?: { Count: number; URL: string[] } | null;
	IconFlgList?: number[];
	Icon2OffValue?: string;
	SoldoutFlg?: unknown;
	ProgramBroadcastDate?: string | null;
}

export interface TxdApiResponse {
	RSuccess: boolean;
	RMessage?: string;
	RCount?: number;
	Product?: TxdProduct[];
	Pager?: { MaxPage?: number; PageOffset?: number; FromCnt?: number; ToCnt?: number };
}

/**
 * Convert a single API product into a HistoricalRow.
 * Pure function — no I/O. The fixture-based test exercises this directly.
 */
export function txdProductToRow(p: TxdProduct, jstDate: string): HistoricalRow {
	const detailUrl = `https://www.tv-tokyoshop.jp/detail?Gcode=${encodeURIComponent(p.Gcode)}`;
	const min = Number.isFinite(p.MinPrice) ? Math.round(p.MinPrice) : null;
	const max = Number.isFinite(p.MaxPrice) ? Math.round(p.MaxPrice) : null;
	let priceText: string | null = null;
	if (min !== null && max !== null) {
		priceText = min === max ? `¥${min.toLocaleString("ja-JP")}` : `¥${min.toLocaleString("ja-JP")}〜¥${max.toLocaleString("ja-JP")}`;
	}

	return {
		channel: "txd",
		air_date: jstDate,
		day_of_week: dayOfWeekJp(jstDate),
		start_time: null,
		product_name: (p.Gname ?? "").slice(0, 500),
		price_text: priceText ? priceText.slice(0, 200) : null,
		price_jpy: min,
		// Japanese retail prices are displayed tax-inclusive by default
		// (景品表示法 / 総額表示義務, effective 2021). Detail page confirms.
		price_is_tax_incl: min !== null ? true : null,
		source_url: detailUrl,
		source_sheet: "live-crawl:txd",
	};
}

/**
 * Parse a single API page response into HistoricalRows. Pure function.
 * Skips products with empty/short names defensively.
 */
export function parseTxdResponse(
	response: TxdApiResponse,
	jstDate: string,
): HistoricalRow[] {
	if (!response.RSuccess) return [];
	const products = response.Product ?? [];
	const rows: HistoricalRow[] = [];
	for (const p of products) {
		if (!p?.Gname || p.Gname.trim().length < 3) continue;
		rows.push(txdProductToRow(p, jstDate));
	}
	return rows;
}

function buildUrl(jstDate: string, pageOffset: number): string {
	const broadcastDate = jstDate.replaceAll("-", "/"); // YYYY-MM-DD → YYYY/MM/DD
	const qs = new URLSearchParams({
		BroadcastDate: broadcastDate,
		PageOffset: String(pageOffset),
		PageDispLimit: String(PAGE_LIMIT),
		ProductSearchSort: "1",
		device_pc_flg: "1",
		device_sp_flg: "0",
		device_ap_flg: "0",
	});
	return `${API_URL}?${qs.toString()}`;
}

async function fetchPage(jstDate: string, pageOffset: number): Promise<TxdApiResponse | null> {
	const r = await politeFetch(buildUrl(jstDate, pageOffset), {
		headers: {
			Accept: "application/json, text/plain, */*",
			"X-User-Key": X_USER_KEY,
		},
	});
	if (!r.ok || !r.body) return null;
	try {
		return JSON.parse(r.body) as TxdApiResponse;
	} catch {
		return null;
	}
}

export const txdParser: ChannelParser = {
	slug: "txd",
	name: "テレ東マート",
	fetchToday: async (jstDate) => {
		const first = await fetchPage(jstDate, 1);
		if (!first || !first.RSuccess) return [];
		const rows = parseTxdResponse(first, jstDate);
		const totalCount = first.RCount ?? rows.length;
		// Paginate only if first page didn't already cover everything.
		for (let page = 2; page <= MAX_PAGES && rows.length < totalCount; page++) {
			const next = await fetchPage(jstDate, page);
			if (!next || !next.RSuccess) break;
			const more = parseTxdResponse(next, jstDate);
			if (more.length === 0) break;
			rows.push(...more);
		}
		return rows;
	},
};
```

- [ ] **Step 2: Quick syntax + type check**

Run: `npx tsc --noEmit`
Expected: no new errors. (Resolves cleanly because the slug `"txd"` is already in `OAChannelSlug` after Task 3.)

- [ ] **Step 3: Commit (parser only, tests next)**

```bash
git add lib/historical-crawl/parsers/txd.ts
git commit -m "feat(historical-crawl): add tv-tokyoshop (txd) JSON parser"
```

---

## Task 5: Add a fixture-based parser test script

**Goal:** Validate `parseTxdResponse` against the recorded fixture so future API contract changes (response shape, key renames) are caught.

**Files:**
- Create: `scripts/test-historical-txd-parser.ts`
- Modify: `package.json` (add npm script)

- [ ] **Step 1: Create the test script**

Create `scripts/test-historical-txd-parser.ts`:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTxdResponse, type TxdApiResponse } from "../lib/historical-crawl/parsers/txd";

const FIXTURE = join(
	process.cwd(),
	"scripts/fixtures/historical-crawl/txd-2026-05-19.json",
);
const JST_DATE = "2026-05-19";

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${msg}`);
	}
}

function main() {
	const raw = readFileSync(FIXTURE, "utf-8");
	const response = JSON.parse(raw) as TxdApiResponse;
	const rows = parseTxdResponse(response, JST_DATE);

	assert(response.RSuccess === true, "fixture RSuccess is true");
	assert(rows.length >= 1, `parser returns ≥1 row (got ${rows.length})`);
	assert(
		rows.length <= (response.RCount ?? Infinity),
		`row count ≤ RCount (${rows.length} ≤ ${response.RCount})`,
	);

	const sample = rows[0];
	assert(sample.channel === "txd", "channel slug is 'txd'");
	assert(sample.air_date === JST_DATE, `air_date matches input (got ${sample.air_date})`);
	assert(sample.start_time === null, "start_time is null (API doesn't expose it)");
	assert(
		typeof sample.product_name === "string" && sample.product_name.length >= 3,
		`product_name non-empty (got "${sample.product_name}")`,
	);
	assert(
		typeof sample.source_url === "string" &&
			sample.source_url.startsWith("https://www.tv-tokyoshop.jp/detail?Gcode="),
		`source_url has expected detail-page shape (got ${sample.source_url})`,
	);
	assert(sample.source_sheet === "live-crawl:txd", "source_sheet tagged correctly");
	assert(
		sample.price_jpy === null || (Number.isInteger(sample.price_jpy) && sample.price_jpy > 0),
		`price_jpy is positive integer or null (got ${sample.price_jpy})`,
	);
	assert(
		sample.price_is_tax_incl === true || sample.price_is_tax_incl === null,
		"price_is_tax_incl is true or null",
	);

	// Defensive: short-name products should have been skipped
	const shortNames = rows.filter((r) => r.product_name.length < 3);
	assert(shortNames.length === 0, "no rows with name shorter than 3 chars");

	if (process.exitCode) {
		console.error("\nParser test failed.");
		process.exit(1);
	}
	console.log(`\nAll assertions passed (${rows.length} rows from fixture).`);
}

main();
```

- [ ] **Step 2: Add the npm script**

Edit `package.json`. Find the existing `test:broadcasts-parsers` script and add a new entry below it. Locate this line:

```json
"test:broadcasts-parsers": "npm run test:broadcasts-shopch && npm run test:broadcasts-qvc",
```

Add immediately after it:

```json
"test:historical-txd-parser": "tsx scripts/test-historical-txd-parser.ts",
```

(Order matters only in that the new entry should sit near the other test scripts for discoverability — exact position is flexible.)

- [ ] **Step 3: Run the parser test**

Run: `npm run test:historical-txd-parser`
Expected: a list of `✓` lines and a final `All assertions passed (N rows from fixture).` message. Exit code 0.

If any assertion fails, fix the parser (Task 4) accordingly and re-run before moving on.

- [ ] **Step 4: Commit**

```bash
git add scripts/test-historical-txd-parser.ts package.json
git commit -m "test(historical-crawl): add txd fixture-based parser test"
```

---

## Task 6: Register the parser in `ALL_PARSERS` and verify integration

**Goal:** Wire `txdParser` into the daily-crawl entry point so the cron picks it up, and audit for any hard-coded channel lists that would silently skip txd.

**Files:**
- Modify: `lib/historical-crawl/index.ts`

- [ ] **Step 1: Add the import and register the parser**

Edit `lib/historical-crawl/index.ts`. Add the import alongside the others:

```typescript
import { junsanpoParser } from "./parsers/junsanpo";
import { ntvParser } from "./parsers/ntv";
import { tbsParser } from "./parsers/tbs";
import { senoburaParser } from "./parsers/senobura";
import { uranouraParser } from "./parsers/uranoura";
import { dinosParser } from "./parsers/dinos";
import { japanetParser } from "./parsers/japanet";
import { txdParser } from "./parsers/txd";
```

And add `txdParser` to the `ALL_PARSERS` array:

```typescript
export const ALL_PARSERS: readonly ChannelParser[] = [
	junsanpoParser,
	ntvParser,
	tbsParser,
	senoburaParser,
	uranouraParser,
	dinosParser,
	japanetParser,
	txdParser,
];
```

- [ ] **Step 2: Audit for hard-coded channel lists**

Run: `grep -nE "['\"](qvc|shopch|japanet|junsanpo|ntv|tbs|dinos|senobura|uranoura)['\"]" components/broadcasts/ lib/broadcasts/ lib/historical-crawl/ app/api/cron/ app/api/broadcasts/ app/[locale]/broadcasts/ -r`

Expected: matches are limited to:
- `lib/broadcasts/channel-style.ts` (the registry — already updated in Task 3).
- `lib/historical-crawl/types.ts` (the union — already updated).
- `lib/historical-crawl/index.ts` (now updated).
- `components/broadcasts/UnifiedDayDetailPanel.tsx` lines 58-59, 160, 162 — those are intentional qvc/shopch-only branches (whitelist categories live there). OA channels (including txd) skip the whitelist correctly because the code reads `if (channel === "qvc") ... else if (channel === "shopch") ...` and falls through (returns `true`) for OA channels. **No change needed.** Verify by reading those lines if uncertain.
- `components/broadcasts/BroadcastListItem.tsx` lines 157-184 — qvc/shopch-only enrichment for video, product cards, and headers. OA channels render with their default item layout (verify the OA list item rendering path doesn't lose anything for txd specifically).

If the grep surfaces an unexpected hard-coded list that an OA channel must be added to (e.g., a Zod enum, a SWR cache key, a select filter), update it now in a separate sub-step. The most likely candidates:
- `app/api/broadcasts/route.ts` — channel query-string validation.
- Any UI hook with a `Record<OAChannelSlug, ...>` literal.

For each unexpected hit, add `txd` to the literal/enum to match the new union.

- [ ] **Step 3: Type-check after wiring**

Run: `npx tsc --noEmit`
Expected: clean. If a new error surfaces (e.g., `Property 'txd' is missing in type 'Record<BroadcastChannelSlug, string>'`), that's a genuine exhaustiveness check catching a place the grep above missed — add the missing entry and re-check.

- [ ] **Step 4: Commit**

```bash
git add lib/historical-crawl/index.ts
git commit -m "feat(historical-crawl): register txd parser in ALL_PARSERS"
```

---

## Task 7: Live integration smoke test

**Goal:** Run the parser end-to-end against the live API on a recent date to confirm the wiring works outside the fixture. Does **not** write to the DB.

**Files:**
- Create: `scripts/test-historical-txd-live.ts`
- Modify: `package.json` (add script)

- [ ] **Step 1: Create the live test script**

Create `scripts/test-historical-txd-live.ts`:

```typescript
import { txdParser } from "../lib/historical-crawl/parsers/txd";

async function main() {
	const yesterday = new Date(Date.now() - 86_400_000);
	const jstDate = new Date(yesterday.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
	console.log(`Live txd fetch against ${jstDate} (no DB write)\n`);

	const rows = await txdParser.fetchToday(jstDate);
	console.log(`Returned ${rows.length} rows.`);
	if (rows.length === 0) {
		console.error("✗ Expected at least 1 row — site markup or API contract may have changed.");
		process.exit(1);
	}

	const sample = rows[0];
	console.log("Sample row:", JSON.stringify(sample, null, 2));

	if (sample.channel !== "txd") {
		console.error(`✗ Unexpected channel: ${sample.channel}`);
		process.exit(1);
	}
	if (sample.air_date !== jstDate) {
		console.error(`✗ Unexpected air_date: ${sample.air_date} (wanted ${jstDate})`);
		process.exit(1);
	}
	console.log("\n✓ Live txd fetch OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add the npm script**

Edit `package.json`. Add near the other historical/broadcasts test scripts:

```json
"test:historical-txd-live": "tsx scripts/test-historical-txd-live.ts",
```

- [ ] **Step 3: Run the live test**

Run: `npm run test:historical-txd-live`
Expected: prints `Returned <N> rows.` where N ≥ 1, a JSON sample row, and `✓ Live txd fetch OK.` Exit code 0.

If the live API returns 0 rows on yesterday's date (genuinely quiet day), bump the script to look at the last 7 days and accept the first day with rows. For the initial verification, you can also temporarily hardcode a known-populated date like `2026-05-19`.

If the live test fails with non-zero exit, debug before continuing — the parser is broken or the contract changed.

- [ ] **Step 4: Commit**

```bash
git add scripts/test-historical-txd-live.ts package.json
git commit -m "test(historical-crawl): add txd live integration smoke test"
```

---

## Task 8: End-to-end verification (no code change)

**Goal:** Run the full daily crawl entry point locally to verify the txd parser participates in `crawlAll()` correctly and produces persistable rows. Optional but recommended.

- [ ] **Step 1: Read `crawlAll` to confirm txdParser is one of N parsers**

Run: `grep -n "txdParser" lib/historical-crawl/index.ts`
Expected: 2 hits (import + array entry).

- [ ] **Step 2: Run the full crawl in dry-run mode**

Since `crawlAll()` writes to the DB via `persistRows()`, do **not** invoke it against production. Instead, write a tiny throwaway script and run it locally with a Supabase service-role pointing to a dev/staging Supabase, OR comment-out the persist step temporarily. Simpler check:

Run: `npx tsx -e "import('./lib/historical-crawl/index').then(async m => { const r = await m.crawlAll('2026-05-19'); console.log('txd rows:', r.results.find(x => x.channel === 'txd')); }).catch(e => { console.error(e); process.exit(1); })"`

Expected: the printed object has `ok: true, rows: [array of ≥1 rows], durationMs: <number>`. The other channels may or may not return rows depending on whether their pages still parse — that's not under test here.

Note: this command WILL attempt a Supabase write if `SUPABASE_SERVICE_ROLE_KEY` is set. If you want to avoid the write entirely, instead run just the parser:

```bash
npx tsx -e "import('./lib/historical-crawl/parsers/txd').then(async m => { const rows = await m.txdParser.fetchToday('2026-05-19'); console.log(rows.length, rows[0]); })"
```

- [ ] **Step 3: Sanity-check UI surface manually (optional, requires dev server)**

Run: `npm run dev`

In a browser, after letting the dev server boot:
1. Visit `http://localhost:3000/ja/broadcasts` and observe a "テレ東マート" chip or row when a day with txd data is shown. **Caveat**: the chip will only appear after a cron run has persisted txd rows. If running locally without a cron, this step is informational — the cron path is the canonical integration.
2. Visit `http://localhost:3000/admin/historical-crawl` to confirm the admin dashboard renders without errors after the registry change.

Skip this if a dev server can't be started.

---

## Task 9: Final commit and operational readiness

**Goal:** Mark the implementation complete, ready for the next scheduled daily cron to start populating txd data.

- [ ] **Step 1: Verify the branch is clean**

Run: `git status`
Expected: `nothing to commit, working tree clean` (all earlier tasks committed).

- [ ] **Step 2: Verify the spec and plan are tracked**

Run: `git log --oneline --all docs/superpowers/specs/2026-05-20-tv-tokyoshop-channel-design.md docs/superpowers/plans/2026-05-20-tv-tokyoshop-channel.md`

Expected: both files appear in the log. If either is untracked, commit them now:

```bash
git add docs/superpowers/specs/2026-05-20-tv-tokyoshop-channel-design.md docs/superpowers/plans/2026-05-20-tv-tokyoshop-channel.md
git commit -m "docs(broadcasts): add tv-tokyoshop channel design + plan"
```

- [ ] **Step 3: Post-deploy readiness checklist**

Document for the operator (no code action, just confirm awareness):

1. The next scheduled `/api/cron/daily-historical-broadcasts` run (JST 02:00 / 17:00 UTC) will attempt to fetch txd. If it succeeds, rows appear in `historical_broadcasts` and surface on `/[locale]/broadcasts` and `/admin/historical-crawl` the same day.
2. If txd's row count is unexpectedly 0 in the admin dashboard, the most likely cause is `X-User-Key: ers_v8` rotation. Re-probe the SPA bundle for the new key and update `X_USER_KEY` in `lib/historical-crawl/parsers/txd.ts`.
3. No schema migration is required. Existing UNIQUE(channel, air_date, product_name) handles idempotency.

---

## Self-Review Checklist (filled in by plan author)

- [x] **Spec coverage.** Every section of the design doc has a corresponding task:
  - §3 (External API contract) → Task 4 (parser) and Task 2 (fixture).
  - §4 (Channel identity) → Task 3 (three-file registry update).
  - §5.0 (politeFetch extension) → Task 1.
  - §5.1 (slug unions) → Task 3.
  - §5.2 (new parser) → Task 4.
  - §5.3 (register in ALL_PARSERS) → Task 6.
  - §5.4 (tests) → Tasks 5 and 7.
  - §5.5 (UI verification) → Task 6 step 2 + Task 8 step 3.
  - §6 (edge cases) → addressed via defensive coding inside `parseTxdResponse` and `fetchToday` (Task 4) and observed via Task 6 audit.
  - §7 (risks) → operational checklist in Task 9.
  - §8 (success criteria) → all covered between Tasks 5–8.

- [x] **No placeholders.** Every step has either runnable commands, complete code, or explicit verification criteria. No "TODO", "add appropriate error handling", or "similar to Task N".

- [x] **Type consistency.** `parseTxdResponse`, `txdProductToRow`, `TxdApiResponse`, and `txdParser` are defined in Task 4 and referenced consistently in Tasks 5–8 with matching names and signatures.

- [x] **Each step is bite-sized.** Steps map to single 2–5 minute actions (edit one file, run one command, commit).
