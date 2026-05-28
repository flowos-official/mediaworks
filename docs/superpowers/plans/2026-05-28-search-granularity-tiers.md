# Search Granularity Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make free-text MD strategy search understand 4 granularity tiers (broad / seasonal / genre / specific_keyword) so "包丁" stops returning 16/17 non-knife items.

**Architecture:** Extend `runGoalAnalysis` JSON output with 3 new fields (`intent_tier`, `channel_scope[]`, `specific_keyword` w/ aliases). Route ALL callers of `runGoalAnalysis` through a single helper `lib/strategy/intent-projection.ts` that reads `PHASE_0_5_SEARCH_INTENT_ENABLED`. Tier-4 turns off pool fail-open, suppresses broadened fallback at `lib/md-strategy.ts:931`, and replaces the diversity instruction in the Gemini curation prompt with an "exact match" directive.

**Tech Stack:** TypeScript, Next.js 16 App Router, Supabase Postgres + RLS, Gemini for goal analysis + curation, Rakuten + Brave for fresh search, Zod for skill schema validation, tsx scripts for tests, npm scripts via `package.json`.

**Spec:** `docs/superpowers/specs/2026-05-28-search-granularity-tiers-design.md`

---

## File Structure

**New files (5)**:
- `lib/strategy/feature-flags.ts` — dependency-free flag reader (`isPhase05Enabled`). Separated to avoid an `intent-projection ↔ md-strategy` import cycle (Codex round 3 finding)
- `lib/strategy/intent-projection.ts` — single chokepoint helper that wraps `runGoalAnalysis` + projects `ParsedGoal` → extended `DiscoverIntent`
- `lib/strategy/alias-blocklist.ts` — ~30 broad Japanese terms that must never appear as a `specific_keyword.aliases` entry
- `lib/strategy/channel-aliases.ts` — maps free-text channel mentions ("テレビ東京マート") to registry slugs ("txd")
- `lib/discovery/channel-taste.ts` — `loadChannelTasteProfile` + `loadChannelTasteProfiles` (Section 5 of spec)

**Modified files (20)**:
- `lib/strategy/discover-intent.ts` — extended `DiscoverIntent` type, normalize/derive helpers, buildIntentSearchQueries, formatIntentPromptSection
- `lib/md-strategy.ts` — `ParsedGoal` type (line 259), `runGoalAnalysis` (1845), curation prompt diversity instruction (1122), broadened fallback suppression (931-959), `runMDSkill` short-circuit (2601-2602)
- `lib/strategy/pool-query.ts` — `applyFilters` tier-4 branch (line 71)
- `lib/strategy/preliminary-discovery.ts` — accept intent params (line 65)
- `lib/workflows/md-strategy.workflow.ts` — pre-run + LC mirror projection
- `lib/workflows/live-commerce.workflow.ts` — LC intent projection
- `lib/live-commerce-strategy.ts` — `ParsedGoal` mirror, LC goal-analysis prompt/parser/schema (lines 222, 487, 514, 529, 798)
- `lib/registry/skills/goal_analysis/v1/schema.ts` — sync stale schema + add new fields
- `lib/discovery/competitor-trend-boost.ts` — 3 signatures: `loadHotCompetitorCategories` (49), `loadCategoryFitWeights` (92), `applyCompetitorTrendBoost` (168)
- `app/api/analytics/discovery/route.ts` — route through `intent-projection`
- `app/api/analytics/md-strategy/[id]/rediscover/route.ts` — same
- `app/api/analytics/live-commerce/[id]/rediscover/route.ts` — same
- `components/analytics/MDStrategyPanel.tsx` — read-only intent chip

**Test scripts created**:
- `scripts/test-intent-classifier.ts`
- `scripts/test-pool-query-tier4.ts`
- `scripts/test-channel-taste.ts`
- `scripts/test-backward-compat-parsed-goal.ts`
- `scripts/test-runMDSkill-cache.ts`
- `scripts/test-tier4-fallback-suppression.ts`
- `scripts/test-intent-projection-flag.ts`
- `scripts/test-alias-blocklist.ts`
- `scripts/test-prompt-flag-gating.ts`
- `scripts/test-competitor-boost-channel-scope.ts`

**Env vars added**: `PHASE_0_5_SEARCH_INTENT_ENABLED` (default `"false"`)

---

## Phase 1 — Foundation Types

Goal: extend types so downstream changes compile. No behavior change.

### Task 1: Extend `DiscoverIntent` type

**Files:**
- Modify: `lib/strategy/discover-intent.ts:15-24` (the interface) and `:26-33` (emptyDiscoverIntent) and `:39-62` (normalizeDiscoverIntent)

- [ ] **Step 1: Add the 3 new fields to the interface**

Replace lines 14-24 with:

```ts
export type IntentTier = "broad" | "seasonal" | "genre" | "specific_keyword";

export interface ChannelScope {
  channel_slug: string;
  raw_mention: string;
  confidence: number;
}

export interface SpecificKeyword {
  raw: string;
  normalized: string;
  aliases: string[];
  confidence: number;
}

export interface DiscoverIntent {
  seasonal_keywords: string[];
  theme_keywords: string[];
  category_hints: string[];
  excluded_themes: string[];
  intent_tier: IntentTier;
  channel_scope: ChannelScope[];
  specific_keyword: SpecificKeyword | null;
}
```

- [ ] **Step 2: Update `emptyDiscoverIntent`**

```ts
export function emptyDiscoverIntent(): DiscoverIntent {
  return {
    seasonal_keywords: [],
    theme_keywords: [],
    category_hints: [],
    excluded_themes: [],
    intent_tier: "broad",
    channel_scope: [],
    specific_keyword: null,
  };
}
```

- [ ] **Step 3: Extend `normalizeDiscoverIntent` to accept the new fields**

Add this block after the existing array loop (before the final `return out;`):

```ts
// New fields — tier defaults to "broad"; channel_scope + specific_keyword normalize defensively
const tierRaw = obj["intent_tier"];
if (tierRaw === "broad" || tierRaw === "seasonal" || tierRaw === "genre" || tierRaw === "specific_keyword") {
  out.intent_tier = tierRaw;
}

const scopeRaw = obj["channel_scope"];
if (Array.isArray(scopeRaw)) {
  out.channel_scope = scopeRaw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      channel_slug: typeof x.channel_slug === "string" ? x.channel_slug.trim() : "",
      raw_mention: typeof x.raw_mention === "string" ? x.raw_mention.trim() : "",
      confidence: typeof x.confidence === "number" && x.confidence >= 0 && x.confidence <= 1 ? x.confidence : 0,
    }))
    .filter((c) => c.channel_slug.length > 0)
    .slice(0, 5);
}

const skRaw = obj["specific_keyword"];
if (skRaw && typeof skRaw === "object") {
  const sk = skRaw as Record<string, unknown>;
  const normalized = typeof sk.normalized === "string" ? sk.normalized.trim() : "";
  if (normalized.length > 0) {
    out.specific_keyword = {
      raw: typeof sk.raw === "string" ? sk.raw.trim() : normalized,
      normalized,
      aliases: Array.isArray(sk.aliases)
        ? sk.aliases.filter((s): s is string => typeof s === "string" && s.trim().length >= 2).map((s) => s.trim()).slice(0, 6)
        : [],
      confidence: typeof sk.confidence === "number" && sk.confidence >= 0 && sk.confidence <= 1 ? sk.confidence : 0,
    };
  }
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. Existing consumers reading the old 4 arrays still work; new fields are additive.

- [ ] **Step 5: Commit**

```bash
git add lib/strategy/discover-intent.ts
git commit -m "feat(strategy): extend DiscoverIntent with intent_tier, channel_scope, specific_keyword"
```

### Task 2: Mirror `ParsedGoal` in MD strategy

**Files:**
- Modify: `lib/md-strategy.ts:259-272`

- [ ] **Step 1: Add the new fields to ParsedGoal**

After existing `excluded_themes: string[];` line, add:

```ts
  intent_tier: import("./strategy/discover-intent").IntentTier;
  channel_scope: import("./strategy/discover-intent").ChannelScope[];
  specific_keyword: import("./strategy/discover-intent").SpecificKeyword | null;
```

(Or hoist the import to the top — preferred. Add `import type { IntentTier, ChannelScope, SpecificKeyword } from "./strategy/discover-intent";` alongside the existing imports around line 17-24.)

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/md-strategy.ts
git commit -m "feat(strategy): mirror new intent fields in MD ParsedGoal type"
```

### Task 3: Mirror in LC `ParsedGoal`

**Files:**
- Modify: `lib/live-commerce-strategy.ts:222-228`

- [ ] **Step 1: Add same 3 fields**

Same pattern as Task 2. Add three lines to the LC ParsedGoal interface and import the types.

- [ ] **Step 2: Type-check and commit**

```bash
npx tsc --noEmit && git add lib/live-commerce-strategy.ts && git commit -m "feat(strategy): mirror new intent fields in LC ParsedGoal type"
```

### Task 4: Sync stale `goal_analysis` registry schema + add new fields

**Files:**
- Modify: `lib/registry/skills/goal_analysis/v1/schema.ts`

- [ ] **Step 1: Read current schema**

Read the file. Confirm if it uses Zod, plain interfaces, or another shape.

- [ ] **Step 2: Add the 4 existing intent arrays (currently missing) + 3 new fields**

If Zod: ensure schema uses `.optional()` on the new fields and is NOT `.strict()`. Add fields:

```ts
seasonal_keywords: z.array(z.string()).default([]),
theme_keywords: z.array(z.string()).default([]),
category_hints: z.array(z.string()).default([]),
excluded_themes: z.array(z.string()).default([]),
intent_tier: z.enum(["broad", "seasonal", "genre", "specific_keyword"]).default("broad"),
channel_scope: z.array(z.object({
  channel_slug: z.string(),
  raw_mention: z.string(),
  confidence: z.number().min(0).max(1),
})).default([]),
specific_keyword: z.object({
  raw: z.string(),
  normalized: z.string(),
  aliases: z.array(z.string()).max(6).default([]),
  confidence: z.number().min(0).max(1),
}).nullable().default(null),
```

Use `.passthrough()` or remove any `.strict()` so legacy fields don't break.

- [ ] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit && git add lib/registry/skills/goal_analysis/v1/schema.ts
git commit -m "feat(skills): sync goal_analysis schema with runtime + add Phase 0.5 fields"
```

### Task 5: Create `alias-blocklist.ts`

**Files:**
- Create: `lib/strategy/alias-blocklist.ts`

- [ ] **Step 1: Write the file**

```ts
/**
 * Broad Japanese category terms that must never appear as a
 * `specific_keyword.aliases` entry. The Gemini classifier is instructed
 * not to emit these, but Gemini compliance is not guaranteed — this
 * deterministic blocklist filters them out post-parse.
 *
 * Keep additions narrow: only category-level nouns that would dilute the
 * tier-4 hard filter. Product-level terms (包丁, ナイフ, ヒーター) MUST NOT
 * appear here.
 */
export const ALIAS_BLOCKLIST: ReadonlySet<string> = new Set([
  // Broad consumer-goods categories
  "キッチン用品",
  "キッチン",
  "家電",
  "家電・雑貨",
  "電気機器",
  "電化製品",
  "服",
  "アパレル",
  "ファッション",
  "靴",
  "バッグ",
  "食品",
  "食料品",
  "美容",
  "化粧品",
  "コスメ",
  "ビューティ",
  "寝具",
  "インテリア",
  "雑貨",
  "生活雑貨",
  "ホーム",
  "ホーム・キッチン",
  "フィットネス",
  "健康食品",
  "医療機器",
  "ジュエリー",
  "宝飾",
  "ゴルフ",
  "アウトドア",
  "その他",
]);

export function filterAliases(aliases: string[], categoryHints: string[]): {
  kept: string[];
  dropped: string[];
} {
  const hintSet = new Set(categoryHints.map((h) => h.trim()));
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const a of aliases) {
    const trimmed = a.trim();
    if (trimmed.length < 2) {
      dropped.push(trimmed);
      continue;
    }
    if (ALIAS_BLOCKLIST.has(trimmed)) {
      dropped.push(trimmed);
      continue;
    }
    if (hintSet.has(trimmed)) {
      dropped.push(trimmed);
      continue;
    }
    kept.push(trimmed);
  }
  return { kept, dropped };
}
```

- [ ] **Step 2: Type-check + commit**

```bash
npx tsc --noEmit && git add lib/strategy/alias-blocklist.ts
git commit -m "feat(strategy): add alias blocklist for deterministic over-broad alias filtering"
```

### Task 6: Create `channel-aliases.ts`

**Files:**
- Create: `lib/strategy/channel-aliases.ts`

- [ ] **Step 1: Write the file**

```ts
import { TV_CHANNELS } from "@/lib/discovery/tv-channels";

/**
 * Free-text channel mentions → canonical registry slug.
 * Used by runGoalAnalysis to normalize channel_scope.channel_slug.
 *
 * Source of truth for slugs: lib/discovery/tv-channels.ts (16 channels).
 * Slugs not in TV_CHANNELS are rejected (resolveChannelSlug returns null).
 */
const ALIAS_MAP: Record<string, string> = {
  // QVC
  "qvc": "qvc",
  "qvcジャパン": "qvc",
  "qvc japan": "qvc",
  // Shop Channel
  "shop channel": "shopch",
  "ショップチャンネル": "shopch",
  "shopch": "shopch",
  // テレ東マート (canonical: txd — verify against tv-channels.ts)
  "テレ東マート": "txd",
  "テレビ東京マート": "txd",
  "txd": "txd",
  // Japanet
  "japanet": "japanet",
  "ジャパネット": "japanet",
  "ジャパネットたかた": "japanet",
  // Dinos
  "dinos": "dinos",
  "ディノス": "dinos",
  // Ropping
  "ropping": "ropping",
  "ロッピング": "ropping",
  // Senobura
  "senobura": "senobura",
  "せのぶら": "senobura",
  // NTV (日テレポシュレ)
  "ntv": "ntv",
  "日テレ": "ntv",
  "日テレポシュレ": "ntv",
  "ポシュレ": "ntv",
  // TBS (グッとライフ)
  "tbs": "tbs",
  "グッとライフ": "tbs",
  // kachimo, kaidoki, kantv, ichiban — verify slugs against tv-channels.ts
};

const VALID_SLUGS = new Set(TV_CHANNELS.map((c) => c.slug));

export function resolveChannelSlug(rawMention: string): string | null {
  const lower = rawMention.trim().toLowerCase();
  const mapped = ALIAS_MAP[lower] ?? ALIAS_MAP[rawMention.trim()];
  if (mapped && VALID_SLUGS.has(mapped)) return mapped;
  // Direct slug match (e.g. user typed "qvc")
  if (VALID_SLUGS.has(lower)) return lower;
  return null;
}
```

- [ ] **Step 2: Verify "txd" slug against tv-channels.ts**

Run: `grep -n "txd\|テレ東" lib/discovery/tv-channels.ts`

If the slug differs, update `ALIAS_MAP` and the spec accordingly. **DO NOT INVENT A SLUG** — only map to slugs that actually exist in `TV_CHANNELS`.

- [ ] **Step 3: Commit**

```bash
npx tsc --noEmit && git add lib/strategy/channel-aliases.ts
git commit -m "feat(strategy): add channel alias resolver for free-text channel mentions"
```

---

## Phase 2 — Single Chokepoint Helper + Feature Flag

Goal: create the helper that every caller of `runGoalAnalysis` will route through. Flag-off behavior is identical to today.

### Task 7a: Create `feature-flags.ts` (dependency-free flag reader)

**Files:**
- Create: `lib/strategy/feature-flags.ts`

- [ ] **Step 1: Write the file**

```ts
/**
 * Dependency-free feature flag readers. Kept separate from intent-projection.ts
 * to avoid an import cycle: md-strategy.ts (which defines runGoalAnalysis) must
 * read the flag during prompt selection, but intent-projection.ts (which wraps
 * runGoalAnalysis) also reads the flag. Putting the flag here breaks the cycle.
 */
export function isPhase05Enabled(): boolean {
  return process.env.PHASE_0_5_SEARCH_INTENT_ENABLED === "true";
}
```

- [ ] **Step 2: Commit**

```bash
npx tsc --noEmit && git add lib/strategy/feature-flags.ts
git commit -m "feat(strategy): add dependency-free feature-flags module for Phase 0.5"
```

### Task 7: Create `intent-projection.ts`

**Files:**
- Create: `lib/strategy/intent-projection.ts`

- [ ] **Step 1: Write the helper**

```ts
import type { DiscoverIntent } from "./discover-intent";
import { emptyDiscoverIntent, normalizeDiscoverIntent } from "./discover-intent";
import { isPhase05Enabled } from "./feature-flags";
import type { ParsedGoal } from "@/lib/md-strategy";
import { runGoalAnalysis } from "@/lib/md-strategy";

/**
 * Project ParsedGoal → DiscoverIntent.
 *
 * Single chokepoint for the Phase 0.5 feature flag. Callers (workflow,
 * runMDSkill, LC workflow, the 3 direct API routes) MUST route through
 * either this function or analyzeGoalToIntent() below. CI grep guard
 * enforces this — see docs/superpowers/specs/.../§9-1.
 *
 * When flag is off: returns legacy 4-array DiscoverIntent with
 * intent_tier='broad', channel_scope=[], specific_keyword=null. Behavior
 * matches pre-Phase-0.5 code paths.
 */
export function projectParsedGoalToIntent(
  parsedGoal: ParsedGoal | null | undefined,
): DiscoverIntent {
  if (!parsedGoal) return emptyDiscoverIntent();

  const legacyOnly: DiscoverIntent = {
    seasonal_keywords: parsedGoal.seasonal_keywords ?? [],
    theme_keywords: parsedGoal.theme_keywords ?? [],
    category_hints: parsedGoal.category_hints ?? [],
    excluded_themes: parsedGoal.excluded_themes ?? [],
    intent_tier: "broad",
    channel_scope: [],
    specific_keyword: null,
  };

  if (!isPhase05Enabled()) return legacyOnly;

  return normalizeDiscoverIntent({
    ...legacyOnly,
    intent_tier: parsedGoal.intent_tier ?? "broad",
    channel_scope: parsedGoal.channel_scope ?? [],
    specific_keyword: parsedGoal.specific_keyword ?? null,
  });
}

/**
 * Wraps runGoalAnalysis + projectParsedGoalToIntent into a single call.
 * Direct API routes (discovery, MD rediscover, LC rediscover) MUST use
 * this instead of calling runGoalAnalysis themselves — otherwise the
 * grep guard (Task 33) will fail the build.
 *
 * Returns both the ParsedGoal (for persistence) and the projected
 * DiscoverIntent (for the downstream pipeline) in one shot.
 */
export async function analyzeGoalToIntent(
  userGoal: string,
): Promise<{ parsedGoal: ParsedGoal; intent: DiscoverIntent }> {
  const parsedGoal = await runGoalAnalysis(userGoal);
  const intent = projectParsedGoalToIntent(parsedGoal);
  return { parsedGoal, intent };
}
```

- [ ] **Step 2: Type-check + commit**

```bash
npx tsc --noEmit && git add lib/strategy/intent-projection.ts
git commit -m "feat(strategy): add intent-projection helper as Phase 0.5 flag chokepoint"
```

### Task 8: Test the projection helper

**Files:**
- Create: `scripts/test-intent-projection-flag.ts`
- Modify: `package.json` (add `test:intent-projection-flag` script)

- [ ] **Step 1: Write failing test**

`scripts/test-intent-projection-flag.ts`:

```ts
import { projectParsedGoalToIntent } from "@/lib/strategy/intent-projection";

const fullGoal = {
  primary_objective: "",
  target_channels: [],
  seasonal_keywords: ["冬"],
  theme_keywords: ["防寒"],
  category_hints: ["暖房家電"],
  excluded_themes: [],
  intent_tier: "specific_keyword" as const,
  channel_scope: [{ channel_slug: "qvc", raw_mention: "QVC", confidence: 1.0 }],
  specific_keyword: { raw: "包丁", normalized: "包丁", aliases: ["ナイフ"], confidence: 0.95 },
};

// Flag off → tier=broad, channel_scope=[], specific_keyword=null
process.env.PHASE_0_5_SEARCH_INTENT_ENABLED = "false";
const off = projectParsedGoalToIntent(fullGoal);
if (off.intent_tier !== "broad") throw new Error(`flag off → tier should be 'broad', got ${off.intent_tier}`);
if (off.channel_scope.length !== 0) throw new Error(`flag off → channel_scope should be empty`);
if (off.specific_keyword !== null) throw new Error(`flag off → specific_keyword should be null`);
if (off.seasonal_keywords[0] !== "冬") throw new Error(`flag off → legacy 4 arrays still preserved`);

// Flag on → all new fields preserved
process.env.PHASE_0_5_SEARCH_INTENT_ENABLED = "true";
const on = projectParsedGoalToIntent(fullGoal);
if (on.intent_tier !== "specific_keyword") throw new Error(`flag on → tier mismatch`);
if (on.channel_scope[0]?.channel_slug !== "qvc") throw new Error(`flag on → channel_scope mismatch`);
if (on.specific_keyword?.normalized !== "包丁") throw new Error(`flag on → specific_keyword mismatch`);

// Null input → empty
const nullInput = projectParsedGoalToIntent(null);
if (nullInput.intent_tier !== "broad") throw new Error(`null input → tier should be 'broad'`);

console.log("✓ intent-projection-flag tests pass");
```

Add to `package.json` scripts:

```json
"test:intent-projection-flag": "tsx --env-file=.env.local scripts/test-intent-projection-flag.ts",
```

- [ ] **Step 2: Run test (expect PASS — helper already exists from Task 7)**

```bash
npm run test:intent-projection-flag
```

Expected: `✓ intent-projection-flag tests pass`

- [ ] **Step 3: Commit**

```bash
git add scripts/test-intent-projection-flag.ts package.json
git commit -m "test(strategy): add intent-projection flag gating test"
```

---

## Phase 3 — Goal Analysis Classifier (Prompt Extension + Alias Guard)

Goal: make Gemini emit the 3 new fields when the flag is on. Flag-off keeps the legacy prompt.

### Task 9: Add prompt-level flag gating to `runGoalAnalysis`

**Files:**
- Modify: `lib/md-strategy.ts:1845-1922 runGoalAnalysis`

- [ ] **Step 1: Split into two prompt builders**

Add at module level (above `runGoalAnalysis`):

```ts
// IMPORTANT: import isPhase05Enabled from feature-flags.ts (NOT intent-projection.ts)
// to avoid circular import — intent-projection.ts already imports from this file.
import { isPhase05Enabled } from "@/lib/strategy/feature-flags";
import { filterAliases } from "@/lib/strategy/alias-blocklist";
import { resolveChannelSlug } from "@/lib/strategy/channel-aliases";

function buildGoalPromptLegacy(userGoal: string): string {
  // REFACTOR INSTRUCTION (not a placeholder):
  // (1) Open lib/md-strategy.ts and locate the `const prompt = ` template literal
  //     currently inside runGoalAnalysis (lines 1846-1895).
  // (2) MOVE that entire template literal — unchanged — into this function body
  //     as the return value. The `${userGoal}` interpolation already works because
  //     this function takes the same `userGoal` parameter.
  // (3) The original `const prompt = ...` line in runGoalAnalysis is removed
  //     (replaced by a call to either buildGoalPromptLegacy or buildGoalPromptExtended,
  //     see Step 2 below).
  //
  // This is a literal cut-and-paste, not paraphrasing. Any wording change would shift
  // Gemini output for the legacy 4 arrays (seasonal_keywords etc.) — breaking the
  // byte-identical flag-off guarantee from spec §9-3.
  throw new Error("buildGoalPromptLegacy: refactor incomplete — move the existing prompt template here");
}

function buildGoalPromptExtended(userGoal: string): string {
  // Same as legacy, but with additional EXTRACTION RULES + EXAMPLES + JSON schema fields.
  return `You are a business strategy analyst for a Japanese TV-shopping / EC merchandising team.
Parse the following user goal into structured components AND extract discovery signals (season,
theme, category hints) AND classify search granularity (tier, channel scope, specific keyword).

User Goal: ${userGoal}

Return a JSON object (no markdown) with this exact structure:
{
  "primary_objective": "主要な目的を1文で（日本語）",
  "target_channels": ["対象チャネル名のリスト"],
  "target_revenue": "目標売上 (なければ null)",
  "target_audience": "ターゲット層 (なければ null)",
  "budget_constraint": "予算制約 (なければ null)",
  "timeline": "タイムライン (なければ null)",
  "seasonal_keywords": ["季節/タイミングを表す短い日本語キーワード"],
  "theme_keywords": ["商品テーマを表す短い日本語キーワード"],
  "category_hints": ["想定される具体的な商品カテゴリ"],
  "excluded_themes": ["目標と矛盾するため除外すべきテーマ"],
  "intent_tier": "broad" | "seasonal" | "genre" | "specific_keyword",
  "channel_scope": [{"channel_slug": "...", "raw_mention": "...", "confidence": 0.0-1.0}],
  "specific_keyword": {"raw": "...", "normalized": "...", "aliases": ["...(max 6)"], "confidence": 0.0-1.0} | null
}

EXTRACTION RULES:
- seasonal_keywords: 「冬/夏/春/秋/年末/年始/クリスマス/ハロウィン/バレンタイン/お歳暮/お中元/梅雨/花粉/新生活/防災」など。
- theme_keywords: 「暖かい/防寒/時短/ギフト/健康/美容」など。
- category_hints: 楽天/Amazonで検索した時にヒットする粒度のカテゴリ語 (3〜6個推奨)。
- excluded_themes: ユーザー目標と明らかに矛盾するもの。
- intent_tier:
  * "specific_keyword": 特定の単一品目名が明示された場合 (包丁/ホットカーペット/EMS 等)。
  * "genre": 広域カテゴリのみ指定 (フィットネス/美容家電 等)。
  * "seasonal": 季節/イベントのみ指定 (冬の商品/お歳暮 等)。
  * "broad": 上記いずれにも該当しない (「잘 팔리는 상품」「人気の商品」等)。
  複合シグナルは最も narrow な tier を選ぶ。他の軸 (季節 + チャネル等) は同時に他フィールドへ抽出する。
- channel_scope.confidence: 正確なチャネル名一致→1.0、表記揺れ→0.8、曖昧→<0.5 (<0.5 は出力しない)。
- specific_keyword.confidence: 単一の narrow な品目名→≥0.9、広いカテゴリを品目と誤認した場合→<0.7。
- specific_keyword.aliases:
  * 最大6個まで、カタカナ/ひらがな/英語/中国漢字の同義語を含める。
  * 広いカテゴリ語 (キッチン用品/家電/服 等) は絶対に含めない。
  * 例: 包丁 → ["ナイフ","knife","キッチンナイフ","三徳包丁","菜切り","ペティナイフ"]

EXAMPLES:
- 「テレ東マートで売れる包丁」 →
  intent_tier: "specific_keyword"
  channel_scope: [{"channel_slug":"txd","raw_mention":"テレ東マート","confidence":0.9}]
  specific_keyword: {"raw":"包丁","normalized":"包丁","aliases":["ナイフ","knife","キッチンナイフ","三徳包丁","菜切り","ペティナイフ"],"confidence":0.95}
  category_hints: ["キッチン用品","包丁"]

- 「QVCで冬に売れる暖房家電」 →
  intent_tier: "genre"
  channel_scope: [{"channel_slug":"qvc","raw_mention":"QVC","confidence":1.0}]
  specific_keyword: null
  seasonal_keywords: ["冬"]
  category_hints: ["暖房家電","ヒーター","電気ストーブ"]

- 「冬に売れる商品」 →
  intent_tier: "seasonal"
  channel_scope: []
  specific_keyword: null
  seasonal_keywords: ["冬"]

IMPORTANT:
- すべてのテキストは日本語。
- 配列は null ではなく [] を返す。
- target_revenue / target_audience / budget_constraint / timeline は未言及なら null。`;
}
```

- [ ] **Step 2: Rewrite `runGoalAnalysis` body to pick prompt + parse new fields + alias guard**

Replace the body (everything after the function signature on line 1845) with:

```ts
export async function runGoalAnalysis(userGoal: string): Promise<ParsedGoal> {
  const useExtended = isPhase05Enabled();
  const prompt = useExtended ? buildGoalPromptExtended(userGoal) : buildGoalPromptLegacy(userGoal);

  const raw = await callGemini(prompt);
  const parsed = parseJSON<Partial<ParsedGoal>>(raw);

  const intent = ensureDiscoverIntent(
    {
      seasonal_keywords: Array.isArray(parsed.seasonal_keywords) ? parsed.seasonal_keywords : [],
      theme_keywords: Array.isArray(parsed.theme_keywords) ? parsed.theme_keywords : [],
      category_hints: Array.isArray(parsed.category_hints) ? parsed.category_hints : [],
      excluded_themes: Array.isArray(parsed.excluded_themes) ? parsed.excluded_themes : [],
    },
    userGoal,
  );

  // Phase 0.5 extraction (only when flag on AND gemini returned the new fields)
  let intent_tier: ParsedGoal["intent_tier"] = "broad";
  let channel_scope: ParsedGoal["channel_scope"] = [];
  let specific_keyword: ParsedGoal["specific_keyword"] = null;

  if (useExtended) {
    const tier = parsed.intent_tier;
    if (tier === "broad" || tier === "seasonal" || tier === "genre" || tier === "specific_keyword") {
      intent_tier = tier;
    }

    if (Array.isArray(parsed.channel_scope)) {
      channel_scope = parsed.channel_scope
        .map((c) => {
          const slug = resolveChannelSlug(c?.raw_mention ?? c?.channel_slug ?? "");
          if (!slug) return null;
          const conf = typeof c?.confidence === "number" ? c.confidence : 0;
          if (conf < 0.5) return null;  // ambiguous mentions dropped
          return { channel_slug: slug, raw_mention: c.raw_mention ?? slug, confidence: conf };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .slice(0, 5);
    }

    if (parsed.specific_keyword && parsed.specific_keyword.normalized) {
      const raw = parsed.specific_keyword.raw ?? parsed.specific_keyword.normalized;
      const normalized = parsed.specific_keyword.normalized;
      const rawAliases = Array.isArray(parsed.specific_keyword.aliases)
        ? parsed.specific_keyword.aliases.filter((s): s is string => typeof s === "string")
        : [];
      const conf = typeof parsed.specific_keyword.confidence === "number" ? parsed.specific_keyword.confidence : 0;

      // Deterministic alias guard — drop over-broad terms even if Gemini emitted them
      const { kept, dropped } = filterAliases(rawAliases, intent.category_hints);
      if (dropped.length > 0) {
        console.warn(`[goal-analysis] alias guard dropped ${dropped.length}: ${dropped.join(", ")}`);
      }

      // Confidence-based downgrade: <0.7 means tier→genre (not specific_keyword)
      if (conf >= 0.7) {
        specific_keyword = { raw, normalized, aliases: kept.slice(0, 6), confidence: conf };
      } else {
        console.warn(`[goal-analysis] specific_keyword confidence ${conf} < 0.7, downgrading tier to 'genre'`);
        if (intent_tier === "specific_keyword") intent_tier = "genre";
        specific_keyword = null;
      }
    }
  }

  const result: ParsedGoal = {
    primary_objective: typeof parsed.primary_objective === "string" ? parsed.primary_objective : "",
    target_channels: Array.isArray(parsed.target_channels)
      ? parsed.target_channels.filter((c): c is string => typeof c === "string")
      : [],
    target_revenue: typeof parsed.target_revenue === "string" ? parsed.target_revenue : undefined,
    target_audience: typeof parsed.target_audience === "string" ? parsed.target_audience : undefined,
    budget_constraint: typeof parsed.budget_constraint === "string" ? parsed.budget_constraint : undefined,
    timeline: typeof parsed.timeline === "string" ? parsed.timeline : undefined,
    seasonal_keywords: intent.seasonal_keywords,
    theme_keywords: intent.theme_keywords,
    category_hints: intent.category_hints,
    excluded_themes: intent.excluded_themes,
    intent_tier,
    channel_scope,
    specific_keyword,
  };

  console.log(`[goal-analysis] userGoal="${userGoal.slice(0, 60)}" tier=${intent_tier} channels=[${channel_scope.map((c) => c.channel_slug).join(",")}] specific="${specific_keyword?.normalized ?? "—"}" confidence=${specific_keyword?.confidence ?? "—"}`);

  return result;
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add lib/md-strategy.ts
git commit -m "feat(strategy): extend runGoalAnalysis with Phase 0.5 classification + alias guard"
```

### Task 10: Alias blocklist test

**Files:**
- Create: `scripts/test-alias-blocklist.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the test**

```ts
import { filterAliases } from "@/lib/strategy/alias-blocklist";

const r1 = filterAliases(
  ["ナイフ", "キッチン用品", "包丁", "1", "knife"],
  ["キッチン用品"]
);
if (!r1.kept.includes("ナイフ")) throw new Error("kept should include ナイフ");
if (!r1.kept.includes("包丁")) throw new Error("kept should include 包丁");
if (!r1.kept.includes("knife")) throw new Error("kept should include knife");
if (r1.kept.includes("キッチン用品")) throw new Error("blocklist should drop キッチン用品");
if (r1.kept.includes("1")) throw new Error("length < 2 should be dropped");
if (r1.dropped.length !== 2) throw new Error(`expected 2 dropped, got ${r1.dropped.length}`);

console.log("✓ alias-blocklist tests pass");
```

Add script: `"test:alias-blocklist": "tsx scripts/test-alias-blocklist.ts"`

- [ ] **Step 2: Run + commit**

```bash
npm run test:alias-blocklist && git add scripts/test-alias-blocklist.ts package.json
git commit -m "test(strategy): alias blocklist filters over-broad + length-1 aliases"
```

### Task 11: Prompt flag gating test

**Files:**
- Create: `scripts/test-prompt-flag-gating.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the test**

This requires mocking `callGemini`. If a mock layer doesn't exist, the test can shell out to a static fixture. Simpler approach: assert that with flag off, the returned ParsedGoal has `intent_tier='broad'`, `channel_scope=[]`, `specific_keyword=null`, regardless of input.

```ts
import { runGoalAnalysis } from "@/lib/md-strategy";

process.env.PHASE_0_5_SEARCH_INTENT_ENABLED = "false";

// Use a goal that WOULD trigger tier=specific_keyword if flag were on
const result = await runGoalAnalysis("テレ東マートで売れる包丁");

if (result.intent_tier !== "broad") {
  throw new Error(`flag off → tier should be 'broad', got ${result.intent_tier}`);
}
if (result.channel_scope.length !== 0) {
  throw new Error(`flag off → channel_scope should be empty`);
}
if (result.specific_keyword !== null) {
  throw new Error(`flag off → specific_keyword should be null`);
}
console.log("✓ prompt-flag-gating test passes");
```

Add script: `"test:prompt-flag-gating": "tsx --env-file=.env.local scripts/test-prompt-flag-gating.ts"`

NOTE: this test makes a real Gemini call (~1-2s). That's acceptable for a single smoke check.

- [ ] **Step 2: Run + commit**

```bash
npm run test:prompt-flag-gating && git add scripts/test-prompt-flag-gating.ts package.json
git commit -m "test(strategy): verify flag-off prompt path produces legacy-only output"
```

---

## Phase 4 — Pre-run Wiring + `runMDSkill` Cache Short-circuit

Goal: make intent available to `runPreliminaryDiscoveryStep`. Stop double-billing Gemini.

### Task 12: Modify `runMDSkill` to short-circuit when `ctx.parsedGoal` is set

**Files:**
- Modify: `lib/md-strategy.ts:2596-2603 runMDSkill`

- [ ] **Step 1: Replace lines 2601-2602**

Before:

```ts
if (skillName === "goal_analysis") {
  return context.userGoal ? await runGoalAnalysis(context.userGoal) : null;
}
```

After:

```ts
if (skillName === "goal_analysis") {
  // Short-circuit: if pre-run already populated ctx.parsedGoal, reuse it
  // to avoid double Gemini call + classification drift between runs.
  if (context.parsedGoal) {
    return context.parsedGoal;
  }
  return context.userGoal ? await runGoalAnalysis(context.userGoal) : null;
}
```

(Verify `StrategyContext` has a `parsedGoal?` field. If not, add it as `parsedGoal?: ParsedGoal;` to the interface near line 263-280.)

- [ ] **Step 2: Type-check + commit**

```bash
npx tsc --noEmit && git add lib/md-strategy.ts
git commit -m "fix(strategy): short-circuit runMDSkill goal_analysis when parsedGoal is cached"
```

### Task 13: Cache short-circuit test

**Files:**
- Create: `scripts/test-runMDSkill-cache.ts`
- Modify: `package.json`

- [ ] **Step 1: Write test**

```ts
import { runMDSkill } from "@/lib/md-strategy";

const cachedGoal = {
  primary_objective: "test",
  target_channels: [],
  seasonal_keywords: [],
  theme_keywords: [],
  category_hints: [],
  excluded_themes: [],
  intent_tier: "broad" as const,
  channel_scope: [],
  specific_keyword: null,
};

const ctx = {
  userGoal: "テレ東マートで売れる包丁",
  parsedGoal: cachedGoal,
  // ... minimal stub for StrategyContext — fill the required fields
} as any;

const before = Date.now();
const out = await runMDSkill("goal_analysis", ctx, {});
const ms = Date.now() - before;

if (out !== cachedGoal) throw new Error("expected the cached object to be returned");
if (ms > 50) throw new Error(`expected near-instant return (no Gemini call), got ${ms}ms`);

console.log("✓ runMDSkill-cache test passes");
```

Add script: `"test:runMDSkill-cache": "tsx --env-file=.env.local scripts/test-runMDSkill-cache.ts"`

- [ ] **Step 2: Run + commit**

```bash
npm run test:runMDSkill-cache && git add scripts/test-runMDSkill-cache.ts package.json
git commit -m "test(strategy): runMDSkill returns cached parsedGoal without Gemini call"
```

### Task 14: Pre-run `runGoalAnalysis` in workflow before preliminary discovery

**Files:**
- Modify: `lib/workflows/md-strategy.workflow.ts:307-312` (around the fetchContextStep / runPreliminaryDiscoveryStep transition)

- [ ] **Step 1: Add a pre-run step using the chokepoint helper**

Locate the workflow function that orchestrates the steps (around line 302). Between `fetchContextStep(input)` and `runPreliminaryDiscoveryStep(input, ctx)`, insert:

```ts
// Phase 0.5: pre-run goal_analysis so preliminary discovery has intent
if (input.userGoal) {
  try {
    const { parsedGoal } = await analyzeGoalToIntent(input.userGoal);
    ctx.parsedGoal = parsedGoal;
  } catch (err) {
    console.warn(`[workflow] pre-run goal_analysis failed, continuing without intent: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

**Use `analyzeGoalToIntent` (NOT `runGoalAnalysis` directly)** — the workflow is one of the 5 caller sites that must route through the chokepoint per spec §9-1. Calling `runGoalAnalysis` here would fail the Task 33 grep guard.

Make sure `analyzeGoalToIntent` is imported at the top of the file:

```ts
import { analyzeGoalToIntent } from "@/lib/strategy/intent-projection";
```

- [ ] **Step 2: PRE-REQUISITE — extend `PoolQueryInput` type FIRST**

Task 15 will further use these fields in `applyFilters` logic, but the **type additions must land in this step** to avoid a compile break at Step 3 below.

In `lib/strategy/pool-query.ts:22-36` (PoolQueryInput interface), add:

```ts
intentTier?: "broad" | "seasonal" | "genre" | "specific_keyword";
specificKeyword?: string;
specificAliases?: string[];
```

Also extend the internal `FilterOptions` type (lines 63-69) with the same three optional fields. Do NOT change `applyFilters` logic yet — that's Task 15. This step only adds type fields so subsequent compile passes succeed.

Run `npx tsc --noEmit` and verify no errors.

- [ ] **Step 3: Modify `PreliminaryDiscoveryInput` to accept intent**

In `lib/strategy/preliminary-discovery.ts:17-23`, add:

```ts
intent?: import("./discover-intent").DiscoverIntent;
```

In `runPreliminaryDiscovery` (around line 65), where it calls `queryDiscoveredPool`, pass:

```ts
intentKeywords: input.intent ? deriveIntentKeywords(input.intent) : undefined,
specificKeyword: input.intent?.specific_keyword?.normalized,
specificAliases: input.intent?.specific_keyword?.aliases ?? [],
intentTier: input.intent?.intent_tier ?? "broad",
```

Add the `deriveIntentKeywords` import at the top.

- [ ] **Step 4: Thread intent into `runPreliminaryDiscoveryStep` call site**

In the workflow, modify the call to `runPreliminaryDiscoveryStep` to include the intent derived from `ctx.parsedGoal`:

```ts
const intent = projectParsedGoalToIntent(ctx.parsedGoal);
await runPreliminaryDiscoveryStep({ ...input, intent }, ctx);
```

(Adjust to match the actual function signature.)

- [ ] **Step 5: Type-check + commit**

```bash
npx tsc --noEmit && git add lib/workflows/md-strategy.workflow.ts lib/strategy/preliminary-discovery.ts lib/strategy/pool-query.ts
git commit -m "feat(workflow): pre-run runGoalAnalysis + thread intent through preliminary discovery + extend PoolQueryInput types"
```

---

## Phase 5 — Tier-4 Hard Filter (Core Fix)

Goal: make "包丁" actually return knives.

### Task 15: Pool query tier-4 branch (fail-open OFF + substring match)

**Files:**
- Modify: `lib/strategy/pool-query.ts:35-185`

- [ ] **Step 1: Verify types already added in Task 14 Step 2**

The 3 new fields on `PoolQueryInput` + `FilterOptions` should already be present from Task 14 Step 2. If not, add them now (see Task 14 Step 2). The remainder of this task only changes behavior, not types.

- [ ] **Step 2: Rewrite `applyFilters` to branch on tier**

Insert a tier-4 branch BEFORE the R4.5 fail-open block (around line 97-110):

```ts
// Tier 4 — specific_keyword: hard substring match, fail-open OFF
if (
  opts.intentTier === "specific_keyword" &&
  opts.specificKeyword
) {
  const needles = [opts.specificKeyword, ...(opts.specificAliases ?? [])]
    .map((s) => s.toLowerCase().trim())
    .filter((s) => s.length >= 2);
  if (needles.length > 0) {
    afterIntent = afterCategory.filter((r) => {
      const hay = `${r.name ?? ""} ${r.category ?? ""}`.toLowerCase();
      return needles.some((n) => hay.includes(n));
    });
    console.log(`[pool-query] tier=specific_keyword fail_open=off match_count=${afterIntent.length}`);
    // Skip the regular R4.5 fail-open block — fall through to price filter
    return applyPriceFilter(afterIntent, opts);
  }
}
```

Extract the existing R5 (price) filter into a helper `applyPriceFilter(rows, opts)` to share between tiers. (Refactor: lines 113-120 become a function.)

- [ ] **Step 3: Plumb the new fields through `queryDiscoveredPool`**

In `queryDiscoveredPool` (line 129), forward the 3 new fields into `applyFilters`:

```ts
const filtered = applyFilters(rows, {
  context: input.context,
  uiCategory: input.uiCategory,
  priceRange: input.priceRange,
  supplementCategories: input.supplementCategoriesFromSeeds,
  intentKeywords: input.intentKeywords,
  intentTier: input.intentTier,
  specificKeyword: input.specificKeyword,
  specificAliases: input.specificAliases,
});
```

- [ ] **Step 4: Type-check + commit**

```bash
npx tsc --noEmit && git add lib/strategy/pool-query.ts
git commit -m "fix(pool): tier-4 hard substring filter, fail-open OFF for specific_keyword"
```

### Task 16: Pool tier-4 test

**Files:**
- Create: `scripts/test-pool-query-tier4.ts`
- Modify: `package.json`

- [ ] **Step 1: Write test using the existing applyFilters test pattern**

Reference `scripts/test-pool-query-filters.ts` for the existing pattern. Use the exported `__test.applyFilters`:

```ts
import { __test } from "@/lib/strategy/pool-query";

const rows = [
  { name: "三徳包丁 鋼", category: "キッチン用品", context: "home_shopping", user_action: null, /* ...other required fields */ } as any,
  { name: "ナイフ研ぎ器", category: "キッチン用品", context: "home_shopping", user_action: null } as any,
  { name: "電気ストーブ", category: "家電・雑貨", context: "home_shopping", user_action: null } as any,
  { name: "保温マグ", category: "キッチン用品", context: "home_shopping", user_action: null } as any,
];

// Tier 4: only items containing "包丁" or "ナイフ" pass
const r1 = __test.applyFilters(rows, {
  context: "home_shopping",
  intentTier: "specific_keyword",
  specificKeyword: "包丁",
  specificAliases: ["ナイフ"],
});

if (r1.length !== 2) throw new Error(`expected 2 knives, got ${r1.length}: ${r1.map((x) => x.name)}`);
if (!r1.some((x) => x.name.includes("包丁"))) throw new Error("包丁 not found");
if (!r1.some((x) => x.name.includes("ナイフ"))) throw new Error("ナイフ not found");

// Single match (below R4.5 fail-open threshold) should still return 1, not fall back
const r2 = __test.applyFilters(rows.slice(0, 1).concat(rows.slice(2)), {
  context: "home_shopping",
  intentTier: "specific_keyword",
  specificKeyword: "包丁",
  specificAliases: [],
});
if (r2.length !== 1) throw new Error(`fail-open should be OFF for tier 4; expected 1, got ${r2.length}`);

console.log("✓ pool-query-tier4 tests pass");
```

Add script: `"test:pool-query-tier4": "tsx --env-file=.env.local scripts/test-pool-query-tier4.ts"`

- [ ] **Step 2: Run + commit**

```bash
npm run test:pool-query-tier4 && git add scripts/test-pool-query-tier4.ts package.json
git commit -m "test(pool): tier-4 substring filter + fail-open suppression"
```

### Task 17: Update `buildIntentSearchQueries` for tier 4

**Files:**
- Modify: `lib/strategy/discover-intent.ts:138-171 buildIntentSearchQueries`

- [ ] **Step 1: Add tier-aware branch**

Change the signature:

```ts
export function buildIntentSearchQueries(
  intent: DiscoverIntent | null | undefined,
  maxQueries = 4,
): string[]
```

Add at the top of the body (after the null guard):

```ts
// Tier 4 — specific_keyword takes precedence; aliases as 2nd query only
if (intent.intent_tier === "specific_keyword" && intent.specific_keyword) {
  const sk = intent.specific_keyword;
  return [sk.normalized, ...sk.aliases.slice(0, Math.max(0, maxQueries - 1))].slice(0, maxQueries);
}
```

Leave the existing season × theme × category logic for tiers 1-3.

- [ ] **Step 2: Type-check + commit**

```bash
npx tsc --noEmit && git add lib/strategy/discover-intent.ts
git commit -m "feat(strategy): buildIntentSearchQueries tier-4 returns specific_keyword + aliases"
```

### Task 18: Update `formatIntentPromptSection` for tier 4

**Files:**
- Modify: `lib/strategy/discover-intent.ts:177-199 formatIntentPromptSection`

- [ ] **Step 1: Add tier-4 block**

Inside the function, after parts assembly and before the final return, add:

```ts
if (intent.intent_tier === "specific_keyword" && intent.specific_keyword) {
  const sk = intent.specific_keyword;
  parts.push(
    `特定品目指定: ${sk.normalized} (別名: ${sk.aliases.join("、") || "なし"})`
  );
  parts.push(
    `[TIER 4 INSTRUCTION] ユーザーは特定品目を指定。該当商品のみ選定し、カテゴリ多様化は禁止。商品名に「${sk.normalized}」または別名のいずれかを含まない候補は除外すること。`
  );
}

if (intent.channel_scope.length > 0) {
  parts.push(
    `チャネル適合: ${intent.channel_scope.map((c) => c.raw_mention).join("、")} (これらのチャネルで売れそうな商品を優先)`
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
npx tsc --noEmit && git add lib/strategy/discover-intent.ts
git commit -m "feat(strategy): formatIntentPromptSection adds tier-4 + channel scope blocks"
```

### Task 19: Suppress broadened fallback at `md-strategy.ts:931-959`

**Files:**
- Modify: `lib/md-strategy.ts:931-959 discoverNewProducts` (fallback block)

- [ ] **Step 1: Wrap the fallback in a tier-4 guard**

The current block starts with `if (freshCapped.length === 0 && cappedPool.length === 0) {` at line 931. Modify to:

```ts
if (freshCapped.length === 0 && cappedPool.length === 0) {
  // Tier-4 suppression: returning fewer-but-correct > diluting with broad keywords
  if (input.intent?.intent_tier === "specific_keyword") {
    console.warn(`[discover] pool empty under tier=specific_keyword — NOT broadening; returning empty fresh set`);
  } else {
    console.warn(`[discover] pool empty — retrying with broadened keywords`);
    const fallbackKeywords = ["人気商品", "売れ筋", "おすすめ"];
    // ... existing block (lines 933-958)
  }
}
```

- [ ] **Step 2: Type-check + commit**

```bash
npx tsc --noEmit && git add lib/md-strategy.ts
git commit -m "fix(discover): suppress broadened fallback when tier=specific_keyword"
```

### Task 20: Tier-4 fallback suppression test

**Files:**
- Create: `scripts/test-tier4-fallback-suppression.ts`
- Modify: `package.json`

- [ ] **Step 1: Write integration-style test (mocks heavy here; smoke test with empty pool is easier)**

Because mocking `rakutenItemSearch` + `braveSearchStructured` would need significant scaffolding, this test exercises the guard via direct call: construct a `DiscoverInput` with `intent.intent_tier = 'specific_keyword'` and a very narrow keyword that should yield empty Rakuten + Brave results. Assert `discoverNewProducts` returns `undefined` or empty array, NOT padded with "人気商品" fallback items.

```ts
import { discoverNewProducts } from "@/lib/md-strategy";

const tier4Input = {
  context: "home_shopping" as const,
  explicitCategory: undefined,
  topCategoryNames: [],
  tvMarginRate: 30,
  tvProductNames: [],
  excludeUrls: [],
  excludeNames: [],
  intent: {
    seasonal_keywords: [],
    theme_keywords: [],
    category_hints: [],
    excluded_themes: [],
    intent_tier: "specific_keyword" as const,
    channel_scope: [],
    specific_keyword: {
      raw: "zzzunlikelyxxx",
      normalized: "zzzunlikelyxxx",
      aliases: [],
      confidence: 0.95,
    },
  },
  lightweight: true,
};

const result = await discoverNewProducts(tier4Input as any);

// Result should be undefined or empty — NOT padded with 人気商品/売れ筋/おすすめ fallback items
if (result && result.length > 0) {
  const padded = result.some((r: any) => r.keyword === "fallback" || /人気商品|売れ筋|おすすめ/.test(r.name ?? ""));
  if (padded) throw new Error(`tier=specific_keyword should suppress broadened fallback, found ${padded ? "padded" : "ok"} items`);
}
console.log("✓ tier4-fallback-suppression test passes (empty/non-broadened result)");
```

Add script: `"test:tier4-fallback-suppression": "tsx --env-file=.env.local scripts/test-tier4-fallback-suppression.ts"`

- [ ] **Step 2: Run + commit**

```bash
npm run test:tier4-fallback-suppression && git add scripts/test-tier4-fallback-suppression.ts package.json
git commit -m "test(discover): verify broadened fallback suppressed under tier=specific_keyword"
```

### Task 21: Update curation prompt diversity instruction

**Files:**
- Modify: `lib/md-strategy.ts:1122 curation prompt`

- [ ] **Step 1: Make the diversity line conditional**

Locate the string template containing `カテゴリが偏らないように${itemCount}商品を選定。`. The variable building this prompt runs inside `discoverNewProducts`; find where the prompt is assembled (around line 1105-1125).

Replace:

```ts
- カテゴリが偏らないように${itemCount}商品を選定。
```

with:

```ts
- ${input.intent?.intent_tier === "specific_keyword" 
    ? "ユーザー指定品目に一致する商品を最優先で選定。多様性より一致が優先。"
    : `カテゴリが偏らないように${itemCount}商品を選定。`}
```

- [ ] **Step 2: Also suppress TV broad keyword weight in tier 4**

Around lines 687-692 (where `keywords` are assembled):

```ts
const tvKeywords = input.intent?.intent_tier === "specific_keyword"
  ? []  // Tier 4: no broad TV category keywords
  : [input.explicitCategory, ...input.topCategoryNames].filter((s): s is string => !!s && s.trim().length > 0);
```

- [ ] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit && git add lib/md-strategy.ts
git commit -m "fix(discover): tier-4 replaces diversity instruction + suppresses TV broad keywords"
```

---

## Phase 6 — Channel Scope (Taste Profile)

Goal: when user mentions a channel, use that channel's calendar data as a fit signal.

### Task 22: Create `channel-taste.ts`

**Files:**
- Create: `lib/discovery/channel-taste.ts`

- [ ] **Step 1: Write the loader**

```ts
import { getServiceClient } from "@/lib/supabase";

export interface ChannelTasteProfile {
  channel_slug: string;
  source_tier: 1 | 2 | 3 | 4;
  category_weights: Map<string, { raw_share: number; fit_score: number | null; final_weight: number }>;
  sample_size: number;
  reasoning: string;
}

const QVC_SHOPCH = new Set(["qvc", "shopch"]);

export async function loadChannelTasteProfile(
  channelSlug: string,
  lookbackDays: number = 30,
): Promise<ChannelTasteProfile> {
  const sb = getServiceClient();
  const sinceIso = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);

  // Tier 1 — QVC/ShopCh: broadcasts.category direct query
  if (QVC_SHOPCH.has(channelSlug)) {
    const { data, error } = await sb
      .from("broadcasts")
      .select("category")
      .eq("channel", channelSlug)
      .gte("air_date", sinceIso)
      .not("category", "is", null);
    if (error || !data) {
      return emptyProfile(channelSlug, 4, `query failed: ${error?.message ?? "no data"}`);
    }
    return buildProfile(channelSlug, 1, data.map((r) => r.category as string), `Tier 1 (broadcasts.category) — ${data.length} rows`);
  }

  // Tier 2 — OA channels: historical_broadcasts.category
  const { data: histRows, error: histErr } = await sb
    .from("historical_broadcasts")
    .select("category")
    .eq("channel", channelSlug)
    .gte("air_date", sinceIso);
  if (histErr) {
    return emptyProfile(channelSlug, 4, `historical_broadcasts query failed: ${histErr.message}`);
  }
  if (histRows && histRows.length > 0) {
    const populated = histRows.filter((r) => r.category !== null);
    const nullRate = 1 - populated.length / histRows.length;
    if (nullRate < 0.9) {
      return buildProfile(
        channelSlug,
        2,
        populated.map((r) => r.category as string),
        `Tier 2 (historical_broadcasts.category) — ${populated.length}/${histRows.length} rows populated`,
      );
    }
    // Tier 3 fallthrough — too many NULLs
  }

  // Tier 3 — discovered_products fallback
  const { data: discRows, error: discErr } = await sb
    .from("discovered_products")
    .select("category")
    .ilike("tv_channel_source", `%${channelSlug}%`)
    .not("category", "is", null)
    .gte("created_at", new Date(Date.now() - lookbackDays * 86_400_000).toISOString());
  if (discErr || !discRows || discRows.length === 0) {
    return emptyProfile(channelSlug, 4, `Tier 3 fallback empty (discovered_products)`);
  }
  return buildProfile(channelSlug, 3, discRows.map((r) => r.category as string), `Tier 3 (discovered_products fallback) — ${discRows.length} rows`);
}

export async function loadChannelTasteProfiles(
  channelSlugs: string[],
  lookbackDays: number = 30,
): Promise<Map<string, ChannelTasteProfile>> {
  const profiles = await Promise.all(
    channelSlugs.map((slug) => loadChannelTasteProfile(slug, lookbackDays)),
  );
  return new Map(profiles.map((p) => [p.channel_slug, p]));
}

function buildProfile(channelSlug: string, sourceTier: 1 | 2 | 3, categories: string[], reasoning: string): ChannelTasteProfile {
  const counts = new Map<string, number>();
  for (const c of categories) {
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const total = categories.length || 1;
  const weights = new Map<string, { raw_share: number; fit_score: number | null; final_weight: number }>();
  for (const [cat, count] of counts) {
    const raw_share = count / total;
    weights.set(cat, { raw_share, fit_score: null, final_weight: raw_share });
  }
  return {
    channel_slug: channelSlug,
    source_tier: sourceTier,
    category_weights: weights,
    sample_size: categories.length,
    reasoning,
  };
}

function emptyProfile(channelSlug: string, sourceTier: 4, reasoning: string): ChannelTasteProfile {
  return {
    channel_slug: channelSlug,
    source_tier: sourceTier,
    category_weights: new Map(),
    sample_size: 0,
    reasoning,
  };
}
```

Note: fit_score weighting (operator_fit_score from `competitor_fit_analyses`) is added in Task 25.

- [ ] **Step 2: Type-check + commit**

```bash
npx tsc --noEmit && git add lib/discovery/channel-taste.ts
git commit -m "feat(discovery): add channel-taste profile loader (tier 1/2/3/4 fallback)"
```

### Task 23: Channel taste test

**Files:**
- Create: `scripts/test-channel-taste.ts`
- Modify: `package.json`

- [ ] **Step 1: Write test (hits real DB)**

```ts
import { loadChannelTasteProfile } from "@/lib/discovery/channel-taste";

// Tier 1 — QVC should have category data
const qvc = await loadChannelTasteProfile("qvc", 30);
if (qvc.source_tier !== 1) throw new Error(`expected QVC source_tier=1, got ${qvc.source_tier}`);
if (qvc.sample_size === 0) throw new Error(`QVC should have broadcasts.category populated`);

// Tier 4 — unknown channel
const unknown = await loadChannelTasteProfile("zzz_unknown", 30);
if (unknown.source_tier !== 4) throw new Error(`unknown channel should be tier 4`);
if (unknown.sample_size !== 0) throw new Error(`unknown channel sample_size should be 0`);

console.log(`✓ channel-taste: qvc tier=${qvc.source_tier} samples=${qvc.sample_size}, unknown tier=${unknown.source_tier}`);
```

Add: `"test:channel-taste": "tsx --env-file=.env.local scripts/test-channel-taste.ts"`

- [ ] **Step 2: Run + commit**

```bash
npm run test:channel-taste && git add scripts/test-channel-taste.ts package.json
git commit -m "test(discovery): channel-taste tier 1 (QVC) + tier 4 (unknown) selection"
```

### Task 24: Extend competitor-trend-boost signatures with `channelScope`

**Files:**
- Modify: `lib/discovery/competitor-trend-boost.ts:49 loadHotCompetitorCategories`, `:92 loadCategoryFitWeights`, `:168 applyCompetitorTrendBoost`

- [ ] **Step 1: Read current signatures**

Read lines 40-180 of `lib/discovery/competitor-trend-boost.ts` to confirm function shapes. NOTE the current code uses direct chained queries (no intermediate `q` variable), so adding `.in("channel", ...)` conditionally requires introducing a builder variable.

- [ ] **Step 2: Refactor `loadHotCompetitorCategories` to accept `channelScope`**

Current (line 59-63):

```ts
const { data, error } = await sb
  .from("broadcasts")
  .select("category")
  .gte("air_date", cutoff)
  .not("category", "is", null);
```

Change the function signature to `loadHotCompetitorCategories(channelScope?: string[])` and rewrite the query:

```ts
let q = sb
  .from("broadcasts")
  .select("category")
  .gte("air_date", cutoff)
  .not("category", "is", null);
if (channelScope && channelScope.length > 0) {
  q = q.in("channel", channelScope);
}
const { data, error } = await q;
```

- [ ] **Step 3: Refactor `loadCategoryFitWeights` the same way**

Current (line 100-104):

```ts
const { data, error } = await sb
  .from("competitor_fit_analyses")
  .select("category, fit_score")
  .gte("created_at", cutoff)
  .not("category", "is", null);
```

Change to:

```ts
let q = sb
  .from("competitor_fit_analyses")
  .select("category, fit_score")
  .gte("created_at", cutoff)
  .not("category", "is", null);
if (channelScope && channelScope.length > 0) {
  q = q.in("channel", channelScope);
}
const { data, error } = await q;
```

Signature: `loadCategoryFitWeights(channelScope?: string[])`.

- [ ] **Step 4: Extend `applyCompetitorTrendBoost` public entrypoint**

At line 168, change signature to `applyCompetitorTrendBoost(candidates, channelScope?: string[])`. Inside the body, where it calls `loadHotCompetitorCategories()` and `loadCategoryFitWeights()`, pass `channelScope` through:

```ts
const [hot, fitWeights] = await Promise.all([
  loadHotCompetitorCategories(channelScope),
  loadCategoryFitWeights(channelScope),
]);
```

- [ ] **Step 5: Type-check + commit**

```bash
npx tsc --noEmit && git add lib/discovery/competitor-trend-boost.ts
git commit -m "feat(discovery): thread channelScope through competitor-trend-boost (3 signatures)"
```

### Task 25: Wire `channel_scope` into `discoverNewProducts`

**Files:**
- Modify: `lib/md-strategy.ts discoverNewProducts` (after fresh search merge, before Gemini curation — around lines 900-970)

- [ ] **Step 1: Add channel taste application**

Just before the Gemini curation prompt assembly (around line 970-1006), inject:

```ts
if (input.intent?.channel_scope && input.intent.channel_scope.length > 0) {
  try {
    const slugs = input.intent.channel_scope.map((c) => c.channel_slug);
    const profiles = await loadChannelTasteProfiles(slugs, 30);
    for (const item of cappedPool) {
      const cat = item.category ?? null;
      if (!cat) continue;
      let boost = 0;
      let strongest: string | null = null;
      for (const profile of profiles.values()) {
        const w = profile.category_weights.get(cat);
        if (!w) continue;
        const scale = profile.source_tier === 3 ? 0.5 : 1.0;
        const contribution = w.final_weight * 30 * scale;  // up to +30 per top-share category
        if (contribution > boost) {
          boost = contribution;
          strongest = profile.channel_slug;
        }
      }
      if (boost > 0 && strongest) {
        item.tv_fit_score = Math.min(100, (item.tv_fit_score ?? 50) + Math.round(boost));
        const annotation = ` [${strongest} taste fit: ${cat}]`;
        item.tv_fit_reason = (item.tv_fit_reason ?? "") + annotation;
      }
    }
    console.log(`[discover] channel-taste applied across ${profiles.size} profiles`);
  } catch (err) {
    console.warn(`[discover] channel-taste failed (continuing without boost): ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

Make sure `loadChannelTasteProfiles` is imported at the top.

- [ ] **Step 2: Wire `channelScope` into `applyCompetitorTrendBoost` call**

Search the codebase for `applyCompetitorTrendBoost(` and add `, input.intent?.channel_scope?.map(c => c.channel_slug)` to the call sites in strategy paths (NOT the daily cron — cron uses unscoped boost).

- [ ] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit && git add lib/md-strategy.ts
git commit -m "feat(discover): apply channel-taste boost + channel-scoped competitor trend"
```

### Task 26: competitor-boost channel-scope test

**Files:**
- Create: `scripts/test-competitor-boost-channel-scope.ts`
- Modify: `package.json`

- [ ] **Step 1: Write test (hits real DB; verifies SQL gets channel filter)**

```ts
import { loadHotCompetitorCategories, loadCategoryFitWeights } from "@/lib/discovery/competitor-trend-boost";

// Without scope — returns global categories
const global = await loadHotCompetitorCategories();
// With scope — should be subset
const scoped = await loadHotCompetitorCategories(["qvc"]);

if (scoped.length > global.length) throw new Error("scoped should be ≤ global");

const fitGlobal = await loadCategoryFitWeights();
const fitScoped = await loadCategoryFitWeights(["qvc"]);
if (fitScoped.size > fitGlobal.size) throw new Error("scoped fit map should be ≤ global");

console.log(`✓ competitor-boost-channel-scope: global=${global.length}, scoped=${scoped.length}`);
```

Add: `"test:competitor-boost-channel-scope": "tsx --env-file=.env.local scripts/test-competitor-boost-channel-scope.ts"`

- [ ] **Step 2: Run + commit**

```bash
npm run test:competitor-boost-channel-scope && git add scripts/test-competitor-boost-channel-scope.ts package.json
git commit -m "test(discovery): competitor trend boost respects channelScope filter"
```

---

## Phase 7 — Caller Refactor (3 Direct API Routes + LC Chain)

Goal: route every `runGoalAnalysis` caller through `intent-projection.ts` and extend LC.

### Task 27: Reroute `app/api/analytics/discovery/route.ts`

**Files:**
- Modify: `app/api/analytics/discovery/route.ts:94-120`

- [ ] **Step 1: Replace direct `runGoalAnalysis` call with `analyzeGoalToIntent`**

The CI grep guard (Task 33) forbids direct `runGoalAnalysis` calls outside `intent-projection.ts`. This route currently calls it at line 110.

Find the block at lines 108-120 (the `if (effectiveUserGoal)` try/catch around `runGoalAnalysis` + manual intent projection).

Replace with:

```ts
import { analyzeGoalToIntent } from "@/lib/strategy/intent-projection";

// ... inside the route handler:
let intent: DiscoverIntent | undefined;
if (effectiveUserGoal) {
  try {
    const { intent: projected } = await analyzeGoalToIntent(effectiveUserGoal);
    intent = projected;
  } catch (err) {
    console.warn(
      `[discovery-route] goal analysis failed, falling back to no-intent discovery: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
```

Remove the manual `parsed.seasonal_keywords ?? []` projection lines (108-116) — `analyzeGoalToIntent` handles all of this internally. Remove the `import { runGoalAnalysis } from "@/lib/md-strategy";` import if it's no longer used elsewhere in this file.

- [ ] **Step 2: Type-check + commit**

```bash
npx tsc --noEmit && git add app/api/analytics/discovery/route.ts
git commit -m "refactor(api): route discovery endpoint through analyzeGoalToIntent chokepoint"
```

### Task 28: Reroute MD rediscover route

**Files:**
- Modify: `app/api/analytics/md-strategy/[id]/rediscover/route.ts:89-115`

- [ ] **Step 1: Apply the same refactor as Task 27**

Find the block around lines 100-115 (the `if (effectiveUserGoal)` try/catch). Replace direct `runGoalAnalysis(effectiveUserGoal)` + manual projection with `analyzeGoalToIntent(effectiveUserGoal)`. Remove the now-unused `runGoalAnalysis` import.

- [ ] **Step 2: Commit**

```bash
npx tsc --noEmit && git add app/api/analytics/md-strategy/\[id\]/rediscover/route.ts
git commit -m "refactor(api): route md-strategy rediscover through analyzeGoalToIntent chokepoint"
```

### Task 29: Reroute LC rediscover route

**⚠️ EXECUTION ORDER**: This task depends on `analyzeLCGoalToIntent` which is created in Task 30. **Execute Task 30 BEFORE Task 29** (Task 30 Step 4 adds the helper; this task consumes it). If executing sequentially in numbered order, swap 29↔30 mentally.

**Files:**
- Modify: `app/api/analytics/live-commerce/[id]/rediscover/route.ts:82-110` (approximate — mirror MD pattern)

- [ ] **Step 1: Read the LC rediscover route and apply same refactor**

If LC uses `runGoalAnalysis` (the MD function), use `analyzeGoalToIntent` from Task 27. If LC uses its OWN goal-analysis function (likely — see Task 30 Step 4 which adds `analyzeLCGoalToIntent` to `intent-projection.ts`), use that LC-specific helper instead. Either way, the direct call must be replaced with a chokepoint helper.

- [ ] **Step 2: Commit**

```bash
npx tsc --noEmit && git add app/api/analytics/live-commerce/\[id\]/rediscover/route.ts
git commit -m "refactor(api): route live-commerce rediscover through chokepoint helper"
```

### Task 30: Extend LC goal-analysis prompt/parser/schema + route through chokepoint

**Files:**
- Modify: `lib/live-commerce-strategy.ts:487 LC goal_analysis prompt`, `:514 parser`, `:529 returned shape`, `:798 LC runGoalAnalysis-equivalent`
- Modify: `lib/workflows/live-commerce.workflow.ts:54-61` (LC intent projection)
- Modify: `lib/strategy/intent-projection.ts` (extend with LC helper if LC's prompt differs)

- [ ] **Step 1: Read lines 480-540 + line 798 to confirm LC's analog**

LC has its own goal_analysis function. Apply the same prompt-level flag gating + new field parsing + alias guard as MD's `runGoalAnalysis` (mirror Task 9 — `buildLCGoalPromptLegacy` + `buildLCGoalPromptExtended` split).

- [ ] **Step 2: Add the LC `intent_tier`/`channel_scope`/`specific_keyword` fields to LC's parsed result**

Mirror the MD pattern from Task 9 Step 2 — including the deterministic alias guard via `filterAliases(...)` from `lib/strategy/alias-blocklist.ts` and channel resolution via `resolveChannelSlug(...)` from `lib/strategy/channel-aliases.ts`.

- [ ] **Step 3: Route LC workflow projection through `projectParsedGoalToIntent`**

At `lib/workflows/live-commerce.workflow.ts:54-61`, REPLACE the existing manual 4-field enumeration with:

```ts
import { projectParsedGoalToIntent } from "@/lib/strategy/intent-projection";

// inside the workflow step where intent is constructed:
const intent = projectParsedGoalToIntent(parsedGoal);
```

This ensures LC honors the same flag chokepoint as MD. The CI grep guard in Task 33 will fail if `lib/workflows/live-commerce.workflow.ts` still calls `runGoalAnalysis` or constructs intent inline.

- [ ] **Step 4: If LC's goal-analysis function has a public-API surface, route it through `intent-projection.ts` too**

If `lib/live-commerce-strategy.ts:798` is itself a public-API equivalent of `runGoalAnalysis` callable from API routes, add an LC variant to `intent-projection.ts`:

```ts
export async function analyzeLCGoalToIntent(userGoal: string): Promise<{ parsedGoal: LCParsedGoal; intent: DiscoverIntent }> {
  const parsedGoal = await runLCGoalAnalysis(userGoal);  // LC's function
  const intent = projectParsedGoalToIntent(parsedGoal);  // works because LCParsedGoal mirrors MD shape (Task 3)
  return { parsedGoal, intent };
}
```

API route Task 29 (LC rediscover) calls `analyzeLCGoalToIntent` instead of `runLCGoalAnalysis` directly.

- [ ] **Step 5: Type-check + commit**

```bash
npx tsc --noEmit && git add lib/live-commerce-strategy.ts lib/workflows/live-commerce.workflow.ts lib/strategy/intent-projection.ts
git commit -m "feat(live-commerce): mirror Phase 0.5 classification + route through projection chokepoint"
```

---

## Phase 8 — UI Chip

Goal: surface the classifier result so operators can spot mis-classifications.

### Task 31: Add read-only intent chip to `MDStrategyPanel.tsx`

**Files:**
- Modify: `components/analytics/MDStrategyPanel.tsx`

- [ ] **Step 1: Add chip component above the results section**

Find the JSX node that renders results (the recommended products grid). Just above it, add:

```tsx
{results?.goal_analysis &&
  (results.goal_analysis.intent_tier !== "broad" ||
    (results.goal_analysis.channel_scope?.length ?? 0) > 0) && (
  <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
    <span className="font-medium text-foreground">検索意図:</span>
    {results.goal_analysis.intent_tier !== "broad" && (
      <span className="rounded bg-blue-500/10 px-2 py-0.5 text-blue-700">
        tier: {results.goal_analysis.intent_tier}
      </span>
    )}
    {results.goal_analysis.channel_scope?.map((c) => (
      <span key={c.channel_slug} className="rounded bg-purple-500/10 px-2 py-0.5 text-purple-700">
        ch: {c.raw_mention}{c.confidence < 0.8 && " (弱)"}
      </span>
    ))}
    {results.goal_analysis.specific_keyword && (
      <span className="rounded bg-green-500/10 px-2 py-0.5 text-green-700">
        keyword: {results.goal_analysis.specific_keyword.normalized}
        {results.goal_analysis.specific_keyword.aliases.length > 0 && ` (+${results.goal_analysis.specific_keyword.aliases.length})`}
      </span>
    )}
  </div>
)}
```

- [ ] **Step 2: Type-check + dev test**

```bash
npx tsc --noEmit
npm run dev
```

Visit `/analytics/md-strategy`, enter "テレ東マートで売れる包丁", verify chip renders with the expected fields.

- [ ] **Step 3: Commit**

```bash
git add components/analytics/MDStrategyPanel.tsx
git commit -m "feat(ui): add read-only search intent chip above strategy results"
```

---

## Phase 9 — Backward-Compat Test, CI Guard, Final Sweep

### Task 32: Backward-compat parsed-goal test

**Files:**
- Create: `scripts/test-backward-compat-parsed-goal.ts`
- Modify: `package.json`

- [ ] **Step 1: Write test**

```ts
import { projectParsedGoalToIntent } from "@/lib/strategy/intent-projection";

// Simulate a legacy saved ParsedGoal — no new fields
const legacy = {
  primary_objective: "test",
  target_channels: [],
  seasonal_keywords: ["冬"],
  theme_keywords: [],
  category_hints: [],
  excluded_themes: [],
  // intent_tier, channel_scope, specific_keyword missing
} as any;

process.env.PHASE_0_5_SEARCH_INTENT_ENABLED = "true";
const out = projectParsedGoalToIntent(legacy);

if (out.intent_tier !== "broad") throw new Error(`legacy → tier should default to 'broad', got ${out.intent_tier}`);
if (out.channel_scope.length !== 0) throw new Error(`legacy → channel_scope should be []`);
if (out.specific_keyword !== null) throw new Error(`legacy → specific_keyword should be null`);
if (out.seasonal_keywords[0] !== "冬") throw new Error(`legacy 4 arrays should still be carried over`);

console.log("✓ backward-compat-parsed-goal test passes");
```

Add: `"test:backward-compat-parsed-goal": "tsx scripts/test-backward-compat-parsed-goal.ts"`

- [ ] **Step 2: Run + commit**

```bash
npm run test:backward-compat-parsed-goal && git add scripts/test-backward-compat-parsed-goal.ts package.json
git commit -m "test(strategy): legacy ParsedGoal (missing Phase 0.5 fields) defaults to tier=broad"
```

### Task 33: CI grep guard (single chokepoint enforcement)

**Files:**
- Create: `scripts/check-runGoalAnalysis-callers.sh` (or `.ts` if shell scripts are not used)

- [ ] **Step 1: Write a grep gate**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Single chokepoint enforcement — runGoalAnalysis may only be called from
# lib/strategy/intent-projection.ts (which then projects the result to
# DiscoverIntent under the feature flag). Any other usage = leaked flag.

ALLOWED_FILE="lib/strategy/intent-projection.ts"
DEFINING_FILE_MD="lib/md-strategy.ts"
DEFINING_FILE_LC="lib/live-commerce-strategy.ts"

# Use git ls-files to scope the search to tracked files
VIOLATORS=$(git ls-files '*.ts' '*.tsx' \
  | grep -v "^$ALLOWED_FILE\$" \
  | grep -v "^$DEFINING_FILE_MD\$" \
  | grep -v "^$DEFINING_FILE_LC\$" \
  | xargs grep -l "runGoalAnalysis(\|runLCGoalAnalysis(" 2>/dev/null || true)

if [[ -n "$VIOLATORS" ]]; then
  echo "ERROR: runGoalAnalysis is called outside lib/strategy/intent-projection.ts:"
  echo "$VIOLATORS"
  echo ""
  echo "Route through projectParsedGoalToIntent() instead. See spec §9-1."
  exit 1
fi

echo "✓ runGoalAnalysis chokepoint enforced"
```

Make it executable: `chmod +x scripts/check-runGoalAnalysis-callers.sh`

Add to `package.json`:

```json
"check:chokepoint": "bash scripts/check-runGoalAnalysis-callers.sh",
```

- [ ] **Step 2: Run + fix any remaining violators**

```bash
npm run check:chokepoint
```

If any file is reported, that's a Phase 7 omission — fix the caller to route through `projectParsedGoalToIntent`.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-runGoalAnalysis-callers.sh package.json
git commit -m "ci(strategy): add chokepoint enforcement guard for runGoalAnalysis"
```

### Task 34: Full regression sweep

- [ ] **Step 1: Run the existing strategy regression battery (flag OFF, default)**

```bash
PHASE_0_5_SEARCH_INTENT_ENABLED=false npm run test:strategy-pool
```

Expected: all existing tests pass (`test:pool-query`, `test:multi-seed`, `test:discovery-pool-first`, `test:pool-fallback`, `test:discover-intent`, `test:source-attribution`).

- [ ] **Step 2: Run new test battery (flag ON)**

```bash
PHASE_0_5_SEARCH_INTENT_ENABLED=true npm run test:intent-projection-flag \
  && PHASE_0_5_SEARCH_INTENT_ENABLED=true npm run test:alias-blocklist \
  && PHASE_0_5_SEARCH_INTENT_ENABLED=true npm run test:pool-query-tier4 \
  && PHASE_0_5_SEARCH_INTENT_ENABLED=true npm run test:channel-taste \
  && PHASE_0_5_SEARCH_INTENT_ENABLED=true npm run test:competitor-boost-channel-scope \
  && PHASE_0_5_SEARCH_INTENT_ENABLED=true npm run test:backward-compat-parsed-goal \
  && PHASE_0_5_SEARCH_INTENT_ENABLED=true npm run test:runMDSkill-cache
```

Expected: all pass.

- [ ] **Step 3: Manual integration check (one-shot, real Gemini)**

```bash
PHASE_0_5_SEARCH_INTENT_ENABLED=true npm run test:prompt-flag-gating
PHASE_0_5_SEARCH_INTENT_ENABLED=true npm run test:tier4-fallback-suppression
```

These call live Gemini; expect 1-3s per test.

- [ ] **Step 4: Chokepoint guard**

```bash
npm run check:chokepoint
```

Expected: `✓ runGoalAnalysis chokepoint enforced`

- [ ] **Step 5: End-to-end smoke (manual)**

Open `npm run dev`. Navigate to MD strategy page. Enter `"テレ東マートで売れる包丁"`. Inspect:
- Network tab: response contains `intent_tier: "specific_keyword"`, `channel_scope[0].channel_slug: "txd"`, `specific_keyword.normalized: "包丁"` with non-empty aliases
- UI: intent chip rendered with tier + channel + keyword
- Results: at least 90% of cards contain "包丁" or one of the aliases in their name

- [ ] **Step 6: Final commit (if any cleanup)**

```bash
git status
# If anything uncommitted, review and commit. Otherwise:
echo "Phase 0.5 implementation complete."
```

---

## Rollout (Post-merge — not part of plan execution)

Per spec §9-3:

1. Merge with `PHASE_0_5_SEARCH_INTENT_ENABLED=false` (default).
2. Set flag to `true` in dev/staging for ≥ 1 week. Operators run "包丁" / "ホットカーペット" / "QVCで暖房家電" cases. Monitor `[goal-analysis]`, `[pool-query] tier=`, `[discover] channel-taste applied` logs.
3. Production flag flip. Verify saved-strategy reruns still default to broad.
4. After 2 weeks of stable production data: remove flag, delete `buildGoalPromptLegacy`, delete the flag check in `intent-projection.ts`, keep the helper as the chokepoint.

---

## Self-Review Notes

- **Spec coverage**: every §6 touchpoint maps to a numbered task: §6-1 → Tasks 1-2, 9, 12, 15-19, 21; §6-2 → Task 24; §6-3 → Tasks 3, 30; §6-4 → Tasks 27-29; §6-5 → Tasks 5-7, 22; §6-6 → Task 31. §9 flag gating → Tasks 7, 9, 27-29, 33. §11 tests → Tasks 8, 10, 11, 13, 16, 20, 23, 26, 32.
- **Type consistency**: `DiscoverIntent.intent_tier`, `ChannelScope.channel_slug`, `SpecificKeyword.aliases` named consistently across all tasks. `projectParsedGoalToIntent` is the single projection function name throughout.
- **TDD honored**: each Phase 5 fix (the core bug) has a test task immediately following (Tasks 15→16, 19→20). Foundation tasks (1-7) don't need TDD since they're type-level changes.
- **Frequent commits**: every task ends with a commit. Phases are independently shippable in worst case (flag stays off).
- **No placeholders**: every code block is concrete. The few "verify against existing pattern" steps (Task 6 step 2, Task 12 step 1, Task 24 step 1) are explicit checks an engineer needs to make against current code.
