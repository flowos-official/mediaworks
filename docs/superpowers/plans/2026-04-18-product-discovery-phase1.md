# Product Discovery Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage 1 Discovery 파이프라인의 코어 함수들과 DB 스키마를 구축하고, dry-run 스크립트로 end-to-end 검증 가능하게 한다.

**Architecture:** `lib/discovery/*` 모듈 (plan → pool → exclusion → curate) + Supabase 5개 테이블. 이 페이즈는 DB 저장 없이 콘솔 출력까지만 검증.

**Tech Stack:** Next.js 15 App Router / TypeScript / Supabase / Google Gemini 3-Flash / Rakuten Ichiba API / Brave Search API / tsx (scripts runner)

**Spec reference:** `docs/superpowers/specs/2026-04-18-product-discovery-redesign-design.md` — Phase 1 섹션과 Section 4-7.

**Out of scope for Phase 1:** API routes (cron/user), broadcast tagging (Stage 1 단계 7), save to DB (단계 8), UI, enrichment, learning cron.

---

## File Structure for Phase 1

**Create:**
```
supabase/migrations/2026-04-18_discovery_system.sql    -- 5개 테이블 마이그레이션
lib/discovery/types.ts                                 -- TypeScript 타입 정의
lib/discovery/exclusion.ts                             -- 제외 필터 3종
lib/discovery/plan.ts                                  -- 카테고리 플랜 (Gemini)
lib/discovery/pool.ts                                  -- Rakuten + Brave 풀 빌드
lib/discovery/curate.ts                                -- 큐레이션 (Gemini)
scripts/test-discovery-dry-run.ts                      -- end-to-end dry-run
```

**Modify:**
```
lib/brave.ts                                           -- braveSearch export 추가, braveSearchItems 추가
package.json                                           -- test:discovery 스크립트, tsx devDep
```

---

## Task 1: `lib/brave.ts` 확장 — `braveSearchItems` 추가

**Why:** 기존 `braveSearch`는 포맷된 문자열만 반환. 풀 빌드에는 구조화된 결과(title/description/url)가 필요.

**Files:**
- Modify: `lib/brave.ts`

- [ ] **Step 1: `braveSearchItems` 함수 추가 (파일 끝에 append)**

Edit `lib/brave.ts` — 파일 끝 126번 라인 뒤에 다음 블록 추가:

```typescript
export type BraveWebResult = {
	title: string;
	description: string;
	url: string;
};

/**
 * Structured Brave Web Search returning parsed result objects (vs. formatted string).
 * Used by discovery pool builder.
 */
export async function braveSearchItems(
	query: string,
	count = 10,
): Promise<BraveWebResult[]> {
	if (!BRAVE_API_KEY) return [];

	const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`;

	try {
		const res = await fetch(url, {
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "gzip",
				"X-Subscription-Token": BRAVE_API_KEY,
			},
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) {
			console.warn(`[brave items] ${res.status}`);
			return [];
		}
		const data = await res.json();
		const results: Array<{ title?: string; description?: string; url?: string }> =
			data.web?.results ?? [];
		return results.map((r) => ({
			title: r.title ?? "",
			description: r.description ?? "",
			url: r.url ?? "",
		}));
	} catch (err) {
		console.warn(
			"[brave items] fetch failed:",
			err instanceof Error ? err.message : String(err),
		);
		return [];
	}
}
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 기존 에러 외 추가 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add lib/brave.ts
git commit -m "feat(brave): add braveSearchItems for structured discovery pool building"
```

---

## Task 2: DB 마이그레이션 SQL 작성

**Files:**
- Create: `supabase/migrations/2026-04-18_discovery_system.sql`

- [ ] **Step 1: 마이그레이션 파일 생성**

Write to `supabase/migrations/2026-04-18_discovery_system.sql`:

```sql
-- Product Discovery Redesign — Phase 1 schema
-- Ref: docs/superpowers/specs/2026-04-18-product-discovery-redesign-design.md §7

-- 1. discovery_sessions ----------------------------------------------------
CREATE TABLE IF NOT EXISTS discovery_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','completed','partial','failed')),
  target_count int NOT NULL DEFAULT 30,
  produced_count int NOT NULL DEFAULT 0,
  category_plan jsonb,
  exploration_ratio numeric(3,2),
  iterations int NOT NULL DEFAULT 0,
  error text
);
CREATE INDEX IF NOT EXISTS idx_discovery_sessions_run_at
  ON discovery_sessions (run_at DESC);

-- 2. discovered_products ---------------------------------------------------
CREATE TABLE IF NOT EXISTS discovered_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES discovery_sessions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),

  name text NOT NULL,
  name_normalized text NOT NULL,
  thumbnail_url text,
  product_url text NOT NULL,
  price_jpy int,
  category text,
  source text NOT NULL CHECK (source IN ('rakuten','brave','other')),
  rakuten_item_code text,
  review_count int,
  review_avg numeric(2,1),
  seller_name text,
  stock_status text,

  tv_fit_score int CHECK (tv_fit_score BETWEEN 0 AND 100),
  tv_fit_reason text,
  broadcast_tag text CHECK (broadcast_tag IN ('broadcast_confirmed','broadcast_likely','unknown')),
  broadcast_sources jsonb,

  track text NOT NULL CHECK (track IN ('tv_proven','exploration')),
  is_tv_applicable boolean NOT NULL DEFAULT true,
  is_live_applicable boolean NOT NULL DEFAULT false,

  enrichment_status text NOT NULL DEFAULT 'idle'
    CHECK (enrichment_status IN ('idle','queued','running','completed','failed')),
  enrichment_started_at timestamptz,
  enrichment_completed_at timestamptz,
  c_package jsonb,
  enrichment_error text,

  user_action text CHECK (user_action IN ('sourced','interested','rejected','duplicate')),
  action_reason text,
  action_at timestamptz,

  UNIQUE (session_id, product_url)
);
CREATE INDEX IF NOT EXISTS idx_dp_created_at ON discovered_products (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dp_user_action ON discovered_products (user_action);
CREATE INDEX IF NOT EXISTS idx_dp_name_normalized ON discovered_products (name_normalized);
CREATE INDEX IF NOT EXISTS idx_dp_rakuten_item_code
  ON discovered_products (rakuten_item_code)
  WHERE rakuten_item_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dp_enrichment_status ON discovered_products (enrichment_status);

-- 3. product_feedback ------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovered_product_id uuid NOT NULL REFERENCES discovered_products(id) ON DELETE CASCADE,
  action text NOT NULL
    CHECK (action IN ('sourced','interested','rejected','duplicate','deep_dive')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pf_created_at ON product_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pf_action ON product_feedback (action);
CREATE INDEX IF NOT EXISTS idx_pf_product ON product_feedback (discovered_product_id);

-- 4. learning_state (singleton) -------------------------------------------
CREATE TABLE IF NOT EXISTS learning_state (
  id int PRIMARY KEY CHECK (id = 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  exploration_ratio numeric(3,2) NOT NULL DEFAULT 0.47,
  category_weights jsonb NOT NULL DEFAULT '{}'::jsonb,
  rejected_seeds jsonb NOT NULL
    DEFAULT '{"urls":[],"brands":[],"terms":[]}'::jsonb,
  recent_rejection_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  feedback_sample_size int NOT NULL DEFAULT 0,
  is_cold_start boolean NOT NULL DEFAULT true
);
INSERT INTO learning_state (id)
  VALUES (1)
  ON CONFLICT (id) DO NOTHING;

-- 5. learning_insights -----------------------------------------------------
CREATE TABLE IF NOT EXISTS learning_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sourced_count int,
  rejected_count int,
  top_rejection_reasons jsonb,
  sourced_product_patterns text,
  exploration_wins text,
  next_week_suggestions text,
  UNIQUE (week_start)
);
CREATE INDEX IF NOT EXISTS idx_li_week_start ON learning_insights (week_start DESC);
```

- [ ] **Step 2: 커밋**

```bash
git add supabase/migrations/2026-04-18_discovery_system.sql
git commit -m "feat(db): add discovery system schema (5 tables) for Phase 1"
```

---

## Task 3: Supabase Studio에서 마이그레이션 수동 실행

**Files:** (사용자 액션, 코드 변경 없음)

- [ ] **Step 1: Supabase Studio 접속**

https://supabase.com/dashboard → 프로젝트 선택 → **SQL Editor**.

- [ ] **Step 2: 마이그레이션 실행**

`supabase/migrations/2026-04-18_discovery_system.sql` 전체 내용을 복사해서 SQL Editor 에 붙여넣고 **Run**.

- [ ] **Step 3: 테이블 생성 확인**

Table Editor 에서 다음 5개 테이블이 있는지 확인:
- `discovery_sessions`
- `discovered_products`
- `product_feedback`
- `learning_state` (1개 row)
- `learning_insights`

`learning_state` 테이블에 `id=1, exploration_ratio=0.47, is_cold_start=true` row가 존재해야 함.

- [ ] **Step 4: 검증 쿼리**

SQL Editor 에서 실행:
```sql
SELECT id, exploration_ratio, is_cold_start FROM learning_state;
```
Expected: 1 row, id=1, exploration_ratio=0.47, is_cold_start=true.

---

## Task 4: `lib/discovery/types.ts` 작성

**Files:**
- Create: `lib/discovery/types.ts`

- [ ] **Step 1: 파일 생성**

Write to `lib/discovery/types.ts`:

```typescript
/**
 * Discovery pipeline types.
 * Ref: docs/superpowers/specs/2026-04-18-product-discovery-redesign-design.md §4
 */

export type Track = "tv_proven" | "exploration";
export type CandidateSource = "rakuten" | "brave" | "other";
export type BroadcastTag =
	| "broadcast_confirmed"
	| "broadcast_likely"
	| "unknown";
export type EnrichmentStatus =
	| "idle"
	| "queued"
	| "running"
	| "completed"
	| "failed";
export type UserAction =
	| "sourced"
	| "interested"
	| "rejected"
	| "duplicate";
export type SessionStatus =
	| "running"
	| "completed"
	| "partial"
	| "failed";

export interface CategoryPlan {
	tv_proven: string[];
	exploration: string[];
	reasoning?: string;
}

export interface PoolItem {
	name: string;
	productUrl: string;
	thumbnailUrl?: string;
	priceJpy?: number;
	reviewCount?: number;
	reviewAvg?: number;
	sellerName?: string;
	stockStatus?: string;
	source: CandidateSource;
	rakutenItemCode?: string;
	seedKeyword: string;
	track: Track;
}

export interface CurationScore {
	review_signal: number;
	tv_category_match: number;
	trend_signal: number;
	price_fit: number;
	purchase_signal: number;
	total: number;
}

export interface Candidate extends PoolItem {
	tvFitScore: number;
	tvFitReason: string;
	isTvApplicable: boolean;
	isLiveApplicable: boolean;
	scoreBreakdown: CurationScore;
}

export interface RejectedSeeds {
	urls: string[];
	brands: string[];
	terms: string[];
}

export interface LearningState {
	exploration_ratio: number;
	category_weights: Record<string, number>;
	rejected_seeds: RejectedSeeds;
	recent_rejection_reasons: Array<{ reason: string; count: number }>;
	feedback_sample_size: number;
	is_cold_start: boolean;
}

export interface ExclusionContext {
	ownSourcedNames: string[];
	recentDiscoveredUrls: Set<string>;
	crossSessionRakutenCodes: Set<string>;
	rejectedUrls: Set<string>;
	rejectedBrands: Set<string>;
	rejectedTerms: string[];
}

export const DEFAULT_LEARNING_STATE: LearningState = {
	exploration_ratio: 0.47,
	category_weights: {},
	rejected_seeds: { urls: [], brands: [], terms: [] },
	recent_rejection_reasons: [],
	feedback_sample_size: 0,
	is_cold_start: true,
};
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 추가 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add lib/discovery/types.ts
git commit -m "feat(discovery): add types for Phase 1 pipeline"
```

---

## Task 5: `lib/discovery/exclusion.ts` 작성

**Files:**
- Create: `lib/discovery/exclusion.ts`

- [ ] **Step 1: 파일 생성**

Write to `lib/discovery/exclusion.ts`:

```typescript
/**
 * Exclusion filters for discovery pool.
 * Ref: spec §4.2 단계 4.
 *
 * 3 filter layers:
 *  1. Own sourcing history (product_summaries) — fuzzy prefix match
 *  2. Last 7 days URLs + cross-session rakuten_item_code
 *  3. Rejected seeds from learning_state (urls / brands / terms)
 */

import { getServiceClient } from "@/lib/supabase";
import type {
	ExclusionContext,
	LearningState,
	PoolItem,
} from "./types";

const OWN_NAME_PREFIX_LEN = 8;
const RECENT_WINDOW_DAYS = 7;

/**
 * Normalize a product name for fuzzy comparison: lowercase, strip whitespace,
 * punctuation, brackets, and common separators. Truncate to 80 chars.
 */
export function normalizeName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[\s\u3000【】\[\]（）()「」『』・,．.、。!?！？]/g, "")
		.slice(0, 80);
}

/**
 * Load exclusion data from DB + learning state.
 */
export async function loadExclusionContext(
	learning: LearningState,
): Promise<ExclusionContext> {
	const sb = getServiceClient();

	const [ownRes, recentRes, codesRes] = await Promise.all([
		sb.from("product_summaries").select("product_name").limit(5000),
		sb
			.from("discovered_products")
			.select("product_url")
			.gte(
				"created_at",
				new Date(
					Date.now() - RECENT_WINDOW_DAYS * 24 * 3600 * 1000,
				).toISOString(),
			),
		sb
			.from("discovered_products")
			.select("rakuten_item_code")
			.not("rakuten_item_code", "is", null),
	]);

	const ownSourcedNames = (ownRes.data ?? [])
		.map((r: { product_name: string | null }) =>
			r.product_name ? normalizeName(r.product_name) : "",
		)
		.filter((s) => s.length >= OWN_NAME_PREFIX_LEN);

	const recentDiscoveredUrls = new Set(
		(recentRes.data ?? []).map(
			(r: { product_url: string }) => r.product_url,
		),
	);

	const crossSessionRakutenCodes = new Set(
		(codesRes.data ?? [])
			.map((r: { rakuten_item_code: string | null }) => r.rakuten_item_code)
			.filter((c): c is string => !!c),
	);

	return {
		ownSourcedNames,
		recentDiscoveredUrls,
		crossSessionRakutenCodes,
		rejectedUrls: new Set(learning.rejected_seeds.urls),
		rejectedBrands: new Set(learning.rejected_seeds.brands),
		rejectedTerms: learning.rejected_seeds.terms,
	};
}

/**
 * Apply exclusion filters to pool items. Returns kept items.
 */
export function applyExclusions(
	pool: PoolItem[],
	ctx: ExclusionContext,
): PoolItem[] {
	return pool.filter((item) => {
		const normalized = normalizeName(item.name);

		// 1. own sourcing history (fuzzy prefix)
		for (const own of ctx.ownSourcedNames) {
			if (normalized.includes(own.slice(0, OWN_NAME_PREFIX_LEN))) return false;
		}

		// 2. last 7 days
		if (ctx.recentDiscoveredUrls.has(item.productUrl)) return false;

		// 3. cross-session rakuten code
		if (
			item.rakutenItemCode &&
			ctx.crossSessionRakutenCodes.has(item.rakutenItemCode)
		)
			return false;

		// 4. rejected seeds
		if (ctx.rejectedUrls.has(item.productUrl)) return false;
		if (item.sellerName && ctx.rejectedBrands.has(item.sellerName)) return false;
		for (const term of ctx.rejectedTerms) {
			if (term && item.name.includes(term)) return false;
		}

		return true;
	});
}

export const __test = {
	OWN_NAME_PREFIX_LEN,
	RECENT_WINDOW_DAYS,
};
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 추가 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add lib/discovery/exclusion.ts
git commit -m "feat(discovery): add exclusion filters (own history, 7-day, rejected seeds)"
```

---

## Task 6: `lib/discovery/plan.ts` 작성

**Files:**
- Create: `lib/discovery/plan.ts`

- [ ] **Step 1: 파일 생성**

Write to `lib/discovery/plan.ts`:

```typescript
/**
 * Category planning — builds 15 keywords (tv_proven + exploration) for daily discovery.
 * Ref: spec §4.2 단계 2.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { getServiceClient } from "@/lib/supabase";
import type { CategoryPlan, LearningState } from "./types";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = "gemini-3-flash-preview";
const TOTAL_KEYWORDS = 15;

const FALLBACK_EXPLORATION = [
	"人気商品",
	"売れ筋",
	"おすすめ",
	"トレンド",
	"2026 新商品",
	"話題",
	"ランキング",
];

/**
 * Aggregate top TV-proven categories from product_summaries by total_revenue.
 */
export async function loadTopCategories(limit = 20): Promise<string[]> {
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("product_summaries")
		.select("category, total_revenue")
		.not("category", "is", null);

	if (error) {
		console.warn("[plan] loadTopCategories failed:", error.message);
		return [];
	}

	const agg = new Map<string, number>();
	for (const row of (data ?? []) as Array<{
		category: string;
		total_revenue: number | null;
	}>) {
		agg.set(row.category, (agg.get(row.category) ?? 0) + (row.total_revenue ?? 0));
	}
	return [...agg.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([cat]) => cat);
}

/**
 * Load keywords used in the past N days so the planner can down-rank them.
 */
export async function loadRecentPlannedKeywords(
	days = 7,
): Promise<Set<string>> {
	const sb = getServiceClient();
	const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
	const { data, error } = await sb
		.from("discovery_sessions")
		.select("category_plan")
		.gte("run_at", since);

	if (error) {
		console.warn("[plan] loadRecentPlannedKeywords failed:", error.message);
		return new Set();
	}

	const used = new Set<string>();
	for (const row of (data ?? []) as Array<{ category_plan: CategoryPlan | null }>) {
		if (!row.category_plan) continue;
		for (const kw of [
			...(row.category_plan.tv_proven ?? []),
			...(row.category_plan.exploration ?? []),
		]) {
			used.add(kw);
		}
	}
	return used;
}

/**
 * Build today's category plan via Gemini. Respects learning state ratio and
 * rejection hints. Falls back to deterministic defaults if Gemini fails.
 */
export async function buildCategoryPlan(
	learning: LearningState,
	topCategories: string[],
	recentlyUsed: Set<string>,
): Promise<CategoryPlan> {
	const explorationCount = Math.max(
		3,
		Math.min(10, Math.round(TOTAL_KEYWORDS * learning.exploration_ratio)),
	);
	const tvCount = TOTAL_KEYWORDS - explorationCount;

	const weightsHint = Object.entries(learning.category_weights)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([k, v]) => `${k}=${v.toFixed(2)}`)
		.join(", ");

	const rejectionHint = learning.recent_rejection_reasons
		.slice(0, 3)
		.map((r) => `${r.reason}(${r.count}件)`)
		.join(", ");

	const prompt = `あなたは日本のテレビ通販・ライブコマース向け商品ソーシング専門家です。
今日の発掘キーワード${TOTAL_KEYWORDS}個を選んでください。

【条件】
- tv_proven: ${tvCount}個 — 以下のTV実績カテゴリから選択。学習重みが高いカテゴリを優先。
- exploration: ${explorationCount}個 — TV実績にない新興/トレンドカテゴリ。日本市場で伸びている領域。

【TV実績カテゴリ (上位)】
${topCategories.join(", ") || "(データなし — 一般TV通販カテゴリから推定)"}

【カテゴリ学習重み (0.0-1.0, 高いほど優先)】
${weightsHint || "(コールドスタート中 — 均等)"}

【最近使用済みキーワード (下位優先)】
${[...recentlyUsed].join(", ") || "(なし)"}

【最近の主な却下理由 (減点対象特性)】
${rejectionHint || "(データ不足)"}

【出力 — JSONのみ、前置き/後書きなし】
{
  "tv_proven": ["キーワード1", "..."],
  "exploration": ["キーワード1", "..."],
  "reasoning": "1行説明（日本語）"
}`;

	try {
		const model = genAI.getGenerativeModel({ model: MODEL_ID });
		const res = await model.generateContent(prompt);
		const text = res.response.text();
		const match = text.match(/\{[\s\S]+\}/);
		if (!match) throw new Error("no JSON in plan response");
		const parsed = JSON.parse(match[0]) as Partial<CategoryPlan>;

		const plan: CategoryPlan = {
			tv_proven: (parsed.tv_proven ?? []).slice(0, tvCount),
			exploration: (parsed.exploration ?? []).slice(0, explorationCount),
			reasoning: parsed.reasoning,
		};

		if (plan.tv_proven.length === 0) {
			plan.tv_proven = topCategories.slice(0, tvCount);
		}
		if (plan.exploration.length === 0) {
			plan.exploration = FALLBACK_EXPLORATION.slice(0, explorationCount);
		}
		return plan;
	} catch (err) {
		console.warn(
			"[plan] Gemini planning failed, using fallback:",
			err instanceof Error ? err.message : String(err),
		);
		return {
			tv_proven: topCategories.slice(0, tvCount),
			exploration: FALLBACK_EXPLORATION.slice(0, explorationCount),
			reasoning: "fallback (Gemini failed)",
		};
	}
}
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 추가 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add lib/discovery/plan.ts
git commit -m "feat(discovery): add category planning with Gemini + fallback"
```

---

## Task 7: `lib/discovery/pool.ts` 작성

**Files:**
- Create: `lib/discovery/pool.ts`

**Depends on:** Task 1 (`braveSearchItems`), Task 4 (types).

- [ ] **Step 1: 파일 생성**

Write to `lib/discovery/pool.ts`:

```typescript
/**
 * Pool builder — fetches Rakuten + Brave results for a category plan.
 * Ref: spec §4.2 단계 3.
 *
 * Rakuten: sequential (1s throttle per Rakuten rate-limit rules).
 * Brave: parallel (separate rate budget).
 */

import { braveSearchItems } from "@/lib/brave";
import {
	rakutenItemSearch,
	rakutenRankingSearch,
	type RakutenItem,
} from "@/lib/rakuten";
import type { CategoryPlan, PoolItem, Track } from "./types";

const RAKUTEN_THROTTLE_MS = 1000;
const RAKUTEN_PER_KEYWORD = 10;
const BRAVE_PER_KEYWORD = 5;

/**
 * Extract Rakuten item code (shopCode:itemCode) from an item URL.
 * Pattern: https://item.rakuten.co.jp/<shop>/<item>/
 */
export function extractRakutenCode(url: string): string | undefined {
	const m = url.match(/item\.rakuten\.co\.jp\/([^/]+)\/([^/?#]+)/);
	return m ? `${m[1]}:${m[2]}` : undefined;
}

function rakutenItemToPoolItem(
	it: RakutenItem,
	seed: string,
	track: Track,
): PoolItem {
	return {
		name: it.itemName,
		productUrl: it.itemUrl,
		priceJpy: it.itemPrice || undefined,
		reviewCount: it.reviewCount,
		reviewAvg: it.reviewAverage || undefined,
		sellerName: it.shopName || undefined,
		source: "rakuten",
		rakutenItemCode: extractRakutenCode(it.itemUrl),
		seedKeyword: seed,
		track,
	};
}

async function fetchRakutenForKeyword(
	keyword: string,
	track: Track,
): Promise<PoolItem[]> {
	try {
		let res = await rakutenItemSearch(
			keyword,
			"-reviewCount",
			RAKUTEN_PER_KEYWORD,
		);
		if (res.items.length === 0) {
			res = await rakutenRankingSearch(keyword, undefined, RAKUTEN_PER_KEYWORD);
		}
		return res.items.map((it) => rakutenItemToPoolItem(it, keyword, track));
	} catch (err) {
		console.warn(
			`[pool] rakuten "${keyword}" failed:`,
			err instanceof Error ? err.message : String(err),
		);
		return [];
	}
}

async function fetchBraveForKeyword(
	keyword: string,
	track: Track,
): Promise<PoolItem[]> {
	const query = `${keyword} 通販 おすすめ 楽天 Amazon`;
	try {
		const results = await braveSearchItems(query, 10);
		return results.slice(0, BRAVE_PER_KEYWORD).map((r) => ({
			name: r.title,
			productUrl: r.url,
			source: "brave" as const,
			seedKeyword: keyword,
			track,
		}));
	} catch (err) {
		console.warn(
			`[pool] brave "${keyword}" failed:`,
			err instanceof Error ? err.message : String(err),
		);
		return [];
	}
}

/**
 * Build the candidate pool for a category plan.
 * Returns unique items (by URL) across Rakuten + Brave sources.
 */
export async function buildPool(plan: CategoryPlan): Promise<PoolItem[]> {
	const tvKws = plan.tv_proven.map((kw) => ({ kw, track: "tv_proven" as Track }));
	const expKws = plan.exploration.map((kw) => ({
		kw,
		track: "exploration" as Track,
	}));
	const allKws = [...tvKws, ...expKws];

	const pool: PoolItem[] = [];
	const seenUrls = new Set<string>();

	// Rakuten — sequential with throttle
	for (const { kw, track } of allKws) {
		const items = await fetchRakutenForKeyword(kw, track);
		for (const it of items) {
			if (seenUrls.has(it.productUrl)) continue;
			seenUrls.add(it.productUrl);
			pool.push(it);
		}
		await new Promise((r) => setTimeout(r, RAKUTEN_THROTTLE_MS));
	}

	// Brave — parallel
	const braveBatches = await Promise.allSettled(
		allKws.map(({ kw, track }) => fetchBraveForKeyword(kw, track)),
	);
	for (const batch of braveBatches) {
		if (batch.status !== "fulfilled") continue;
		for (const it of batch.value) {
			if (seenUrls.has(it.productUrl)) continue;
			seenUrls.add(it.productUrl);
			pool.push(it);
		}
	}

	return pool;
}

export const __test = {
	RAKUTEN_THROTTLE_MS,
	RAKUTEN_PER_KEYWORD,
	BRAVE_PER_KEYWORD,
};
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 추가 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add lib/discovery/pool.ts
git commit -m "feat(discovery): add pool builder (Rakuten sequential + Brave parallel)"
```

---

## Task 8: `lib/discovery/curate.ts` 작성

**Files:**
- Create: `lib/discovery/curate.ts`

- [ ] **Step 1: 파일 생성**

Write to `lib/discovery/curate.ts`:

```typescript
/**
 * Gemini-driven curation — selects top N from pool with scored breakdown.
 * Ref: spec §4.2 단계 5.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
	Candidate,
	CurationScore,
	LearningState,
	PoolItem,
} from "./types";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = "gemini-3-flash-preview";
const POOL_SAMPLE_LIMIT = 150;

interface GeminiCurationItem {
	index: number;
	tv_fit_score: number;
	tv_fit_reason: string;
	is_tv_applicable: boolean;
	is_live_applicable: boolean;
	score_breakdown: CurationScore;
}

function formatPoolLine(p: PoolItem, i: number): string {
	const price = p.priceJpy ? `¥${p.priceJpy}` : "¥?";
	const review = `★${p.reviewAvg ?? "?"}(${p.reviewCount ?? 0})`;
	const seller = p.sellerName ?? "?";
	const name = p.name.slice(0, 80);
	return `${i}: ${name} | ${price} | ${review} | ${seller} | seed=${p.seedKeyword} | track=${p.track}`;
}

/**
 * Curate a pool into N candidates via Gemini.
 * Returns candidates sorted by tvFitScore DESC.
 */
export async function curatePool(
	pool: PoolItem[],
	targetCount: number,
	learning: LearningState,
): Promise<Candidate[]> {
	if (pool.length === 0) return [];

	const sampled = pool.slice(0, POOL_SAMPLE_LIMIT);
	const poolList = sampled.map((p, i) => formatPoolLine(p, i)).join("\n");

	const rejectionHints =
		learning.recent_rejection_reasons
			.slice(0, 3)
			.map((r) => `${r.reason}(${r.count}件)`)
			.join(", ") || "(データ不足)";

	const prompt = `あなたは日本のテレビ通販・ライブコマースに適した商品を選ぶバイヤーです。
以下の商品プールから上位${targetCount}個を選び、各商品を評価してください。

【採点基準 (合計0-100)】
- review_signal (0-35): Rakutenレビュー数と評価の強さ (≥100件→30+, 50-99→20, 5-49→10, <5→0)
- tv_category_match (0-20): TV実績カテゴリとの一致 (一致=20, 隣接=10, 不一致=0)
- trend_signal (0-15): 日本市場のトレンド信号の強さ
- price_fit (0-15): ¥3,000-30,000 衝動買いゾーンに近いほど高い
- purchase_signal (0-15): 実演映え・ギフト需要・SNS拡散性

【除外すべき特性 (採点せず応答から除外)】
- 単価¥500未満の消耗品
- 専門設置が必要な高額家電 (デモ不可)
- 医薬品・処方箋必要
- 資格・許認可が必要な販売カテゴリ

【最近の却下理由 (減点対象)】
${rejectionHints}

【商品プール — index: name | price | review | seller | seed | track】
${poolList}

【出力 — JSONのみ、前置き/後書き・コメントなし】
{
  "candidates": [
    {
      "index": <プールのインデックス>,
      "tv_fit_score": <0-100>,
      "tv_fit_reason": "1行 (日本語, 50字以内)",
      "is_tv_applicable": true,
      "is_live_applicable": true,
      "score_breakdown": {
        "review_signal": <0-35>,
        "tv_category_match": <0-20>,
        "trend_signal": <0-15>,
        "price_fit": <0-15>,
        "purchase_signal": <0-15>,
        "total": <合計>
      }
    }
  ]
}`;

	const model = genAI.getGenerativeModel({ model: MODEL_ID });
	const res = await model.generateContent(prompt);
	const text = res.response.text();
	const match = text.match(/\{[\s\S]+\}/);
	if (!match) throw new Error("curate: no JSON in response");

	const parsed = JSON.parse(match[0]) as { candidates?: GeminiCurationItem[] };
	const items = parsed.candidates ?? [];

	const candidates: Candidate[] = [];
	for (const c of items) {
		const source = sampled[c.index];
		if (!source) continue;
		candidates.push({
			...source,
			tvFitScore: Math.max(0, Math.min(100, c.tv_fit_score)),
			tvFitReason: c.tv_fit_reason,
			isTvApplicable: c.is_tv_applicable,
			isLiveApplicable: c.is_live_applicable,
			scoreBreakdown: c.score_breakdown,
		});
	}

	candidates.sort((a, b) => b.tvFitScore - a.tvFitScore);
	return candidates.slice(0, targetCount);
}
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 추가 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add lib/discovery/curate.ts
git commit -m "feat(discovery): add Gemini curation with scored breakdown"
```

---

## Task 9: `scripts/test-discovery-dry-run.ts` + package.json 스크립트

**Files:**
- Create: `scripts/test-discovery-dry-run.ts`
- Modify: `package.json`

**Depends on:** Tasks 4-8.

- [ ] **Step 1: tsx devDependency 확인/추가**

Run: `npm list tsx`

If not installed:
```bash
npm install --save-dev tsx
```

- [ ] **Step 2: `package.json` scripts 수정**

`package.json` 의 `"scripts"` 블록에 다음 라인 추가:

```json
"test:discovery-dry-run": "tsx -r dotenv/config scripts/test-discovery-dry-run.ts"
```

(환경변수 로드를 위해 `dotenv` 가 필요하면 `npm install --save-dev dotenv` — 보통 Next.js 프로젝트에 이미 존재.)

- [ ] **Step 3: dry-run 스크립트 생성**

Write to `scripts/test-discovery-dry-run.ts`:

```typescript
/**
 * Stage 1 Discovery Pipeline — Dry Run (no DB writes).
 * Usage: npm run test:discovery-dry-run
 *
 * Runs: plan → pool → exclusion → curate.
 * Prints each stage's output summary for manual inspection.
 */

import { getServiceClient } from "@/lib/supabase";
import { buildCategoryPlan, loadRecentPlannedKeywords, loadTopCategories } from "@/lib/discovery/plan";
import { buildPool } from "@/lib/discovery/pool";
import { applyExclusions, loadExclusionContext } from "@/lib/discovery/exclusion";
import { curatePool } from "@/lib/discovery/curate";
import { DEFAULT_LEARNING_STATE, type LearningState } from "@/lib/discovery/types";

async function loadLearningState(): Promise<LearningState> {
	try {
		const sb = getServiceClient();
		const { data, error } = await sb
			.from("learning_state")
			.select("*")
			.eq("id", 1)
			.single();
		if (error || !data) return DEFAULT_LEARNING_STATE;
		return {
			exploration_ratio: data.exploration_ratio,
			category_weights: data.category_weights ?? {},
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

function section(title: string): void {
	console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
	section("Discovery Dry-Run");
	console.log("Target: 30 candidates, no DB writes.");

	section("Step 1 · Load Learning State");
	const learning = await loadLearningState();
	console.log(JSON.stringify(learning, null, 2));

	section("Step 2 · Load Top Categories + Recent Keywords");
	const [topCategories, recentlyUsed] = await Promise.all([
		loadTopCategories(),
		loadRecentPlannedKeywords(),
	]);
	console.log(`top_categories (${topCategories.length}):`, topCategories);
	console.log(`recently_used (${recentlyUsed.size}):`, [...recentlyUsed]);

	section("Step 3 · Build Category Plan (Gemini)");
	const plan = await buildCategoryPlan(learning, topCategories, recentlyUsed);
	console.log("plan:", JSON.stringify(plan, null, 2));

	section("Step 4 · Build Pool (Rakuten + Brave)");
	const t0 = Date.now();
	const pool = await buildPool(plan);
	const poolMs = Date.now() - t0;
	console.log(`pool: ${pool.length} items in ${poolMs}ms`);
	const bySource = pool.reduce<Record<string, number>>((acc, p) => {
		acc[p.source] = (acc[p.source] ?? 0) + 1;
		return acc;
	}, {});
	console.log("pool by source:", bySource);
	const byTrack = pool.reduce<Record<string, number>>((acc, p) => {
		acc[p.track] = (acc[p.track] ?? 0) + 1;
		return acc;
	}, {});
	console.log("pool by track:", byTrack);

	section("Step 5 · Load Exclusion Context + Apply Filters");
	const ctx = await loadExclusionContext(learning);
	console.log(
		`exclusion: ${ctx.ownSourcedNames.length} own, ${ctx.recentDiscoveredUrls.size} 7d urls, ${ctx.crossSessionRakutenCodes.size} rakuten codes, ${ctx.rejectedUrls.size} rej.urls, ${ctx.rejectedBrands.size} rej.brands, ${ctx.rejectedTerms.length} rej.terms`,
	);
	const filtered = applyExclusions(pool, ctx);
	console.log(
		`after exclusion: ${filtered.length} items (filtered out ${pool.length - filtered.length})`,
	);

	section("Step 6 · Curate (Gemini) → 30 candidates");
	if (filtered.length === 0) {
		console.warn("No pool items to curate. Aborting.");
		return;
	}
	const t1 = Date.now();
	const candidates = await curatePool(filtered, 30, learning);
	const curMs = Date.now() - t1;
	console.log(`candidates: ${candidates.length} in ${curMs}ms`);

	section("Top 10 Candidates (by tv_fit_score)");
	candidates.slice(0, 10).forEach((c, i) => {
		const price = c.priceJpy ? `¥${c.priceJpy}` : "¥?";
		console.log(
			`${i + 1}. [${c.tvFitScore}] ${c.name.slice(0, 60)} | ${price} | seed=${c.seedKeyword} | ${c.track}`,
		);
		console.log(`    reason: ${c.tvFitReason}`);
	});

	section("Summary");
	console.log(`pool=${pool.length}  filtered=${filtered.length}  candidates=${candidates.length}`);
	const tvCount = candidates.filter((c) => c.track === "tv_proven").length;
	const expCount = candidates.filter((c) => c.track === "exploration").length;
	console.log(`candidates by track: tv=${tvCount}, exploration=${expCount}`);
	const scoreAvg =
		candidates.reduce((s, c) => s + c.tvFitScore, 0) / (candidates.length || 1);
	console.log(`avg tv_fit_score: ${scoreAvg.toFixed(1)}`);
}

main().catch((err) => {
	console.error("DRY-RUN FAILED:", err);
	process.exitCode = 1;
});
```

- [ ] **Step 4: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 추가 에러 없음.

- [ ] **Step 5: 커밋 (스크립트 + package.json)**

```bash
git add scripts/test-discovery-dry-run.ts package.json
git commit -m "feat(discovery): add end-to-end Stage 1 dry-run script"
```

---

## Task 10: Dry-Run 실행 & 검증

**Files:** (실행만, 코드 변경 없음. 버그 발견 시에만 수정 커밋.)

**Depends on:** Task 3 (DB 마이그레이션 완료), Tasks 4-9.

- [ ] **Step 1: 환경변수 확인**

`.env.local` (또는 `.env`) 에 다음이 있는지 확인:
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY`
- `RAKUTEN_APPLICATION_ID` + `RAKUTEN_ACCESS_KEY`
- `BRAVE_SEARCH_API_KEY`

- [ ] **Step 2: Dry-run 실행**

Run: `npm run test:discovery-dry-run`

Expected: 콘솔에 다음 섹션들이 순서대로 출력:
```
=== Discovery Dry-Run ===
=== Step 1 · Load Learning State ===
  { exploration_ratio: 0.47, ... is_cold_start: true }
=== Step 2 · Load Top Categories + Recent Keywords ===
  top_categories (N): [...]
  recently_used (0): []
=== Step 3 · Build Category Plan (Gemini) ===
  plan: { tv_proven: [...8], exploration: [...7], reasoning: "..." }
=== Step 4 · Build Pool (Rakuten + Brave) ===
  pool: ~80-150 items in ~25000ms
  pool by source: { rakuten: ~60-120, brave: ~20-50 }
  pool by track: { tv_proven: ~..., exploration: ~... }
=== Step 5 · Load Exclusion Context + Apply Filters ===
  after exclusion: ~N items (filtered out ~M)
=== Step 6 · Curate (Gemini) → 30 candidates ===
  candidates: ~30 in ~10000-20000ms
=== Top 10 Candidates (by tv_fit_score) ===
  1. [87] 商品名... | ¥4,980 | seed=美容家電 | tv_proven
     reason: ...
  ...
=== Summary ===
  pool=..., filtered=..., candidates=...
  avg tv_fit_score: 70.5
```

- [ ] **Step 3: 검증 체크리스트 (수동)**

출력을 사람이 확인:

**A. 파이프라인 성공 여부**
- [ ] Step 1-6 모두 에러 없이 완료되었는가?
- [ ] plan.tv_proven.length === 8, plan.exploration.length === 7 ?
- [ ] pool.length >= 50 ? (너무 적으면 쿼리/키 문제)
- [ ] filtered.length >= 30 ? (30 미만이면 curate 결과도 부족함)
- [ ] candidates.length === 30 (혹은 가까움)?

**B. 품질 샘플링** — Top 10 육안 검토:
- [ ] 제품명이 일본어로 합리적?
- [ ] tv_fit_score 가 70 이상인 항목들이 대부분 "TV에서 팔릴만한" 유형인가?
- [ ] tv_fit_reason 이 일본어 1줄로 의미 있는가?
- [ ] track(tv_proven vs exploration) 분포가 예상(대략 16:14)에 가까운가?

**C. 성능**
- [ ] Pool 빌드 30초 이내 (Rakuten 15 × 1초 throttle + Brave 병렬)
- [ ] Curate 30초 이내

- [ ] **Step 4: 실패/품질 문제 처리**

체크리스트에서 실패한 항목이 있으면:
- **Pool 너무 적음**: Brave 쿼리 변경 또는 Rakuten keyword 정규화 (pool.ts 에서 `${keyword} 通販 おすすめ` 변형)
- **Curate 결과 이상함**: curate.ts 프롬프트에서 "除外すべき特性" 강화
- **Gemini JSON parse 실패**: plan.ts / curate.ts 의 정규식 더 느슨하게 (`/\{[\s\S]+?\}/` 등)
- **DB row 없음으로 빈 exclusion**: 정상 (처음 실행)

수정 시 개별 커밋:
```bash
git add lib/discovery/<file>.ts
git commit -m "fix(discovery): <이슈 설명>"
```

- [ ] **Step 5: Phase 1 완료 선언**

Dry-run 이 정상 완료되고 top 10 품질이 합리적이면 Phase 1 완료.

```bash
# 커밋할 변경 없다면 생략. 있으면 최종 튜닝 커밋.
git log --oneline -20   # Phase 1 작업 확인
```

다음 스텝: Phase 2 (저장·조회) 계획 작성 요청.

---

## Self-Review

**Spec coverage:**
- §4.2 단계 2 (plan) → Task 6 ✓
- §4.2 단계 3 (pool) → Tasks 1, 7 ✓
- §4.2 단계 4 (exclusion) → Task 5 ✓
- §4.2 단계 5 (curate) → Task 8 ✓
- §4.2 단계 6 (bounded agent) → Phase 2 (orchestrator 작성 시)
- §4.2 단계 7 (broadcast check) → Phase 2
- §4.2 단계 8 (save) → Phase 2
- §7 schema → Tasks 2, 3 ✓
- §11 dry-run 검증 → Tasks 9, 10 ✓

**Placeholder scan:** 모든 step 이 실제 코드/명령어 포함. 없음.

**Type consistency:**
- `CategoryPlan` (types.ts) — plan.ts, pool.ts, dry-run 에서 동일 구조 사용 ✓
- `PoolItem` — pool.ts 생성, exclusion.ts 소비, curate.ts 소비 ✓
- `Candidate extends PoolItem` — curate.ts 생성 ✓
- `LearningState` — plan.ts, curate.ts, exclusion.ts, dry-run 모두 일치 ✓
- `getServiceClient` — 기존 `lib/supabase.ts` 시그니처 사용 ✓
- `braveSearchItems` (Task 1) → pool.ts 사용 — 함수명 일치 ✓
- `rakutenItemSearch`, `rakutenRankingSearch` — 기존 시그니처 사용 ✓

**Gaps:** `RAKUTEN_APPLICATION_ID` + `RAKUTEN_ACCESS_KEY` 는 기존 코드에 존재. CLAUDE.md 가 `RAKUTEN_APP_ID` 로 표기된 것은 문서 오타로 판단 — 실제 코드 기준 사용.
