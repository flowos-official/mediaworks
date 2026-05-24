# Live Commerce Discovery Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the live-commerce discovery pipeline so its surfaced products fit Japan's 2026 live-commerce reality (TikTok Shop JP–aligned categories, ¥1,000–8,000 impulse band, creator/SNS signals) instead of running the home-shopping pipeline with TV signals stripped out.

**Architecture:** Single `runStage1` orchestrator stays the entry point. The `context === 'live_commerce'` branch gets a new category prompt, a 2-platform `LIVE_CHANNELS` registry, and four post-curation boost layers (ROOM mention, Rakuten LIVE archive, YouTube/TikTok creator content, hashtag mention) that run in parallel with a `+15` total-delta clamp. The home_shopping pipeline is untouched.

**Tech Stack:** TypeScript on Next.js App Router + Vercel Functions. Brave Search API for boost-layer signals. Supabase service client for the existing discovery_runs / discovered_products tables. No schema migration. No new test framework (verification via `npx tsc --noEmit`, `npm run lint`, and `tsx` dry-run scripts under `scripts/`).

**Spec:** `docs/superpowers/specs/2026-05-24-live-commerce-discovery-redesign-design.md` (commit `45d337e`).

**Prior state:** Commit `f2727f5` added a wrong 5-platform registry (4 dead/inappropriate) and a single ROOM boost. This plan corrects both — the existing `pool.ts` context branching and `rakuten-room-boost.ts` from `f2727f5` are kept and reused.

---

## File map

```
lib/discovery/live-channels.ts            REWRITE  (5 → 2 platforms)
lib/discovery/plan.ts                     MODIFY   (live_commerce contextGuidance block)
lib/discovery/curate.ts                   MODIFY   (live_commerce contextBlock)
lib/discovery/live-boost-clamp.ts         CREATE   (pure helper, no IO)
lib/discovery/rakuten-live-archive-boost.ts CREATE (L2 bulk-fetch boost)
lib/discovery/creator-content-boost.ts    CREATE   (L3 per-candidate boost)
lib/discovery/hashtag-mention-boost.ts    CREATE   (L4 per-candidate boost)
app/api/cron/daily-discovery-live/route.ts REWRITE (wire L1+L2+L3+L4+clamp)
scripts/test-live-boost-layers.ts         CREATE   (clamp asserts + boost smoke)
scripts/test-live-channels-registry.ts    CREATE   (siteQuery ping)
scripts/test-live-cron-dry-run.ts         CREATE   (runStage1 only, no DB write)
```

Each file has one clear responsibility:
- `live-boost-clamp.ts` is a pure function — no Brave, no DB, easy to assert.
- The three new boost layers are independent, each owns one signal source.
- The cron route file owns orchestration only — it composes the boost layers it doesn't define.

---

## Task 1: Rewrite LIVE_CHANNELS registry

**Files:**
- Modify: `lib/discovery/live-channels.ts` (full rewrite — currently has 5 entries from `f2727f5`)

- [ ] **Step 1: Replace `LIVE_CHANNELS` array with 2 verified platforms**

Open `lib/discovery/live-channels.ts` and replace the `LIVE_CHANNELS` declaration. The full file should become:

```typescript
/**
 * Registry of Japanese live-commerce platforms used as priority signal in
 * discovery when context === 'live_commerce'.
 *
 * Mirrors `lib/discovery/tv-channels.ts` so the same pool builder
 * (`fetchTvChannelFromBraveSite`) can be reused — only the channel
 * list differs. All entries are `scraped: false` because no Japanese
 * live-commerce platform exposes a schedule page we crawl into the
 * `broadcasts` table.
 *
 * Conservative v2 list. Four platforms from the original v1 registry
 * (rakuten_live, mercari_shops, 17live_shop, pinkoi_live) were removed
 * after verification: 楽天LIVE / メルカリチャンネル shut down years ago,
 * 17.live commerce is SaaS-embedded with no central catalog, and Pinkoi
 * has marginal Japan LC traction. See spec
 * docs/superpowers/specs/2026-05-24-live-commerce-discovery-redesign-design.md §2.
 *
 * Adding new entries: a platform qualifies only if it has a publicly
 * crawlable product-page surface that Brave can site:search.
 */

export interface LiveChannel {
	/** Stable identifier persisted in `discovered_products.tv_channel_source`. */
	slug: string;
	/** Japanese display name for UI. */
	name: string;
	/** Site identifier used for Brave `site:` queries. May include a path prefix. */
	siteQuery: string;
	/** Always false for v2 — no live platform exposes a scrape-friendly schedule. */
	scraped: false;
}

export const LIVE_CHANNELS: readonly LiveChannel[] = [
	{
		slug: "rakuten_room",
		name: "Rakuten ROOM",
		siteQuery: "room.rakuten.co.jp",
		scraped: false,
	},
	{
		slug: "rakuten_shopping_channel",
		name: "楽天市場ショッピングチャンネル",
		siteQuery: "event.rakuten.co.jp/campaign/live-shopping",
		scraped: false,
	},
];

/** Look up a live channel by its slug. */
export function getLiveChannelBySlug(slug: string): LiveChannel | undefined {
	return LIVE_CHANNELS.find((c) => c.slug === slug);
}
```

- [ ] **Step 2: Verify typecheck still passes**

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add lib/discovery/live-channels.ts
git commit -m "feat(discovery/live): shrink LIVE_CHANNELS to 2 verified platforms"
```

---

## Task 2: Update live_commerce category prompts

**Files:**
- Modify: `lib/discovery/plan.ts` (live_commerce branch of `contextGuidance`)
- Modify: `lib/discovery/curate.ts` (live_commerce branch of `contextBlock`)

- [ ] **Step 1: Replace `plan.ts` live_commerce contextGuidance**

Use Edit on `lib/discovery/plan.ts`. The current live_commerce branch reads:

```
		context === "live_commerce"
			? `
【Context: ライブコマース】
- ターゲット: 20-40代、SNS利用者、即決購入層
- カテゴリ優先: 化粧品 / ファッション小物 / 美容家電 / ガジェット / 季節限定品 / トレンド雑貨
- 価格帯: ¥1,000-15,000 (即購入可能)
- 重視: SNS拡散性、ビジュアル、若年層共感、トレンド感`
```

Replace it with:

```
		context === "live_commerce"
			? `
【Context: ライブコマース (日本市場 2026)】
- ターゲット: 20-40代女性中心、SNS/動画ネイティブ、クリエイター追従購買層、即決層
- カテゴリ優先 (TikTok Shop JP 2025-11 GMV実績ベース):
  1. 美容・パーソナルケア (化粧品/スキンケア/ヘアケア/フレグランス)
  2. 食品・ドリンク (お菓子/健康ドリンク/調味料/コーヒー紅茶/産直)
  3. レディースファッション (アパレル/小物/アクセサリー — トレンド寄り)
  4. おもちゃ・ホビー (キャラクター/コレクター/DIY/ペット用品)
  5. 生活トレンド雑貨 (キッチン雑貨/インテリア小物 — ビジュアル映え必須)
- 価格帯: ¥1,000-8,000 (即決インパルスゾーン、ファッションのみ¥12,000まで許容)
- 重視: ビジュアル/動画映え、クリエイター親和性 (アフィリエイト/レビュー動画作成しやすい)、SNS拡散性、リアルタイム購買トリガー (限定/タイムセール訴求)
- 除外: 設置必須の家電、高額耐久財、医薬品、TV実演前提商品、高齢者専用商品`
```

The home_shopping branch following the colon stays exactly as it is.

- [ ] **Step 2: Replace `curate.ts` live_commerce contextBlock**

Use Edit on `lib/discovery/curate.ts`. The current live_commerce branch reads:

```
		context === "live_commerce"
			? `
【Context: ライブコマース (20-40代、SNS利用者)】
- 重視: SNS拡散性、ビジュアル訴求、トレンド感、若年層共感
- 価格帯ゾーン: ¥1,000-15,000 (即購入)
- 除外特性: じっくり検討が必要な高額品、高齢者専用商品`
```

Replace it with:

```
		context === "live_commerce"
			? `
【Context: ライブコマース (20-40代女性、SNS/動画ネイティブ、クリエイター追従層)】
- 重視: ビジュアル/動画映え、クリエイター親和性、SNS拡散性、インパルス価格帯フィット、リアルタイム購買トリガー (限定/タイムセール)
- 価格帯ゾーン: ¥1,000-8,000 (即決インパルス) / ファッションのみ ¥1,000-12,000
- カテゴリ重み (TikTok Shop JP実績):
  ★★★ 美容・パーソナルケア / 食品・ドリンク
  ★★  レディースファッション / おもちゃ・ホビー
  ★   生活トレンド雑貨
- 除外特性: 設置必須家電、高額耐久財、医薬品、TV実演必須商品、高齢者専用商品、機能訴求のみで視覚要素が弱い商品`
```

The home_shopping branch stays exactly as is.

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add lib/discovery/plan.ts lib/discovery/curate.ts
git commit -m "feat(discovery/live): rebuild category prompts against TikTok Shop JP 2025-11 data"
```

---

## Task 3: Live boost clamp (TDD — pure function)

**Files:**
- Create: `lib/discovery/live-boost-clamp.ts`
- Create: `scripts/test-live-boost-layers.ts` (clamp assertions; boost smoke tests added in Task 8)

This task uses TDD because `clampLiveBoosts` is a pure function with deterministic input/output, easily asserted without network.

- [ ] **Step 1: Write the failing assertion script**

Create `scripts/test-live-boost-layers.ts` with just the clamp assertions for now:

```typescript
/**
 * Dry-run for the live-commerce post-curation boost layers + clamp.
 * Sectioned so each layer can be exercised independently.
 *
 * Usage: npx tsx scripts/test-live-boost-layers.ts
 */
import { clampLiveBoosts } from "@/lib/discovery/live-boost-clamp";
import type { Candidate } from "@/lib/discovery/types";

function makeCandidate(url: string, score: number): Candidate {
	return {
		name: `test ${url}`,
		productUrl: url,
		source: "rakuten",
		seedKeyword: "test",
		track: "tv_proven",
		tvFitScore: score,
		tvFitReason: "baseline",
		isTvApplicable: true,
		isLiveApplicable: true,
		scoreBreakdown: {
			review_signal: 0,
			tv_category_match: 0,
			trend_signal: 0,
			price_fit: 0,
			purchase_signal: 0,
			total: score,
		},
		context: "live_commerce",
	};
}

function assert(cond: boolean, msg: string): void {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
	console.log(`ok: ${msg}`);
}

function testClamp() {
	console.log("\n## clampLiveBoosts");
	// candidate A: delta within cap (no clamp)
	// candidate B: delta exceeds cap (clamp applied)
	// candidate C: not in baseline map (skipped)
	const a = makeCandidate("https://example.com/a", 70); // delta 10 (baseline 60)
	const b = makeCandidate("https://example.com/b", 85); // delta 25 (baseline 60), exceeds +15
	const c = makeCandidate("https://example.com/c", 90); // not in baseline

	const baseline = new Map<string, number>([
		["https://example.com/a", 60],
		["https://example.com/b", 60],
	]);

	const clamped = clampLiveBoosts([a, b, c], baseline, 15);

	assert(clamped === 1, "exactly one candidate clamped");
	assert(a.tvFitScore === 70, "A score unchanged (delta within cap)");
	assert(!a.tvFitReason.includes("合算cap"), "A annotation unchanged");
	assert(b.tvFitScore === 75, "B clamped to baseline+cap (60+15)");
	assert(b.tvFitReason.includes("[合算cap+15]"), "B annotated with clamp");
	assert(c.tvFitScore === 90, "C unaffected (no baseline entry)");
}

testClamp();
console.log("\nall passed");
```

- [ ] **Step 2: Run and verify failure (module not found)**

Run: `npx tsx scripts/test-live-boost-layers.ts`
Expected: error containing `Cannot find module '@/lib/discovery/live-boost-clamp'` or similar.

- [ ] **Step 3: Create `live-boost-clamp.ts` with minimal implementation**

Create `lib/discovery/live-boost-clamp.ts`:

```typescript
/**
 * Live-commerce post-boost total-delta clamp.
 *
 * After the four boost layers (L1 ROOM / L2 Rakuten LIVE archive /
 * L3 creator content / L4 hashtag) each apply their own additive boost
 * with a per-layer cap of +5, a single candidate can in principle
 * accumulate up to +20. The clamp enforces a smaller total cap (default
 * +15) so no candidate can rise purely through stacked boosts. Pure
 * function — no IO.
 *
 * The clamp is keyed on a baseline tvFitScore snapshot taken right
 * after curate but before any boost layer runs. Candidates absent from
 * the baseline map are left untouched (defensive — should not happen
 * in normal flow).
 */
import type { Candidate } from "./types";

/**
 * Mutates each candidate in place: when its tvFitScore minus the
 * baseline exceeds `cap`, sets tvFitScore to baseline + cap (clamped
 * to 100) and appends a `[合算cap+<cap>]` annotation to tvFitReason.
 *
 * Returns the number of candidates that were clamped.
 */
export function clampLiveBoosts(
	candidates: Candidate[],
	baselineByUrl: Map<string, number>,
	cap: number,
): number {
	let clamped = 0;
	for (const c of candidates) {
		const baseline = baselineByUrl.get(c.productUrl);
		if (baseline === undefined) continue;
		const delta = c.tvFitScore - baseline;
		if (delta <= cap) continue;
		c.tvFitScore = Math.min(100, baseline + cap);
		c.tvFitReason = `${c.tvFitReason} [合算cap+${cap}]`.slice(0, 200);
		clamped += 1;
	}
	return clamped;
}
```

- [ ] **Step 4: Run the test script and verify pass**

Run: `npx tsx scripts/test-live-boost-layers.ts`
Expected: stdout ending in `all passed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/discovery/live-boost-clamp.ts scripts/test-live-boost-layers.ts
git commit -m "feat(discovery/live): add total-delta clamp + dry-run script"
```

---

## Task 4: L2 — Rakuten Shopping Channel archive boost

**Files:**
- Create: `lib/discovery/rakuten-live-archive-boost.ts`

- [ ] **Step 1: Create the file**

Create `lib/discovery/rakuten-live-archive-boost.ts`:

```typescript
/**
 * L2 boost — Rakuten Shopping Channel archive matching.
 *
 * Rakuten's actual live-commerce platform after the 2021 shutdown of
 * 楽天LIVE is the 楽天市場ショッピングチャンネル at
 * event.rakuten.co.jp/campaign/live-shopping. Archive pages reference
 * the actual products that were broadcast — extracting those item codes
 * gives a high-precision "this product has live-commerce broadcast
 * track record" signal.
 *
 * Method: 3 bulk Brave queries against the archive site → build a Set
 * of `shopCode:itemCode` keys → match against each candidate's
 * `rakutenItemCode`. Falls back to a direct HTTP fetch of the top
 * result page when the Brave excerpts didn't expose product links.
 *
 * Cost: independent of candidate count (~3 Brave calls + at most 1
 * fallback fetch per cron run).
 *
 * Spec: docs/superpowers/specs/2026-05-24-live-commerce-discovery-redesign-design.md §5.3
 */
import { braveSearchItems } from "@/lib/brave";
import type { Candidate } from "./types";

function envInt(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return defaultValue;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

const BOOST = envInt("RAKUTEN_LIVE_ARCHIVE_BOOST", 5);

const ARCHIVE_QUERIES = [
	"site:event.rakuten.co.jp/campaign/live-shopping",
	"site:event.rakuten.co.jp/campaign/live-shopping ライブ",
	"site:event.rakuten.co.jp/campaign/live-shopping アーカイブ",
];

// Capture group 1 = shopCode, group 2 = itemCode. `g` flag so matchAll
// returns every occurrence in a haystack.
const ITEM_URL_RE = /item\.rakuten\.co\.jp\/([^/]+)\/([^/?#]+)/g;
const FALLBACK_MIN_CODES = 5;
const FALLBACK_FETCH_TIMEOUT_MS = 10_000;

/**
 * Extract `shopCode:itemCode` keys from a free-form string.
 */
function extractItemCodes(haystack: string): string[] {
	const codes: string[] = [];
	for (const m of haystack.matchAll(ITEM_URL_RE)) {
		codes.push(`${m[1]}:${m[2]}`);
	}
	return codes;
}

async function fetchHtmlSafe(url: string): Promise<string> {
	try {
		const res = await fetch(url, {
			headers: { Accept: "text/html" },
			signal: AbortSignal.timeout(FALLBACK_FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return "";
		return await res.text();
	} catch {
		return "";
	}
}

/**
 * Mutates `candidates` in place. Returns the number of candidates whose
 * tvFitScore was boosted.
 */
export async function applyRakutenLiveArchiveBoost(
	candidates: Candidate[],
): Promise<number> {
	if (candidates.length === 0 || BOOST <= 0) return 0;

	const codeSet = new Set<string>();
	const seedUrls: string[] = [];

	for (const q of ARCHIVE_QUERIES) {
		try {
			const hits = await braveSearchItems(q, 10);
			for (const h of hits) {
				if (h.url) seedUrls.push(h.url);
				for (const code of extractItemCodes(`${h.url} ${h.description}`)) {
					codeSet.add(code);
				}
			}
		} catch (err) {
			console.warn(
				`[archive-boost] brave query failed (${q}):`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	// Fallback: Brave excerpts often hide product links. Fetch the top
	// 1-2 archive pages directly and parse for item URLs.
	if (codeSet.size < FALLBACK_MIN_CODES && seedUrls.length > 0) {
		for (const url of seedUrls.slice(0, 2)) {
			const html = await fetchHtmlSafe(url);
			if (!html) continue;
			for (const code of extractItemCodes(html)) {
				codeSet.add(code);
			}
		}
	}

	if (codeSet.size === 0) return 0;

	let boosted = 0;
	for (const c of candidates) {
		if (!c.rakutenItemCode || !codeSet.has(c.rakutenItemCode)) continue;
		const next = Math.min(100, c.tvFitScore + BOOST);
		if (next === c.tvFitScore) continue;
		c.tvFitScore = next;
		c.tvFitReason = `${c.tvFitReason} [楽天LIVE放送実績あり]`.slice(0, 200);
		boosted += 1;
	}
	candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);
	return boosted;
}

export const __test = {
	envInt,
	extractItemCodes,
	ARCHIVE_QUERIES,
	BOOST,
	FALLBACK_MIN_CODES,
};
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add lib/discovery/rakuten-live-archive-boost.ts
git commit -m "feat(discovery/live): L2 boost — Rakuten Shopping Channel archive"
```

---

## Task 5: L3 — Creator content boost (YouTube + TikTok)

**Files:**
- Create: `lib/discovery/creator-content-boost.ts`

- [ ] **Step 1: Create the file**

Create `lib/discovery/creator-content-boost.ts`:

```typescript
/**
 * L3 boost — YouTube + TikTok creator-content mention.
 *
 * For each top-N candidate, one Brave query against site:youtube.com
 * OR site:tiktok.com. A noise filter requires the result's title to
 * contain at least 2 tokens from the candidate's product name to count.
 * Tiered boost: hits >= 1 → +3, hits >= 3 → +5.
 *
 * Spec: docs/superpowers/specs/2026-05-24-live-commerce-discovery-redesign-design.md §5.4
 */
import { braveSearchItems } from "@/lib/brave";
import type { Candidate } from "./types";

function envInt(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return defaultValue;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

const CAP = envInt("CREATOR_CONTENT_BOOST_CAP", 30);
const TIER1 = envInt("CREATOR_CONTENT_BOOST_TIER1", 3);
const TIER2 = envInt("CREATOR_CONTENT_BOOST_TIER2", 5);
const CONCURRENCY = envInt("CREATOR_CONTENT_BOOST_CONCURRENCY", 4);
const TIER2_THRESHOLD = 3;
const PER_CALL_HITS = 10;
const MIN_NAME_TOKEN_MATCHES = 2;

/**
 * Split a product name into tokens >= 2 chars. NFKC-normalize first so
 * a full-width katakana name and its half-width form tokenize the same
 * way.
 */
export function tokenizeName(name: string): string[] {
	if (!name) return [];
	return name
		.normalize("NFKC")
		.split(/[\s・\/／,、|\-【】\[\]＜＞]+/)
		.map((s) => s.trim())
		.filter((s) => s.length >= 2)
		.slice(0, 6);
}

/**
 * Mutates `candidates` in place. Re-sorts by tvFitScore after applying.
 * Returns the number of candidates that were boosted.
 */
export async function applyCreatorContentBoost(
	candidates: Candidate[],
): Promise<number> {
	if (candidates.length === 0 || TIER1 <= 0) return 0;

	const targets = [...candidates]
		.sort((a, b) => b.tvFitScore - a.tvFitScore)
		.slice(0, CAP);

	let cursor = 0;
	let boosted = 0;

	const worker = async () => {
		while (cursor < targets.length) {
			const idx = cursor++;
			const candidate = targets[idx];
			const query =
				`"${candidate.name.slice(0, 40)}" (site:youtube.com OR site:tiktok.com)`;
			try {
				const hits = await braveSearchItems(query, PER_CALL_HITS);
				const tokens = tokenizeName(candidate.name);
				const matching = hits.filter((h) => {
					const title = (h.title ?? "").normalize("NFKC");
					let matches = 0;
					for (const t of tokens) {
						if (title.includes(t)) matches += 1;
						if (matches >= MIN_NAME_TOKEN_MATCHES) return true;
					}
					return false;
				});
				if (matching.length === 0) continue;
				const boost = matching.length >= TIER2_THRESHOLD ? TIER2 : TIER1;
				const next = Math.min(100, candidate.tvFitScore + boost);
				if (next === candidate.tvFitScore) continue;
				candidate.tvFitScore = next;
				const shown = Math.min(matching.length, 5);
				candidate.tvFitReason =
					`${candidate.tvFitReason} [YouTube/TikTok言及 ${shown}件]`.slice(
						0,
						200,
					);
				boosted += 1;
			} catch (err) {
				console.warn(
					`[creator-content-boost] brave query failed for "${candidate.name.slice(0, 40)}":`,
					err instanceof Error ? err.message : String(err),
				);
			}
		}
	};

	await Promise.all(
		Array.from(
			{ length: Math.min(CONCURRENCY, targets.length) },
			() => worker(),
		),
	);

	candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);
	return boosted;
}

export const __test = {
	envInt,
	tokenizeName,
	CAP,
	TIER1,
	TIER2,
	TIER2_THRESHOLD,
	CONCURRENCY,
	MIN_NAME_TOKEN_MATCHES,
};
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add lib/discovery/creator-content-boost.ts
git commit -m "feat(discovery/live): L3 boost — YouTube + TikTok creator mention"
```

---

## Task 6: L4 — Hashtag mention boost

**Files:**
- Create: `lib/discovery/hashtag-mention-boost.ts`

- [ ] **Step 1: Create the file**

Create `lib/discovery/hashtag-mention-boost.ts`:

```typescript
/**
 * L4 boost — Japanese live-commerce hashtag mention.
 *
 * For each top-N candidate, one Brave query of the form
 *   `"<name>" ("#ライブで紹介" OR "#ライブコマース" OR "ライブで紹介")`.
 * Any hit yields a flat +5. Brave indexes Instagram/Threads/blog mirrors
 * more reliably than X in the JP market; the hashtag itself supplies
 * the live-commerce context regardless of which medium carries it.
 *
 * Spec: docs/superpowers/specs/2026-05-24-live-commerce-discovery-redesign-design.md §5.5
 */
import { braveSearchItems } from "@/lib/brave";
import type { Candidate } from "./types";

function envInt(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return defaultValue;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

const BOOST = envInt("HASHTAG_MENTION_BOOST", 5);
const CAP = envInt("HASHTAG_MENTION_BOOST_CAP", 30);
const CONCURRENCY = envInt("HASHTAG_MENTION_BOOST_CONCURRENCY", 4);
const PER_CALL_HITS = 5;

const QUERY_SUFFIX =
	`("#ライブで紹介" OR "#ライブコマース" OR "ライブで紹介")`;

/**
 * Mutates `candidates` in place. Re-sorts by tvFitScore after applying.
 * Returns the number of candidates that were boosted.
 */
export async function applyHashtagMentionBoost(
	candidates: Candidate[],
): Promise<number> {
	if (candidates.length === 0 || BOOST <= 0) return 0;

	const targets = [...candidates]
		.sort((a, b) => b.tvFitScore - a.tvFitScore)
		.slice(0, CAP);

	let cursor = 0;
	let boosted = 0;

	const worker = async () => {
		while (cursor < targets.length) {
			const idx = cursor++;
			const candidate = targets[idx];
			const query = `"${candidate.name.slice(0, 40)}" ${QUERY_SUFFIX}`;
			try {
				const hits = await braveSearchItems(query, PER_CALL_HITS);
				if (hits.length === 0) continue;
				const next = Math.min(100, candidate.tvFitScore + BOOST);
				if (next === candidate.tvFitScore) continue;
				candidate.tvFitScore = next;
				candidate.tvFitReason =
					`${candidate.tvFitReason} [ライブ紹介ハッシュタグ言及]`.slice(0, 200);
				boosted += 1;
			} catch (err) {
				console.warn(
					`[hashtag-mention-boost] brave query failed for "${candidate.name.slice(0, 40)}":`,
					err instanceof Error ? err.message : String(err),
				);
			}
		}
	};

	await Promise.all(
		Array.from(
			{ length: Math.min(CONCURRENCY, targets.length) },
			() => worker(),
		),
	);

	candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);
	return boosted;
}

export const __test = {
	envInt,
	BOOST,
	CAP,
	CONCURRENCY,
	QUERY_SUFFIX,
};
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add lib/discovery/hashtag-mention-boost.ts
git commit -m "feat(discovery/live): L4 boost — live-commerce hashtag mention"
```

---

## Task 7: Wire L1+L2+L3+L4+clamp into live cron

**Files:**
- Modify: `app/api/cron/daily-discovery-live/route.ts` (full rewrite of the post-curation section)

- [ ] **Step 1: Replace the file body**

Overwrite `app/api/cron/daily-discovery-live/route.ts` entirely with:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { applyRakutenRoomBoost } from "@/lib/discovery/rakuten-room-boost";
import { applyRakutenLiveArchiveBoost } from "@/lib/discovery/rakuten-live-archive-boost";
import { applyCreatorContentBoost } from "@/lib/discovery/creator-content-boost";
import { applyHashtagMentionBoost } from "@/lib/discovery/hashtag-mention-boost";
import { clampLiveBoosts } from "@/lib/discovery/live-boost-clamp";
import { runStage1 } from "@/lib/discovery/orchestrator";
import { runOptionalStage } from "@/lib/discovery/cron-budget";
import {
	attachPlanToSession,
	createSession,
	finalizeSession,
	reconcileStaleDiscoveryRuns,
	saveDiscoveredProducts,
} from "@/lib/discovery/save";
import { getServiceClient } from "@/lib/supabase";
import { DEFAULT_LEARNING_STATE, type LearningState } from "@/lib/discovery/types";

export const maxDuration = 300;

const TARGET_COUNT = Number(process.env.DISCOVERY_TARGET_COUNT ?? 30);
const CONTEXT = "live_commerce" as const;
const SAVE_FINALIZE_DEADLINE_MS = Number(
	process.env.DISCOVERY_SAVE_FINALIZE_DEADLINE_MS ?? 270_000,
);
const OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS = Number(
	process.env.DISCOVERY_OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS ?? 20_000,
);
const LIVE_BOOST_TOTAL_CAP = Number(process.env.LIVE_BOOST_TOTAL_CAP ?? 15);

async function loadLearningState(): Promise<LearningState> {
	try {
		const sb = getServiceClient();
		const { data, error } = await sb
			.from("learning_state")
			.select("*")
			.eq("context", "live_commerce")
			.single();
		if (error || !data) return DEFAULT_LEARNING_STATE;
		return {
			exploration_ratio: data.exploration_ratio,
			category_weights: data.category_weights ?? {},
			category_seasonal_weights: data.category_seasonal_weights ?? {},
			rejected_seeds: data.rejected_seeds ?? {
				urls: [],
				brands: [],
				terms: [],
			},
			recent_rejection_reasons: data.recent_rejection_reasons ?? [],
			feedback_sample_size: data.feedback_sample_size ?? 0,
			is_cold_start: data.is_cold_start ?? true,
		};
	} catch {
		return DEFAULT_LEARNING_STATE;
	}
}

function verifyCronAuth(req: NextRequest): boolean {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true;
	const header = req.headers.get("authorization");
	return header === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
	if (!verifyCronAuth(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const startedAt = Date.now();
	await reconcileStaleDiscoveryRuns({ context: CONTEXT })
		.then((res) => {
			if (res.reconciled > 0) {
				console.warn(`[cron ${CONTEXT}] reconciled stale sessions`, res);
			}
		})
		.catch((err) => {
			console.warn(
				`[cron ${CONTEXT}] stale-session reconciliation failed:`,
				err instanceof Error ? err.message : String(err),
			);
		});

	const learning = await loadLearningState();
	const sessionId = await createSession({
		targetCount: TARGET_COUNT,
		explorationRatio: learning.exploration_ratio,
		context: CONTEXT,
	});

	try {
		const orchestrated = await runStage1(learning, TARGET_COUNT, CONTEXT);
		await attachPlanToSession(sessionId, orchestrated.plan);

		// Snapshot the post-curate score for every candidate. The four boost
		// layers each add up to +5; clampLiveBoosts enforces that the total
		// delta from this baseline stays <= LIVE_BOOST_TOTAL_CAP.
		const baselineByUrl = new Map<string, number>(
			orchestrated.candidates.map((c) => [c.productUrl, c.tvFitScore]),
		);

		// L1-L4 are independent (each only adds to tvFitScore on a single
		// candidate at a time, no cross-candidate state). Running them in
		// parallel is safe under JS single-threaded execution + the final
		// clamp.
		await Promise.all([
			runOptionalStage({
				label: `${CONTEXT}:L1-room-mention`,
				startedAtMs: startedAt,
				deadlineMs: SAVE_FINALIZE_DEADLINE_MS,
				minSaveBudgetMs: OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS,
				fallback: null,
				task: async () => {
					await applyRakutenRoomBoost(orchestrated.candidates);
					return null;
				},
			}),
			runOptionalStage({
				label: `${CONTEXT}:L2-rakuten-live-archive`,
				startedAtMs: startedAt,
				deadlineMs: SAVE_FINALIZE_DEADLINE_MS,
				minSaveBudgetMs: OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS,
				fallback: null,
				task: async () => {
					await applyRakutenLiveArchiveBoost(orchestrated.candidates);
					return null;
				},
			}),
			runOptionalStage({
				label: `${CONTEXT}:L3-creator-content`,
				startedAtMs: startedAt,
				deadlineMs: SAVE_FINALIZE_DEADLINE_MS,
				minSaveBudgetMs: OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS,
				fallback: null,
				task: async () => {
					await applyCreatorContentBoost(orchestrated.candidates);
					return null;
				},
			}),
			runOptionalStage({
				label: `${CONTEXT}:L4-hashtag-mention`,
				startedAtMs: startedAt,
				deadlineMs: SAVE_FINALIZE_DEADLINE_MS,
				minSaveBudgetMs: OPTIONAL_STAGE_MIN_SAVE_BUDGET_MS,
				fallback: null,
				task: async () => {
					await applyHashtagMentionBoost(orchestrated.candidates);
					return null;
				},
			}),
		]);

		clampLiveBoosts(orchestrated.candidates, baselineByUrl, LIVE_BOOST_TOTAL_CAP);
		orchestrated.candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);

		const batch = orchestrated.candidates.map((c) => ({
			candidate: c,
			broadcastTag: "unknown" as const,
			broadcastSources: [],
			tvEvidence: null,
		}));
		const savedCount = await saveDiscoveredProducts(sessionId, batch, {
			categoryEnrichmentDeadlineMs: startedAt + SAVE_FINALIZE_DEADLINE_MS,
		});

		const partial = savedCount < TARGET_COUNT;
		await finalizeSession({
			sessionId,
			status: partial ? "partial" : "completed",
			producedCount: savedCount,
			iterations: orchestrated.iterations,
		});

		try {
			revalidateTag("discovery:live_commerce", "max");
			revalidateTag("discovery:history", "max");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn("[cache] revalidateTag failed", {
				route: "daily-discovery-live",
				error: msg,
			});
		}

		return NextResponse.json({
			ok: true,
			context: CONTEXT,
			sessionId,
			producedCount: savedCount,
			iterations: orchestrated.iterations,
			poolSize: orchestrated.poolSize,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[cron ${CONTEXT}] failed:`, msg);
		await finalizeSession({
			sessionId,
			status: "failed",
			producedCount: 0,
			iterations: 0,
			error: msg.slice(0, 500),
		});
		return NextResponse.json(
			{ ok: false, context: CONTEXT, sessionId, error: msg },
			{ status: 500 },
		);
	}
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Confirm cron file does not import any TV-shopping post-processing layer**

Use Grep with pattern `applyBroadcastBoost|tagBroadcastEvidence|applyRecentBroadcastPenalty|applyCompetitorTrendBoost|applyEvidenceBonus|computeTvEvidence` on `app/api/cron/daily-discovery-live/route.ts`.
Expected: zero matches.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/daily-discovery-live/route.ts
git commit -m "feat(discovery/live): wire L1+L2+L3+L4 boost layers + clamp"
```

---

## Task 8: Extend dry-run script with boost smoke tests

**Files:**
- Modify: `scripts/test-live-boost-layers.ts` (append boost smoke calls to the file created in Task 3)

These tests hit the live Brave API and print actual annotation output, so the engineer can spot-check the boost behaviour before deployment. They do not assert — the network is too variable. Asserts remain limited to the clamp.

- [ ] **Step 1: Append imports**

Open `scripts/test-live-boost-layers.ts`. Add these imports alongside the existing one:

```typescript
import { applyRakutenRoomBoost } from "@/lib/discovery/rakuten-room-boost";
import { applyRakutenLiveArchiveBoost } from "@/lib/discovery/rakuten-live-archive-boost";
import { applyCreatorContentBoost } from "@/lib/discovery/creator-content-boost";
import { applyHashtagMentionBoost } from "@/lib/discovery/hashtag-mention-boost";
```

- [ ] **Step 2: Add the smoke-test function**

Add this function definition immediately before the existing `testClamp();` call:

```typescript
async function testBoostSmoke() {
	console.log("\n## boost smoke (calls Brave — outputs are observational)");

	// Two candidates: one well-known (likely to trigger several boosts),
	// one obscure (likely to trigger none). Adjust names if Brave quota
	// is exhausted or you want to retarget.
	const seeded: Candidate[] = [
		{
			...makeCandidate("https://item.rakuten.co.jp/lululun/lululun01/", 70),
			name: "ルルルン プレシャス フェイスマスク",
			rakutenItemCode: "lululun:lululun01",
		},
		{
			...makeCandidate("https://item.rakuten.co.jp/none/zzz_obscure_test_item_xyz/", 70),
			name: "Z_obscure_test_item_xyz_あ",
			rakutenItemCode: "none:zzz_obscure_test_item_xyz",
		},
	];

	const print = (label: string) => {
		for (const c of seeded) {
			console.log(`  ${label}: "${c.name}" → ${c.tvFitScore} | ${c.tvFitReason}`);
		}
	};

	print("baseline");
	await applyRakutenRoomBoost(seeded);
	print("after L1");
	await applyRakutenLiveArchiveBoost(seeded);
	print("after L2");
	await applyCreatorContentBoost(seeded);
	print("after L3");
	await applyHashtagMentionBoost(seeded);
	print("after L4");
}
```

- [ ] **Step 3: Update the trailing calls**

Replace the final two lines:

```typescript
testClamp();
console.log("\nall passed");
```

with:

```typescript
testClamp();
await testBoostSmoke();
console.log("\nall passed");
```

Top-level `await` is supported because the file is treated as ESM by `tsx`.

- [ ] **Step 4: Run the dry-run script**

Run: `npx tsx scripts/test-live-boost-layers.ts`
Expected: clamp section prints `ok:` for each assertion; boost-smoke section prints annotated lines for each candidate at each stage; final line `all passed`.

The well-known candidate should accumulate at least one of `[ROOM言及あり]` / `[YouTube/TikTok言及]` / `[ライブ紹介ハッシュタグ言及]` across the runs. The obscure candidate should remain at baseline. Note these are observational, not asserted — Brave outcomes vary.

- [ ] **Step 5: Commit**

```bash
git add scripts/test-live-boost-layers.ts
git commit -m "test(discovery/live): smoke-test L1-L4 against live Brave"
```

---

## Task 9: Live channels registry ping script

**Files:**
- Create: `scripts/test-live-channels-registry.ts`

- [ ] **Step 1: Create the script**

Create `scripts/test-live-channels-registry.ts`:

```typescript
/**
 * Ping each LIVE_CHANNELS siteQuery for a 2xx/3xx response. Run before
 * deployment to confirm none of the configured platforms went dark.
 *
 * Usage: npx tsx scripts/test-live-channels-registry.ts
 *
 * Exit code: 0 if all reachable, 1 if any returned 4xx/5xx or network
 * error.
 */
import { LIVE_CHANNELS } from "@/lib/discovery/live-channels";

const TIMEOUT_MS = 10_000;

async function ping(siteQuery: string): Promise<{ ok: boolean; status: number | string }> {
	// Brave site:queries use the bare host; for ping we hit https://<host>/.
	const host = siteQuery.split("/")[0];
	const url = `https://${host}/`;
	try {
		const res = await fetch(url, {
			method: "GET",
			redirect: "follow",
			headers: {
				"User-Agent":
					"Mozilla/5.0 (registry-ping; +https://github.com/flowos-official/mediaworks)",
			},
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		return { ok: res.ok, status: res.status };
	} catch (err) {
		return {
			ok: false,
			status: err instanceof Error ? err.message : "unknown",
		};
	}
}

async function main() {
	let allOk = true;
	for (const ch of LIVE_CHANNELS) {
		const { ok, status } = await ping(ch.siteQuery);
		const flag = ok ? "OK" : "FAIL";
		console.log(`[${flag}] ${ch.slug.padEnd(28)} ${String(status).padEnd(8)} ${ch.siteQuery}`);
		if (!ok) allOk = false;
	}
	process.exit(allOk ? 0 : 1);
}

await main();
```

- [ ] **Step 2: Run the ping**

Run: `npx tsx scripts/test-live-channels-registry.ts`
Expected: `[OK] rakuten_room ...` and `[OK] rakuten_shopping_channel ...` lines, exit 0.

If either fails, do NOT proceed to commit — that's a signal the registry needs adjustment.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-live-channels-registry.ts
git commit -m "test(discovery/live): registry reachability ping"
```

---

## Task 10: runStage1 dry-run script

**Files:**
- Create: `scripts/test-live-cron-dry-run.ts`

- [ ] **Step 1: Create the script**

Create `scripts/test-live-cron-dry-run.ts`:

```typescript
/**
 * Run the live_commerce stage-1 pipeline (plan → pool → curate) without
 * touching the database. Prints the category/price distribution of the
 * curated candidates so you can verify the new prompts are steering
 * Gemini toward TikTok Shop JP categories.
 *
 * Usage: npx tsx scripts/test-live-cron-dry-run.ts
 */
import { runStage1 } from "@/lib/discovery/orchestrator";
import { DEFAULT_LEARNING_STATE } from "@/lib/discovery/types";

async function main() {
	console.log("Running runStage1('live_commerce') — no DB writes\n");
	const t0 = Date.now();
	const result = await runStage1(DEFAULT_LEARNING_STATE, 30, "live_commerce");
	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

	console.log(`pool size:   ${result.poolSize}`);
	console.log(`iterations:  ${result.iterations}`);
	console.log(`candidates:  ${result.candidates.length}`);
	console.log(`elapsed:     ${elapsed}s\n`);

	const byChannel = new Map<string, number>();
	const byPriceBand = new Map<string, number>();
	const byCategory = new Map<string, number>();

	for (const c of result.candidates) {
		const ch = c.tvChannelSource ?? "(none)";
		byChannel.set(ch, (byChannel.get(ch) ?? 0) + 1);

		const cat = c.category ?? "(uncategorized)";
		byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);

		const p = c.priceJpy ?? 0;
		let band: string;
		if (p === 0) band = "unknown";
		else if (p < 1000) band = "<¥1k";
		else if (p < 5000) band = "¥1-5k";
		else if (p < 8000) band = "¥5-8k";
		else if (p < 12000) band = "¥8-12k";
		else band = "¥12k+";
		byPriceBand.set(band, (byPriceBand.get(band) ?? 0) + 1);
	}

	const printDist = (label: string, m: Map<string, number>) => {
		console.log(`\n${label}:`);
		const entries = [...m.entries()].sort((a, b) => b[1] - a[1]);
		for (const [k, v] of entries) {
			console.log(`  ${String(v).padStart(3)}  ${k}`);
		}
	};

	printDist("by tv_channel_source", byChannel);
	printDist("by price band", byPriceBand);
	printDist("by category (top entries)", byCategory);

	console.log(`\nplan keywords:`);
	console.log(`  tv_proven:   ${result.plan.tv_proven.join(", ")}`);
	console.log(`  exploration: ${result.plan.exploration.join(", ")}`);
}

await main();
```

- [ ] **Step 2: Run the dry-run**

Run: `npx tsx scripts/test-live-cron-dry-run.ts`
Expected: prints distributions. Spot-check:
- `by tv_channel_source` should include `rakuten_room` and/or `rakuten_shopping_channel`.
- `by price band` should cluster in `¥1-5k` and `¥5-8k`.
- `by category` should show 美容 / コスメ / 食品 / ファッション-flavored entries (NOT 家電 / ガジェット dominant).
- `plan keywords` should be drawn from TikTok Shop JP categories.

If the distribution is off, it indicates the Gemini prompt changes from Task 2 didn't take effect — re-check the strings against spec §5.2 before proceeding.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-live-cron-dry-run.ts
git commit -m "test(discovery/live): runStage1 dry-run with distribution prints"
```

---

## Task 11: Final verification

**Files:** (none modified — verification only)

- [ ] **Step 1: Run typecheck**

Run: `npx tsc --noEmit; echo "EXIT=$?"`
Expected: `EXIT=0`.

- [ ] **Step 2: Run lint and confirm no new errors**

Run: `npm run lint 2>&1 | tail -50`
Expected: `0 errors`. Warnings should match the 30 pre-existing warnings logged in the f2727f5 cycle — none from the new files.

- [ ] **Step 3: Run the dry-run scripts in order**

Run: `npx tsx scripts/test-live-boost-layers.ts`
Expected: clamp section all `ok:`, boost smoke prints observations, `all passed` at the end.

Run: `npx tsx scripts/test-live-channels-registry.ts`
Expected: both rows `[OK]`, exit 0.

Run: `npx tsx scripts/test-live-cron-dry-run.ts`
Expected: distributions printed per Task 10 Step 2 spot-check.

- [ ] **Step 4: Confirm cron file imports no TV layers**

Use Grep on `app/api/cron/daily-discovery-live/route.ts` with pattern `applyBroadcastBoost|tagBroadcastEvidence|applyRecentBroadcastPenalty|applyCompetitorTrendBoost|applyEvidenceBonus|computeTvEvidence`.
Expected: no matches.

- [ ] **Step 5: Confirm LIVE_CHANNELS has exactly 2 entries**

Use Grep with pattern `slug:` on `lib/discovery/live-channels.ts` and count matches.
Expected: 2.

- [ ] **Step 6: Working-tree clean check**

Run: `git status`
Expected: `nothing to commit, working tree clean` (or only pre-existing unstaged changes — the `ContextSubTabs.tsx` modification from the start of the session is unrelated to this plan and should stay as-is).

If the working tree is clean for the plan's scope, the implementation is ready for human review and deployment.
