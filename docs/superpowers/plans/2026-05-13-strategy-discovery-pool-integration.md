# Strategy ↔ Discovery Pool 統合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 戦略立案(`/analytics/strategy/*`) 이 항상 商品発掘(`discovered_products` 테이블) 의 매일 누적·학습된 풀을 **1차 소스로** 사용하도록 통합한다. 사용자 입력 조건(goal, 카테고리, 타겟, 가격대)을 풀에 적용해 좁히고, 부족하면 그때만 Rakuten/Brave 신검색으로 채운다. 다중 시드(여러 발굴 카드를 동시 선택)도 지원한다.

**Architecture:** 신규 `lib/strategy/pool-query.ts` 모듈이 `discovered_products` 테이블에 조건 필터(context · category · price · target market · 제외 user_action)를 적용해 후보 풀을 반환. `lib/md-strategy.ts:discoverNewProducts` 가 이를 "pool-first" 로 호출 — 풀이 충분하면 외부 API 호출을 건너뛰고, 부족하면 기존 Rakuten/Brave 경로로 부족분만 보충한다. `lib/strategy/seed-context.ts` 는 다중 시드 로딩 + 다중 시드 프롬프트 포매팅을 추가. 워크플로 · API · UI 가 `seedProductIds: string[]` 을 thread.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (`discovered_products` 테이블 기존 스키마 그대로 사용 — 신규 컬럼 없음), Google Gemini 3-Flash, `@workflow/next` durable workflows.

**Spec reference:** 본 plan 자체를 spec 으로 사용 (별도 spec 문서 미작성). 기존 관련 spec:
- `docs/superpowers/specs/2026-04-18-product-discovery-redesign-design.md` — 풀 생성 파이프라인
- `docs/superpowers/specs/2026-04-18-seed-aware-strategy-design.md` — 단일 시드 → 전략 prompt 주입 (이 plan 의 전제)

**Out of scope:**
- 商品発掘 자체의 발굴 로직(스코어링 · 학습 · 카테고리 플랜) — 변경 없음
- DB 스키마 변경 — 추가 컬럼/테이블 없음, 기존 `discovered_products` 와 `md_strategies.product_selection` JSON 만 사용
- ライブコマース 전략(`live-commerce-strategy.ts`) — 동일 통합이 가능하나 본 plan 은 拡大戦略(MD) 만 다룸. LC 는 후속 plan 으로 분리
- 신규 테스트 프레임워크 도입 — 기존 `tsx` 기반 `scripts/test-*.ts` 패턴 그대로

---

## File Structure

**Create:**
```
lib/strategy/category-mapping.ts             -- CATEGORY_MAPPING shared 상수 분리
lib/strategy/pool-query.ts                   -- discovered_products 필터 쿼리
scripts/test-pool-query-filters.ts           -- 필터 unit tests (TDD)
scripts/test-pool-query-fallback.ts          -- 부족 시 fallback 동작 test
scripts/test-multi-seed-context.ts           -- 다중 시드 로딩/포매팅 test
scripts/test-discover-pool-first.ts          -- discoverNewProducts 통합 test
```

**Modify:**
```
lib/md-strategy.ts                                -- discoverNewProducts pool-first
lib/strategy/seed-context.ts                      -- 다중 시드 지원
lib/workflows/md-strategy.workflow.ts             -- seedProductIds[] thread
app/api/analytics/md-strategy/route.ts            -- seedProductIds 수용
app/api/analytics/md-strategy/[id]/rediscover/route.ts -- pool-first 재발굴
components/analytics/MDStrategyPanel.tsx          -- ?seedIds= URL param
components/discovery/SelectionGrid.tsx            -- 다중 선택 + 일괄 CTA
components/analytics/DiscoveredProductsHero.tsx   -- pool-source 배지
package.json                                      -- 신규 npm scripts
CLAUDE.md                                         -- 통합 흐름 문서화 (단락 1개)
```

---

## Core Decision Rules

이 plan 의 실행 중 모든 task 가 일관되게 따라야 할 결정 규칙. 구현 task 안에서 다시 참조한다.

### R1 — Pool query 의 기본 정렬
`tv_tier ASC, tv_fit_score DESC, created_at DESC` (TV채널 hit 우선 → 점수 → 최신).

### R2 — 제외 규칙
`user_action = 'rejected'` 인 행은 제외. `user_action = 'duplicate'` 도 제외. 그 외 (`'sourced'`, `'interested'`, NULL) 는 포함.

### R3 — Context 필터
`input.context` (`home_shopping` | `live_commerce`) 와 일치하는 행만.

### R4 — 카테고리 필터
사용자 UI 카테고리 (예: `"美容・スキンケア"`) 는 `CATEGORY_MAPPING` 으로 sales 카테고리 배열로 변환한 후, `discovered_products.category` 와 `discovered_products.seed_keyword` 컬럼 양쪽에 substring 매치. 양쪽 어디든 매치되면 통과. 결과가 5개 미만이면 카테고리 필터를 무시하고 전체 정렬 결과 반환 (fail-open).

### R5 — 가격 필터
`parsePriceRange(input.priceRange)` → `{min, max}`. `price_jpy` 가 범위 안인 행만. price_jpy NULL 은 통과 (관대 매치). 결과가 5개 미만이면 가격 필터 무시 (fail-open).

### R6 — Lookback window
`created_at >= now() - 60 days`. 너무 오래된 후보는 시장 신선도가 떨어지므로 제외. 환경 변수 `STRATEGY_POOL_LOOKBACK_DAYS` 로 오버라이드.

### R7 — Pool target sizes
| Mode | Pool 목표 |
|---|---|
| `lightweight=true` (MD workflow 기본) | 30 |
| `lightweight=false` (full sales_strategy) | 12 |

이 수를 채우면 외부 검색 skip. 못 채우면 부족분 = (target − poolCount) 만큼 Rakuten/Brave 로 보충.

### R8 — Pool 0 일 때
완전히 비면 기존 Rakuten/Brave 경로 그대로 (현재 동작 보존). 로깅으로 `pool_empty_fallback: true` 표시.

### R9 — 다중 시드
`seedProductIds: string[]` 이 들어오면, **(a)** 모든 시드의 `c_package` 정보를 프롬프트에 주입, **(b)** 시드 상품들의 카테고리 union 을 pool query 의 카테고리 필터 보조 신호로 사용 (사용자가 명시 category 안 줬을 때만), **(c)** 시드 자체는 추천 결과에 항상 포함시켜 1번부터 N번까지 배치.

### R10 — Pool-source tagging
모든 추천 상품 (`DiscoveredProduct`) 에 신규 옵션 필드:
- `pool_source: 'discovery_pool' | 'fresh_search' | 'seed'`
- `discovered_product_id?: string` (DB 행 ID, 추적용)

UI 가 이를 보고 배지 표시.

---

## Task 1: `lib/strategy/category-mapping.ts` — 공통 카테고리 매핑 분리

**Files:**
- Create: `lib/strategy/category-mapping.ts`
- Modify: `lib/md-strategy.ts` (CATEGORY_MAPPING re-export)

`CATEGORY_MAPPING` 이 현재 `lib/md-strategy.ts:240` 안에 module-private 으로 묶여 있어 신규 `pool-query.ts` 가 import 못 함. 공통 모듈로 분리.

- [ ] **Step 1: 신규 파일 작성**

Write to `lib/strategy/category-mapping.ts`:

```typescript
/**
 * UI 카테고리 라벨(일본어) → sales DB 카테고리 배열 매핑.
 * - 戦略立案 입력 폼 옵션 (MDStrategyPanel CATEGORIES)
 * - discovered_products 카테고리 필터 (pool-query)
 * - product_summaries 카테고리 필터 (fetchStrategyContext)
 * 모두 동일한 매핑을 사용해야 한다.
 */
export const CATEGORY_MAPPING: Record<string, string[]> = {
	"美容・スキンケア": ["美容・運動", "化粧品"],
	"健康食品": ["食品"],
	"キッチン用品": ["キッチン"],
	"ファッション": ["アパレル", "靴・バッグ"],
	"生活雑貨": ["家電・雑貨", "掃除・洗濯"],
	"電気機器": ["家電・雑貨"],
	"フィットネス": ["美容・運動", "医療機器"],
	"その他": ["その他", "寝具", "宝飾", "防災・防犯", "ゴルフ"],
};

/**
 * UI category label → 매칭 가능한 sales DB 카테고리 배열.
 * 알 수 없는 라벨은 빈 배열 반환 (호출부가 fail-open 판단).
 */
export function mapUiCategoryToSalesCategories(ui: string | undefined): string[] {
	if (!ui) return [];
	return CATEGORY_MAPPING[ui] ?? [];
}
```

- [ ] **Step 2: `lib/md-strategy.ts:240` 의 CATEGORY_MAPPING 정의를 re-export 로 교체**

Edit `lib/md-strategy.ts` — replace lines 236-249 (`// Category mapping for filtering` 헤더부터 const 끝까지) with:

```typescript
// ---------------------------------------------------------------------------
// Category mapping for filtering — shared with pool-query.
// ---------------------------------------------------------------------------

import { CATEGORY_MAPPING } from "@/lib/strategy/category-mapping";
```

(Import 는 파일 상단의 다른 imports 옆에 배치하고, 원래 위치는 삭제. CATEGORY_MAPPING 의 모든 사용처는 그대로 동작.)

- [ ] **Step 3: TypeScript 컴파일 확인**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add lib/strategy/category-mapping.ts lib/md-strategy.ts
git commit -m "refactor(strategy): extract CATEGORY_MAPPING to shared module"
```

---

## Task 2: `lib/strategy/pool-query.ts` — discovered_products 필터 쿼리 (TDD)

**Files:**
- Create: `lib/strategy/pool-query.ts`
- Create: `scripts/test-pool-query-filters.ts`

핵심 모듈. R1–R7 결정 규칙 모두 여기서 구현.

- [ ] **Step 1: 실패 테스트 작성 — filter 동작**

Write to `scripts/test-pool-query-filters.ts`:

```typescript
import assert from "node:assert/strict";
import { __test } from "@/lib/strategy/pool-query";

// Sample rows that the DB layer would have returned (post-query, pre-filter).
type Row = Parameters<typeof __test.applyFilters>[0][number];

function mkRow(overrides: Partial<Row>): Row {
	return {
		id: "r-" + Math.random().toString(36).slice(2, 8),
		name: "test product",
		product_url: "https://example.com/" + Math.random(),
		price_jpy: 10000,
		category: "美容・運動",
		seed_keyword: "美容",
		tv_fit_score: 70,
		tv_fit_reason: "test",
		tv_channel_source: null,
		tv_tier: 1,
		context: "home_shopping",
		user_action: null,
		c_package: null,
		enrichment_status: "idle",
		review_count: 50,
		review_avg: 4.2,
		seller_name: "test shop",
		broadcast_tag: "unknown",
		thumbnail_url: null,
		created_at: new Date().toISOString(),
		...overrides,
	};
}

// --- R2: rejected/duplicate 제외 ---
{
	const rows = [
		mkRow({ id: "a", user_action: "rejected" }),
		mkRow({ id: "b", user_action: "duplicate" }),
		mkRow({ id: "c", user_action: "sourced" }),
		mkRow({ id: "d", user_action: null }),
	];
	const out = __test.applyFilters(rows, { context: "home_shopping" });
	assert.deepEqual(out.map((r) => r.id).sort(), ["c", "d"], "R2: rejected/duplicate excluded");
}

// --- R4: 카테고리 substring 매치 — discovered_products.category 또는 seed_keyword ---
{
	const rows = [
		mkRow({ id: "cat-hit", category: "美容・運動 > スキンケア", seed_keyword: "保湿" }),
		mkRow({ id: "kw-hit", category: "その他", seed_keyword: "美容ケア用品" }),
		mkRow({ id: "miss", category: "食品", seed_keyword: "おかず" }),
		mkRow({ id: "miss2", category: "食品", seed_keyword: "おかず2" }),
		mkRow({ id: "miss3", category: "食品", seed_keyword: "おかず3" }),
		mkRow({ id: "miss4", category: "食品", seed_keyword: "おかず4" }),
		mkRow({ id: "miss5", category: "食品", seed_keyword: "おかず5" }),
	];
	const out = __test.applyFilters(rows, {
		context: "home_shopping",
		uiCategory: "美容・スキンケア",
	});
	assert.deepEqual(out.map((r) => r.id).sort(), ["cat-hit", "kw-hit"], "R4: category fuzzy match");
}

// --- R4 fail-open: 결과가 5개 미만이면 카테고리 필터 무시 ---
{
	const rows = [
		mkRow({ id: "hit", category: "美容・運動", seed_keyword: "美容" }),
		mkRow({ id: "miss1", category: "食品", seed_keyword: "ご飯" }),
		mkRow({ id: "miss2", category: "食品", seed_keyword: "おかず" }),
	];
	const out = __test.applyFilters(rows, {
		context: "home_shopping",
		uiCategory: "美容・スキンケア",
	});
	// Since strict filter yields <5, all rows returned.
	assert.equal(out.length, 3, "R4 fail-open: <5 matches → return all");
}

// --- R5: 가격 필터 ---
{
	const rows = Array.from({ length: 6 }, (_, i) =>
		mkRow({ id: `p-${i}`, price_jpy: 2000 + i * 2000 }), // 2k, 4k, 6k, 8k, 10k, 12k
	);
	const out = __test.applyFilters(rows, {
		context: "home_shopping",
		priceRange: { min: 4000, max: 10000 },
	});
	assert.deepEqual(
		out.map((r) => r.price_jpy).sort((a, b) => (a ?? 0) - (b ?? 0)),
		[4000, 6000, 8000, 10000],
		"R5: price range filter",
	);
}

// --- R5 NULL price 통과 ---
{
	const rows = [
		mkRow({ id: "p1", price_jpy: 5000 }),
		mkRow({ id: "p2", price_jpy: null }),
		mkRow({ id: "p3", price_jpy: 5500 }),
		mkRow({ id: "p4", price_jpy: 5800 }),
		mkRow({ id: "p5", price_jpy: 6000 }),
		mkRow({ id: "p6", price_jpy: 6300 }),
	];
	const out = __test.applyFilters(rows, {
		context: "home_shopping",
		priceRange: { min: 5000, max: 6500 },
	});
	assert.ok(out.some((r) => r.id === "p2"), "R5: NULL price passes through");
}

// --- R3: context 필터 ---
{
	const rows = [
		mkRow({ id: "h1", context: "home_shopping" }),
		mkRow({ id: "l1", context: "live_commerce" }),
	];
	const out = __test.applyFilters(rows, { context: "live_commerce" });
	assert.deepEqual(out.map((r) => r.id), ["l1"], "R3: context filter");
}

console.log("PASS: pool-query filters (R2/R3/R4/R5)");
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npx tsx --env-file=.env.local scripts/test-pool-query-filters.ts`
Expected: ERR `Cannot find module '@/lib/strategy/pool-query'`

- [ ] **Step 3: pool-query 구현**

Write to `lib/strategy/pool-query.ts`:

```typescript
/**
 * Pool query — fetches candidates from discovered_products for strategy generation.
 *
 * 決定規則 (plan §Core Decision Rules):
 * - R1: tv_tier ASC, tv_fit_score DESC, created_at DESC
 * - R2: exclude user_action IN ('rejected','duplicate')
 * - R3: context filter
 * - R4: category fuzzy match (category OR seed_keyword), fail-open at <5
 * - R5: price range filter, NULL pass-through, fail-open at <5
 * - R6: lookback window (default 60d, env STRATEGY_POOL_LOOKBACK_DAYS)
 */

import { getServiceClient } from "@/lib/supabase";
import {
	CATEGORY_MAPPING,
	mapUiCategoryToSalesCategories,
} from "@/lib/strategy/category-mapping";

const FAIL_OPEN_THRESHOLD = 5;
const DEFAULT_LOOKBACK_DAYS = 60;

export interface PoolQueryInput {
	context: "home_shopping" | "live_commerce";
	uiCategory?: string; // 사용자 UI 라벨 (e.g. "美容・スキンケア")
	priceRange?: { min: number; max: number };
	limit?: number; // R7
	excludeProductIds?: string[]; // 이미 시드로 사용된 ID
	supplementCategoriesFromSeeds?: string[]; // 시드 상품의 카테고리 (보조 신호)
}

export interface PoolRow {
	id: string;
	name: string;
	product_url: string;
	price_jpy: number | null;
	category: string | null;
	seed_keyword: string;
	tv_fit_score: number;
	tv_fit_reason: string | null;
	tv_channel_source: string | null;
	tv_tier: number;
	context: "home_shopping" | "live_commerce";
	user_action: "sourced" | "interested" | "rejected" | "duplicate" | null;
	c_package: Record<string, unknown> | null;
	enrichment_status: "idle" | "queued" | "running" | "completed" | "failed";
	review_count: number | null;
	review_avg: number | null;
	seller_name: string | null;
	broadcast_tag: "broadcast_confirmed" | "broadcast_likely" | "unknown" | null;
	thumbnail_url: string | null;
	created_at: string;
}

interface FilterOptions {
	context: "home_shopping" | "live_commerce";
	uiCategory?: string;
	priceRange?: { min: number; max: number };
	supplementCategories?: string[];
}

function applyFilters(rows: PoolRow[], opts: FilterOptions): PoolRow[] {
	// R3 + R2 — always strict
	const baseFiltered = rows.filter(
		(r) =>
			r.context === opts.context &&
			r.user_action !== "rejected" &&
			r.user_action !== "duplicate",
	);

	// R4 — category fuzzy match with fail-open
	let afterCategory = baseFiltered;
	if (opts.uiCategory) {
		const targets = mapUiCategoryToSalesCategories(opts.uiCategory);
		const supplement = opts.supplementCategories ?? [];
		const matchTerms = [...targets, ...supplement, opts.uiCategory]
			.filter((s) => s.length > 0);
		if (matchTerms.length > 0) {
			const strict = baseFiltered.filter((r) => {
				const hay = `${r.category ?? ""} ${r.seed_keyword}`.toLowerCase();
				return matchTerms.some((t) => hay.includes(t.toLowerCase()));
			});
			afterCategory = strict.length >= FAIL_OPEN_THRESHOLD ? strict : baseFiltered;
		}
	}

	// R5 — price filter with NULL pass-through + fail-open
	let afterPrice = afterCategory;
	if (opts.priceRange) {
		const { min, max } = opts.priceRange;
		const strict = afterCategory.filter(
			(r) =>
				r.price_jpy === null || (r.price_jpy >= min && r.price_jpy <= max),
		);
		afterPrice = strict.length >= FAIL_OPEN_THRESHOLD ? strict : afterCategory;
	}

	return afterPrice;
}

/**
 * Query discovered_products with all filters and ordering applied.
 * Returns up to input.limit rows. Falls back gracefully on DB errors (empty array).
 */
export async function queryDiscoveredPool(
	input: PoolQueryInput,
): Promise<PoolRow[]> {
	const sb = getServiceClient();
	const lookbackDays = Number(
		process.env.STRATEGY_POOL_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS,
	);
	const sinceIso = new Date(
		Date.now() - lookbackDays * 24 * 3600 * 1000,
	).toISOString();
	const limit = input.limit ?? 30;
	// Over-fetch to give filters room; we'll trim after.
	const fetchLimit = Math.min(500, limit * 5);

	let q = sb
		.from("discovered_products")
		.select(
			"id, name, product_url, price_jpy, category, seed_keyword, tv_fit_score, tv_fit_reason, tv_channel_source, tv_tier, context, user_action, c_package, enrichment_status, review_count, review_avg, seller_name, broadcast_tag, thumbnail_url, created_at",
		)
		.eq("context", input.context)
		.gte("created_at", sinceIso)
		.order("tv_tier", { ascending: true })
		.order("tv_fit_score", { ascending: false })
		.order("created_at", { ascending: false })
		.limit(fetchLimit);

	if (input.excludeProductIds && input.excludeProductIds.length > 0) {
		q = q.not("id", "in", `(${input.excludeProductIds.join(",")})`);
	}

	const { data, error } = await q;
	if (error) {
		console.warn("[pool-query] query failed:", error.message);
		return [];
	}
	const rows = (data ?? []) as PoolRow[];

	const filtered = applyFilters(rows, {
		context: input.context,
		uiCategory: input.uiCategory,
		priceRange: input.priceRange,
		supplementCategories: input.supplementCategoriesFromSeeds,
	});

	return filtered.slice(0, limit);
}

export const __test = {
	applyFilters,
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx tsx --env-file=.env.local scripts/test-pool-query-filters.ts`
Expected: `PASS: pool-query filters (R2/R3/R4/R5)`

- [ ] **Step 5: package.json 에 test 등록**

Edit `package.json` scripts 블록에 추가:

```json
"test:pool-query": "tsx --env-file=.env.local scripts/test-pool-query-filters.ts",
```

- [ ] **Step 6: TypeScript 컴파일 확인**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add lib/strategy/pool-query.ts scripts/test-pool-query-filters.ts package.json
git commit -m "feat(strategy): add discovered_products pool query with R2-R5 filters"
```

---

## Task 3: 다중 시드 지원 — `lib/strategy/seed-context.ts` 확장

**Files:**
- Modify: `lib/strategy/seed-context.ts`
- Create: `scripts/test-multi-seed-context.ts`

R9 결정 규칙을 위한 다중 시드 로더 + 다중 프롬프트 포매터.

- [ ] **Step 1: 실패 테스트 작성**

Write to `scripts/test-multi-seed-context.ts`:

```typescript
import assert from "node:assert/strict";
import {
	formatMultiSeedPromptSection,
	type SeedContext,
} from "@/lib/strategy/seed-context";

function mkSeed(id: string, name: string, category: string): SeedContext {
	return {
		id,
		name,
		priceJpy: 12000,
		category,
		reviewCount: 50,
		reviewAvg: 4.3,
		sellerName: "test",
		productUrl: `https://example.com/${id}`,
		tvFitScore: 70,
		tvFitReason: "test reason",
		context: "home_shopping",
		broadcastTag: "unknown",
	};
}

// Empty input → empty string.
assert.equal(formatMultiSeedPromptSection([]), "", "empty seeds → empty string");

// Single seed → falls back to old single-seed section header.
{
	const txt = formatMultiSeedPromptSection([mkSeed("a", "Product A", "美容")]);
	assert.ok(txt.includes("Product A"), "single seed: name present");
	assert.ok(txt.includes("新商品候補データ"), "single seed: header present");
}

// Multi-seed → comparison block with all seed names + count.
{
	const txt = formatMultiSeedPromptSection([
		mkSeed("a", "Product A", "美容"),
		mkSeed("b", "Product B", "キッチン"),
		mkSeed("c", "Product C", "美容"),
	]);
	assert.ok(txt.includes("Product A"), "multi: A present");
	assert.ok(txt.includes("Product B"), "multi: B present");
	assert.ok(txt.includes("Product C"), "multi: C present");
	assert.ok(txt.includes("3件"), "multi: count rendered");
	assert.ok(txt.includes("複数候補比較"), "multi: comparison header");
}

console.log("PASS: multi-seed formatter");
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npx tsx --env-file=.env.local scripts/test-multi-seed-context.ts`
Expected: ERR `formatMultiSeedPromptSection is not exported from @/lib/strategy/seed-context`

- [ ] **Step 3: `loadSeedContexts` + `formatMultiSeedPromptSection` 구현**

Add to the bottom of `lib/strategy/seed-context.ts` (after the existing `formatSeedPromptSection` function):

```typescript
/**
 * Batch loader — loads multiple seed contexts. Skips IDs that 404.
 * Order is NOT guaranteed to match input.
 */
export async function loadSeedContexts(ids: string[]): Promise<SeedContext[]> {
	if (ids.length === 0) return [];
	const results = await Promise.all(ids.map((id) => loadSeedContext(id)));
	return results.filter((s): s is SeedContext => s !== null);
}

/**
 * Multi-seed prompt section. If exactly one seed, delegates to formatSeedPromptSection
 * for backward compatibility. If multiple, renders a comparison block.
 */
export function formatMultiSeedPromptSection(seeds: SeedContext[]): string {
	if (seeds.length === 0) return "";
	if (seeds.length === 1) return formatSeedPromptSection(seeds[0]);

	const lines: string[] = [];
	lines.push(`\n【複数候補比較 — ${seeds.length}件のシード商品】`);
	lines.push(`戦略立案では下記${seeds.length}件の発掘候補を中心に検討してください。`);
	lines.push(`各候補の共通点・差別化ポイント・補完関係を分析し、ポートフォリオ視点で戦略を構築してください。\n`);
	seeds.forEach((s, i) => {
		const idx = i + 1;
		lines.push(`--- 候補 ${idx}: ${s.name} ---`);
		lines.push(`- 価格: ${s.priceJpy ? `¥${s.priceJpy.toLocaleString()}` : "不明"}`);
		lines.push(`- カテゴリ: ${s.category ?? "未分類"}`);
		lines.push(`- TVフィットスコア: ${s.tvFitScore}/100`);
		lines.push(`- 楽天評価: ${s.reviewAvg ? `★${s.reviewAvg} (${s.reviewCount ?? 0}件)` : "なし"}`);
		lines.push(`- URL: ${s.productUrl}`);
		if (s.enriched) {
			const m = s.enriched.manufacturer;
			const w = s.enriched.wholesale;
			lines.push(`- 製造元: ${m.name ?? "不明"} (信頼度:${m.confidence})`);
			lines.push(
				`- 卸値推定: ${
					w.estimated_cost_jpy !== null
						? `¥${w.estimated_cost_jpy.toLocaleString()} (マージン${Math.round((w.estimated_margin_rate ?? 0) * 100)}%)`
						: "推定不可"
				}`,
			);
		}
		lines.push("");
	});
	lines.push(
		`【分析ガイダンス】\n各スキルは上記の複数候補を比較しながら戦略を生成してください。共通テーマがあればその軸で、補完関係があればクロスセル/バンドル戦略として扱ってください。\n`,
	);
	return lines.join("\n");
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx tsx --env-file=.env.local scripts/test-multi-seed-context.ts`
Expected: `PASS: multi-seed formatter`

- [ ] **Step 5: package.json 에 test 등록**

Edit `package.json` scripts 블록에 추가:

```json
"test:multi-seed": "tsx --env-file=.env.local scripts/test-multi-seed-context.ts",
```

- [ ] **Step 6: TypeScript 컴파일 확인**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add lib/strategy/seed-context.ts scripts/test-multi-seed-context.ts package.json
git commit -m "feat(strategy): support multi-seed loading and prompt formatting"
```

---

## Task 4: `discoverNewProducts` pool-first 통합 — Part A: pool 사용 분기

**Files:**
- Modify: `lib/md-strategy.ts`
- Create: `scripts/test-discover-pool-first.ts`

이 task 가 plan 의 핵심. `discoverNewProducts` 의 첫 단계로 풀 조회를 끼워넣는다. R7/R8 결정 규칙 구현.

- [ ] **Step 1: 실패 테스트 작성 — pool 충분할 때 외부 API 호출 안 함**

Write to `scripts/test-discover-pool-first.ts`:

```typescript
import assert from "node:assert/strict";
import { __test } from "@/lib/md-strategy";

// Test the pure decision helper, not the network. We expose
// `decideDiscoveryStrategy` which returns { strategy, fillNeeded } from a pool size.
const cases = [
	{ poolSize: 0,  target: 20, expected: { strategy: "fresh_only" as const, fillNeeded: 20 } },
	{ poolSize: 5,  target: 20, expected: { strategy: "pool_filled" as const, fillNeeded: 15 } },
	{ poolSize: 20, target: 20, expected: { strategy: "pool_only" as const, fillNeeded: 0 } },
	{ poolSize: 35, target: 20, expected: { strategy: "pool_only" as const, fillNeeded: 0 } },
	{ poolSize: 8,  target: 12, expected: { strategy: "pool_filled" as const, fillNeeded: 4 } },
];

for (const c of cases) {
	const got = __test.decideDiscoveryStrategy(c.poolSize, c.target);
	assert.deepEqual(got, c.expected, `pool=${c.poolSize} target=${c.target}`);
}

// R8: pool target sizes
assert.equal(__test.poolTargetSize(true), 30, "lightweight target = 30");
assert.equal(__test.poolTargetSize(false), 12, "full target = 12");

console.log("PASS: discover pool-first decision rules");
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npx tsx --env-file=.env.local scripts/test-discover-pool-first.ts`
Expected: ERR `__test.decideDiscoveryStrategy is not a function`

- [ ] **Step 3: helper 함수 추가 — `lib/md-strategy.ts`**

`lib/md-strategy.ts` 의 `discoverNewProducts` 함수 정의 **바로 위에** (line ~500) 다음을 삽입:

```typescript
// ---------------------------------------------------------------------------
// Pool-first decision helpers (plan: 2026-05-13 strategy-discovery-pool-integration)
// ---------------------------------------------------------------------------

type DiscoveryStrategyMode = "pool_only" | "pool_filled" | "fresh_only";

function poolTargetSize(lightweight: boolean): number {
	return lightweight ? 30 : 12;
}

function decideDiscoveryStrategy(
	poolSize: number,
	target: number,
): { strategy: DiscoveryStrategyMode; fillNeeded: number } {
	if (poolSize === 0) return { strategy: "fresh_only", fillNeeded: target };
	if (poolSize >= target) return { strategy: "pool_only", fillNeeded: 0 };
	return { strategy: "pool_filled", fillNeeded: target - poolSize };
}
```

그리고 파일 하단 (다른 export 옆) 에 추가:

```typescript
export const __test = {
	...(typeof (globalThis as { __test?: object }).__test === "object"
		? (globalThis as { __test?: object }).__test
		: {}),
	decideDiscoveryStrategy,
	poolTargetSize,
};
```

(만약 `__test` export 가 파일에 이미 존재하면 거기에 `decideDiscoveryStrategy`, `poolTargetSize` 두 항목만 추가하고 위 블록은 생략한다. — 사전 확인: `grep -n "export const __test" lib/md-strategy.ts`)

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx tsx --env-file=.env.local scripts/test-discover-pool-first.ts`
Expected: `PASS: discover pool-first decision rules`

- [ ] **Step 5: TypeScript 컴파일 확인**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add lib/md-strategy.ts scripts/test-discover-pool-first.ts
git commit -m "feat(strategy): add pool-first decision rules for discoverNewProducts"
```

---

## Task 5: `discoverNewProducts` pool-first 통합 — Part B: 실제 풀 조회 wire-up

**Files:**
- Modify: `lib/md-strategy.ts`

Task 4 의 helper 를 실제 함수 흐름에 연결. 풀에서 가져온 행을 `DiscoveryPoolItem` 으로 변환해 기존 `cappedPool` 에 prepend, 외부 API 호출은 `fillNeeded > 0` 일 때만.

- [ ] **Step 1: `DiscoverInput` 타입 확장**

`lib/md-strategy.ts:468` 의 `DiscoverInput` 인터페이스에 추가:

```typescript
export interface DiscoverInput {
	context: "home_shopping" | "live_commerce";
	topCategoryNames: string[];
	explicitCategory?: string;
	targetMarket?: string;
	priceRange?: string;
	userGoal?: string;
	tvProductNames: string[];
	tvMarginRate: number;
	excludeUrls?: string[];
	excludeNames?: string[];
	analysisContext?: string;
	tvProfile?: import("@/lib/tv-shopping-profile").TVShoppingProfile;
	lightweight?: boolean;
	// NEW (this plan)
	seedProductIds?: string[];          // 다중 시드 ID — pool 에서 제외
	seedCategories?: string[];          // 시드 상품 카테고리 union (보조 필터)
}
```

- [ ] **Step 2: `DiscoveryPoolItem` 타입 확장**

`lib/md-strategy.ts:492` 의 `DiscoveryPoolItem` 에 추가:

```typescript
type DiscoveryPoolItem = {
	name: string;
	price?: number;
	source: "rakuten" | "web";
	source_url: string;
	snippet: string;
	keyword: string;
	reviewCount?: number;
	reviewAverage?: number;
	// NEW
	pool_source: "discovery_pool" | "fresh_search";
	discovered_product_id?: string;     // pool 출처일 때만 채움
	tv_fit_score?: number;
	tv_fit_reason?: string;
	tv_channel_source?: string | null;
	c_package?: Record<string, unknown> | null;
};
```

- [ ] **Step 3: 풀 조회 + 결정 로직을 함수 본문에 삽입**

`lib/md-strategy.ts:503` `discoverNewProducts` 함수의 **최상단** — `const lw = !!input.lightweight;` 바로 다음에 삽입:

```typescript
	const TARGET = poolTargetSize(lw);
	const POOL_CAP = lw ? 60 : 40;

	// --- Pool-first 시도 (plan 2026-05-13) ---
	let poolItems: DiscoveryPoolItem[] = [];
	try {
		const { queryDiscoveredPool } = await import("@/lib/strategy/pool-query");
		const priceRange = input.priceRange ? parsePriceRange(input.priceRange) : null;
		const rows = await queryDiscoveredPool({
			context: input.context,
			uiCategory: input.explicitCategory,
			priceRange: priceRange ?? undefined,
			limit: TARGET,
			excludeProductIds: input.seedProductIds,
			supplementCategoriesFromSeeds: input.seedCategories,
		});
		poolItems = rows.map((r) => ({
			name: r.name,
			price: r.price_jpy ?? undefined,
			source: "rakuten",
			source_url: r.product_url,
			snippet:
				`TVフィット:${r.tv_fit_score}/100 (${r.tv_fit_reason ?? "理由なし"}) — ` +
				`カテゴリ:${r.category ?? "未分類"} — 既存発掘プール由来`,
			keyword: r.seed_keyword,
			reviewCount: r.review_count ?? undefined,
			reviewAverage: r.review_avg ?? undefined,
			pool_source: "discovery_pool",
			discovered_product_id: r.id,
			tv_fit_score: r.tv_fit_score,
			tv_fit_reason: r.tv_fit_reason ?? undefined,
			tv_channel_source: r.tv_channel_source,
			c_package: r.c_package,
		}));
	} catch (err) {
		console.warn(
			`[discover] pool query failed (continuing with fresh search): ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const decision = decideDiscoveryStrategy(poolItems.length, TARGET);
	console.log(
		`[discover] pool-first decision: poolSize=${poolItems.length} target=${TARGET} strategy=${decision.strategy} fillNeeded=${decision.fillNeeded}`,
	);
```

(주의: 기존 코드의 `const POOL_CAP = lw ? 60 : 40;` 줄은 위 블록으로 흡수되므로 **삭제**한다.)

- [ ] **Step 4: 기존 외부 검색 흐름을 조건부로 변경**

`lib/md-strategy.ts` 의 `// Build search keywords from TV signals` 주석부터 `let cappedPool = pool.slice(0, POOL_CAP);` 직전까지의 블록을 `if (decision.fillNeeded > 0)` 로 감싸고, 안에서 채워진 pool 에 `pool_source: "fresh_search"` 를 붙여 prepend 가 아닌 append 되도록 한다.

구체적으로:

```typescript
	let cappedPool: DiscoveryPoolItem[] = [...poolItems];

	if (decision.fillNeeded > 0) {
		console.log(`[discover] filling ${decision.fillNeeded} from Rakuten/Brave`);

		// (기존 코드 그대로 — Build search keywords, rakutenResults, braveProductResults,
		//  braveTrendResults, pool 빌드, exclusion 등 모두 이 블록 안)
		// ...
		// 단, pool.push({ ... }) 호출 시 pool_source: "fresh_search" 필드를 항상 포함.
		// 단, 마지막 pool.slice 대신:
		const freshExtra = pool.slice(0, POOL_CAP);
		cappedPool = [...cappedPool, ...freshExtra];
	}
```

`braveTrendResults` (시장 트렌드 컨텍스트) 도 이 블록 안에 두되, fallback 시 시드 풀이 충분한 경우엔 `japanMarketContext` 가 빈 문자열이 될 수 있으므로 다음을 `if` 블록 외부에 미리 선언해둔다:

```typescript
	let japanMarketContext = "(発掘プールベース — 個別市場検索はスキップ)";
```

`if (decision.fillNeeded > 0)` 블록 안에서 trend 결과를 받으면 `japanMarketContext = marketContextLines.join("\n")` 로 덮어쓴다.

- [ ] **Step 5: Rakuten/Brave 풀의 모든 push 지점에 `pool_source: "fresh_search"` 추가**

`lib/md-strategy.ts:614, 632, 669` 의 `pool.push({ ... })` 호출 3곳에 `pool_source: "fresh_search" as const,` 필드를 추가한다.

- [ ] **Step 6: `cappedPool.length === 0` 가드 위치 이동**

기존의 `if (cappedPool.length === 0) { ... fallback keywords ... }` 블록은 `decision.fillNeeded > 0` 블록 안에 위치해야 한다 (풀이 비었을 때만 fallback). 즉 풀이 충분한 케이스는 이 블록을 거치지 않는다. 블록을 들여쓰기로 적절히 안으로 이동.

- [ ] **Step 7: 안전 가드 추가 — cappedPool 가 여전히 비면 undefined 반환**

`if (decision.fillNeeded > 0)` 닫는 괄호 직후에:

```typescript
	if (cappedPool.length === 0) {
		console.warn(`[discover] both pool and fresh search empty — returning undefined`);
		return undefined;
	}
```

- [ ] **Step 8: 프롬프트 poolText 가 pool_source 를 노출하도록 수정**

`lib/md-strategy.ts:691` 의 `poolText` 빌더에 pool_source / tv_fit_score 정보를 추가:

```typescript
	const poolText = cappedPool
		.map((p, i) => {
			const reviewBadge = p.reviewCount && p.reviewCount > 0
				? ` ★${p.reviewAverage?.toFixed(1) ?? "?"} (レビュー${p.reviewCount}件)`
				: "";
			const sourceTag =
				p.pool_source === "discovery_pool"
					? `🟣[発掘プール TVフィット:${p.tv_fit_score ?? "?"}${p.tv_channel_source ? ` 放送実績:${p.tv_channel_source}` : ""}]`
					: `🟢[新検索 ${p.source}]`;
			return `${i}. ${sourceTag} ${p.name}${p.price ? ` (¥${p.price.toLocaleString()})` : ""}${reviewBadge} — keyword: ${p.keyword}\n   URL: ${p.source_url}\n   ${p.snippet}`;
		})
		.join("\n");
```

- [ ] **Step 9: Gemini 응답 → DiscoveredProduct 매핑 시 pool_source / discovered_product_id 복원**

`lib/md-strategy.ts` 의 `filtered` 결과를 가공하는 부분 (line ~880) 직후에 다음 로직 추가:

```typescript
	// Restore pool_source + discovered_product_id from the pool when URL matches.
	const poolIndex = new Map<string, DiscoveryPoolItem>();
	for (const p of cappedPool) {
		poolIndex.set(p.source_url, p);
	}
	const enriched = filtered.map((p) => {
		const match = poolIndex.get(p.source_url);
		if (match) {
			return {
				...p,
				pool_source: match.pool_source,
				discovered_product_id: match.discovered_product_id,
			};
		}
		return { ...p, pool_source: "fresh_search" as const };
	});
	return enriched;
```

(기존 `return filtered;` 를 위 로직으로 대체.)

- [ ] **Step 10: `DiscoveredProduct` 타입에 신규 옵션 필드 추가**

`lib/md-strategy.ts:397` `recommendedProducts?: Array<{ ... }>` 정의에 다음 필드를 추가:

```typescript
		pool_source?: "discovery_pool" | "fresh_search" | "seed";
		discovered_product_id?: string;
```

- [ ] **Step 11: TypeScript 컴파일 + 기존 테스트 회귀 확인**

Run in parallel:
- `npx tsc --noEmit`
- `npx tsx --env-file=.env.local scripts/test-discover-pool-first.ts`
- `npx tsx --env-file=.env.local scripts/test-pool-query-filters.ts`
- `npx tsx --env-file=.env.local scripts/test-multi-seed-context.ts`

Expected: 모두 PASS, 0 type errors.

- [ ] **Step 12: Commit**

```bash
git add lib/md-strategy.ts
git commit -m "feat(strategy): discoverNewProducts pool-first with fresh-search fallback"
```

---

## Task 6: Workflow 입력에 `seedProductIds` thread

**Files:**
- Modify: `lib/workflows/md-strategy.workflow.ts`
- Modify: `app/api/analytics/md-strategy/route.ts`

R9 결정 규칙의 wire-up.

- [ ] **Step 1: `MDWorkflowInput` 확장**

`lib/workflows/md-strategy.workflow.ts:18` 의 인터페이스를 다음으로 교체:

```typescript
export interface MDWorkflowInput {
	userGoal?: string;
	category?: string;
	targetMarket?: string;
	priceRange?: string;
	seedProductId?: string;          // 후방 호환 — 단일 시드
	seedProductIds?: string[];       // 신규 — 다중 시드
}
```

- [ ] **Step 2: `fetchContextStep` 에서 다중 시드 로딩**

같은 파일 30번째 줄부터의 `fetchContextStep` 함수를 다음으로 교체:

```typescript
async function fetchContextStep(input: MDWorkflowInput): Promise<StrategyContext> {
	"use step";
	const recommend: RecommendInput | undefined =
		input.category && input.targetMarket
			? { category: input.category, targetMarket: input.targetMarket, priceRange: input.priceRange }
			: undefined;
	const ctx = await fetchStrategyContext(input.userGoal || undefined, recommend);

	// Backward compat: 단일 seedProductId 가 들어오면 배열로 정규화.
	const allSeedIds = [
		...(input.seedProductId ? [input.seedProductId] : []),
		...(input.seedProductIds ?? []),
	];
	if (allSeedIds.length > 0) {
		const { loadSeedContexts } = await import("@/lib/strategy/seed-context");
		const seeds = await loadSeedContexts(allSeedIds);
		if (seeds.length > 0) {
			// 단일 시드면 기존 필드 유지 (다른 코드가 의존), 다중이면 신규 필드 사용.
			if (seeds.length === 1) {
				ctx.seedProduct = seeds[0];
			}
			(ctx as StrategyContext & { seedProducts?: typeof seeds }).seedProducts = seeds;
		}
	}
	console.log(`[md-workflow] context fetched (discovery deferred to final step), seeds=${allSeedIds.length}`);
	return ctx;
}
```

- [ ] **Step 3: `StrategyContext` 타입에 `seedProducts` 추가**

`lib/md-strategy.ts:443` 의 `seedProduct?: SeedContext;` 바로 아래에 추가:

```typescript
	seedProducts?: import("@/lib/strategy/seed-context").SeedContext[];
```

- [ ] **Step 4: `runDiscoveryStep` 에서 seed 정보를 `discoverNewProducts` 로 전달**

`lib/workflows/md-strategy.workflow.ts:49` 의 `runDiscoveryStep` 안의 `discoverNewProducts({ ... })` 호출에 추가:

```typescript
			seedProductIds: (context.seedProducts ?? []).map((s) => s.id),
			seedCategories: (context.seedProducts ?? [])
				.map((s) => s.category)
				.filter((c): c is string => !!c),
```

- [ ] **Step 5: API 라우트가 seedProductIds 수용**

`app/api/analytics/md-strategy/route.ts:27` 의 `input` 빌드 블록을 다음으로 교체:

```typescript
	const input = {
		userGoal: typeof body.userGoal === "string" ? body.userGoal : "",
		category: typeof body.category === "string" ? body.category : undefined,
		targetMarket: typeof body.targetMarket === "string" ? body.targetMarket : undefined,
		priceRange: typeof body.priceRange === "string" ? body.priceRange : undefined,
		seedProductId: typeof body.seedProductId === "string" ? body.seedProductId : undefined,
		seedProductIds: Array.isArray(body.seedProductIds)
			? body.seedProductIds.filter((s: unknown): s is string => typeof s === "string")
			: undefined,
	};
```

- [ ] **Step 6: TypeScript 컴파일 확인**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add lib/workflows/md-strategy.workflow.ts app/api/analytics/md-strategy/route.ts lib/md-strategy.ts
git commit -m "feat(strategy): thread seedProductIds[] through workflow + API"
```

---

## Task 7: 다중 시드 프롬프트 주입 — buildPrompt* 함수 수정

**Files:**
- Modify: `lib/md-strategy.ts`

기존 `formatSeedPromptSection(ctx.seedProduct)` 사용 지점을 `formatMultiSeedPromptSection(ctx.seedProducts ?? (ctx.seedProduct ? [ctx.seedProduct] : []))` 로 교체.

- [ ] **Step 1: 사용 지점 식별**

Run: `grep -n "formatSeedPromptSection\|seedProduct" lib/md-strategy.ts | head -40`

각 buildPrompt 함수 안의 `formatSeedPromptSection(ctx.seedProduct ?? null)` 호출을 모두 확인. 일반적으로 다음 위치 (각 skill builder 한 번씩):

- `buildGoalPrompt`
- `buildProductSelectionPrompt`
- `buildChannelStrategyPrompt`
- `buildPricingMarginPrompt`
- `buildMarketingExecutionPrompt`
- `buildFinancialProjectionPrompt`
- `buildRiskContingencyPrompt`

- [ ] **Step 2: import 추가**

`lib/md-strategy.ts` 상단의 imports 에 추가:

```typescript
import { formatMultiSeedPromptSection } from "@/lib/strategy/seed-context";
```

(기존 `formatSeedPromptSection` import 줄과 같이 둔다.)

- [ ] **Step 3: 호출 지점 일괄 교체**

각 buildPrompt 함수에서 `formatSeedPromptSection(ctx.seedProduct ?? null)` 형태의 호출을 다음으로 교체:

```typescript
formatMultiSeedPromptSection(
	ctx.seedProducts ?? (ctx.seedProduct ? [ctx.seedProduct] : []),
)
```

(`replace_all` 가 안전한 패턴인지 먼저 grep 결과로 확인. 패턴이 정확히 일치하면 `replace_all: true` 로 일괄 치환, 아니면 각 호출을 개별 Edit.)

- [ ] **Step 4: TypeScript 컴파일 확인**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: 기존 단일 시드 통합 회귀 — manual smoke test 가능 시점인지 메모**

E2E 동작 확인은 Task 11 에서 dev server 로 진행. 이 시점에서는 type 안전성만 확인.

- [ ] **Step 6: Commit**

```bash
git add lib/md-strategy.ts
git commit -m "feat(strategy): wire multi-seed prompt section into 6 buildPrompt functions"
```

---

## Task 8: `rediscover` 라우트도 pool-first 사용

**Files:**
- Modify: `app/api/analytics/md-strategy/[id]/rediscover/route.ts`

기존 재발굴 라우트도 풀을 먼저 본 후 부족분만 외부 검색하도록 정렬.

- [ ] **Step 1: 라우트 수정**

`app/api/analytics/md-strategy/[id]/rediscover/route.ts:75` 의 `discoverNewProducts({...})` 호출에서 자동으로 pool-first 동작이 활성화되도록, **시드 정보가 strategy 에 저장되어 있다면** 함께 전달:

```typescript
	const seedIdsFromStrategy = ((strategy.product_selection?.discovered_new_products ?? []) as Array<{ discovered_product_id?: string }>)
		.map((p) => p.discovered_product_id)
		.filter((id): id is string => !!id);

	// 3) Run discovery
	const discovered = await discoverNewProducts({
		context: "home_shopping",
		topCategoryNames,
		explicitCategory: focus || strategy.category || undefined,
		targetMarket: strategy.target_market || undefined,
		priceRange: strategy.price_range || undefined,
		userGoal: focus
			? `${strategy.user_goal ?? ""}\n追加フォーカス: ${focus}`.trim()
			: strategy.user_goal || undefined,
		tvProductNames: products.map((p) => p.product_name),
		tvMarginRate,
		excludeUrls,
		excludeNames,
		tvProfile,
		lightweight: true,
		// pool-first: 이전에 추천된 풀 항목들을 제외해 다양성 확보
		seedProductIds: seedIdsFromStrategy,
	});
```

- [ ] **Step 2: TypeScript 컴파일 확인**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/analytics/md-strategy/[id]/rediscover/route.ts
git commit -m "feat(strategy): rediscover route excludes prior pool seeds for diversity"
```

---

## Task 9: Frontend — `MDStrategyPanel` 다중 seedIds URL 파라미터

**Files:**
- Modify: `components/analytics/MDStrategyPanel.tsx`

URL `?seedIds=a,b,c` 를 파싱하고 body 에 포함. `?seedId=` 단일 형태는 후방 호환 유지.

- [ ] **Step 1: ListView 의 URL 파싱부 확장**

`components/analytics/MDStrategyPanel.tsx:392` 의 `ListView` 함수 안의 `seedProductId` 변수 정의 (line 398) 를 다음으로 교체:

```typescript
	const seedProductId = searchParams?.get("seedId") ?? null;
	const seedProductIdsRaw = searchParams?.get("seedIds") ?? null;
	const seedProductIds = seedProductIdsRaw
		? seedProductIdsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
		: null;
```

- [ ] **Step 2: 입력 폼 기본값 (`userGoal`) 다중 시드 처리**

같은 함수 line ~401 의 `useState(seedName ? ... : '')` 블록을 다음으로 교체:

```typescript
	const [userGoal, setUserGoal] = useState(() => {
		if (seedProductIds && seedProductIds.length > 1) {
			return `選択した${seedProductIds.length}件の発掘候補をポートフォリオで戦略立案`;
		}
		if (seedName) {
			return `新商品「${seedName}」の拡大戦略を立てる。${seedUrl ? ` 参考URL: ${seedUrl}` : ""}`;
		}
		return "";
	});
```

- [ ] **Step 3: body 에 seedProductIds 포함**

같은 함수 line ~474 의 `body: JSON.stringify({...})` 부분을 다음으로 교체:

```typescript
				body: JSON.stringify({
					userGoal: userGoal || undefined,
					category: category !== '指定なし' ? category : undefined,
					targetMarket: targetMarket !== '指定なし' ? targetMarket : undefined,
					priceRange: priceRange || undefined,
					seedProductId: seedProductId ?? undefined,
					seedProductIds: seedProductIds ?? undefined,
				}),
```

- [ ] **Step 4: TypeScript + lint 확인**

Run in parallel:
- `npx tsc --noEmit`
- `npm run lint`

Expected: 0 errors / 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add components/analytics/MDStrategyPanel.tsx
git commit -m "feat(strategy): parse ?seedIds= URL param and forward to API"
```

---

## Task 10: Frontend — 商品発掘 다중 선택 + 일괄 戦略立案 CTA

**Files:**
- Modify: `components/discovery/SelectionGrid.tsx`
- Modify: `components/discovery/IntegrationActions.tsx` (선택적 — 단일 카드 액션은 그대로 두고 그리드 레벨 multi-select 만 추가)

商品発掘 페이지에서 카드 여러 개에 체크박스, 하단에 "選択した N 件で戦略立案" 버튼.

- [ ] **Step 1: SelectionGrid 현재 구조 확인**

Run: `wc -l components/discovery/SelectionGrid.tsx && grep -n "export\|interface" components/discovery/SelectionGrid.tsx`

이 step 의 결과를 보고 (a) 기존 selection state 가 이미 있는지, (b) 어디에 일괄 CTA 를 끼울지 결정.

- [ ] **Step 2: 다중 선택 state 도입**

만약 SelectionGrid 가 selection state 를 보유하지 않는다면, useState 로 `selectedIds: Set<string>` 을 추가하고 ProductCard 에 `isSelected`, `onToggleSelect` props 를 thread.

(만약 이미 있다면 step 3 으로 점프.)

- [ ] **Step 3: 일괄 CTA 버튼 컴포넌트 추가**

SelectionGrid 의 그리드 위 (또는 sticky bottom) 에 다음 패널을 추가:

```tsx
{selectedIds.size >= 1 && (
	<div className="sticky bottom-0 z-10 bg-white/95 border-t border-indigo-200 px-4 py-3 flex items-center justify-between shadow-lg backdrop-blur">
		<span className="text-sm font-medium text-gray-700">
			{selectedIds.size}件選択中
		</span>
		<div className="flex gap-2">
			<button
				type="button"
				onClick={() => setSelectedIds(new Set())}
				className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700"
			>
				クリア
			</button>
			<button
				type="button"
				onClick={() => {
					const ids = [...selectedIds].join(",");
					router.push(
						`/${locale}/analytics/strategy/expansion?seedIds=${encodeURIComponent(ids)}`,
					);
				}}
				disabled={selectedIds.size === 0}
				className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg disabled:opacity-50"
			>
				<TrendingUp size={14} />
				選択した{selectedIds.size}件で戦略立案
			</button>
		</div>
	</div>
)}
```

(`useRouter`, `useParams` from `next/navigation`, `TrendingUp` from `lucide-react` import 가 SelectionGrid 상단에 있는지 확인하고 없으면 추가.)

- [ ] **Step 4: ProductCard 에 체크박스 prop 추가**

`components/discovery/ProductCard.tsx` 의 props 인터페이스에 추가:

```typescript
isSelected?: boolean;
onToggleSelect?: (id: string) => void;
```

카드 좌상단에 체크박스 렌더:

```tsx
{onToggleSelect && (
	<input
		type="checkbox"
		checked={!!isSelected}
		onChange={() => onToggleSelect(p.id)}
		className="absolute top-2 left-2 w-4 h-4 accent-indigo-600"
		onClick={(e) => e.stopPropagation()}
	/>
)}
```

(정확한 카드 외곽 컴포넌트 구조에 따라 `relative` 부모 + `absolute` 위치를 조정.)

- [ ] **Step 5: TypeScript + lint 확인**

Run in parallel:
- `npx tsc --noEmit`
- `npm run lint`

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add components/discovery/SelectionGrid.tsx components/discovery/ProductCard.tsx
git commit -m "feat(discovery): multi-select cards with bulk 戦略立案 CTA"
```

---

## Task 11: Frontend — `DiscoveredProductsHero` pool-source 배지

**Files:**
- Modify: `components/analytics/DiscoveredProductsHero.tsx`

전략 리포트에 노출되는 추천 상품 카드에 출처 배지를 추가해, 어느 상품이 발굴 풀에서 왔는지(=AI 학습 누적분), 어느 상품이 신검색에서 왔는지 시각적으로 구분.

- [ ] **Step 1: ProductCard 내부에 배지 렌더 추가**

`components/analytics/DiscoveredProductsHero.tsx:28` 의 ProductCard 컴포넌트 안, `source === 'rakuten' ? '楽天' : 'Web'` 배지 옆에 다음 추가:

```tsx
{p.pool_source === 'discovery_pool' && (
	<span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-purple-100 text-purple-700">
		発掘プール
	</span>
)}
{p.pool_source === 'fresh_search' && (
	<span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-700">
		新検索
	</span>
)}
{p.pool_source === 'seed' && (
	<span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-amber-100 text-amber-700">
		シード
	</span>
)}
```

- [ ] **Step 2: hero 상단에 카운트 요약 추가**

Hero 컴포넌트 상단 (products.length 표시 근처) 에 추가:

```tsx
{(() => {
	const pool = products.filter((p) => p.pool_source === 'discovery_pool').length;
	const fresh = products.filter((p) => p.pool_source === 'fresh_search').length;
	if (pool === 0 && fresh === 0) return null;
	return (
		<p className="text-[11px] text-gray-500 mt-1">
			発掘プール由来: <span className="font-semibold text-purple-700">{pool}件</span> /
			新検索: <span className="font-semibold text-emerald-700">{fresh}件</span>
		</p>
	);
})()}
```

- [ ] **Step 3: TypeScript 확인**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: dev server 에서 시각 확인**

Run: `npm run dev` (background, port 3000)

브라우저에서:
1. `/ja/analytics/discovery/home` → 카드 2개에 체크 → "選択した 2 件で戦略立案" 클릭
2. URL 이 `/ja/analytics/strategy/expansion?seedIds=<id1>,<id2>` 가 되는지 확인
3. 전략 생성을 시작 → 워크플로 진행 중 로그에서 `[discover] pool-first decision: poolSize=...` 가 출력되는지 확인
4. 완료 후 detail 페이지에서 hero 카드에 발掘プール 배지 + 카운트 요약이 표시되는지 확인

(시각 확인이 어려울 시 명시적으로 "UI 시각 확인 불가" 라고 보고하고 다음 task 진행.)

- [ ] **Step 5: Commit**

```bash
git add components/analytics/DiscoveredProductsHero.tsx
git commit -m "feat(strategy): show pool-source badges + count summary in hero"
```

---

## Task 12: 문서화 + verification

**Files:**
- Modify: `CLAUDE.md`
- Create: `scripts/test-pool-query-fallback.ts`

플로우를 CLAUDE.md 에 1단락 추가하고, fallback 시나리오를 통합 테스트로 묶는다.

- [ ] **Step 1: fallback 통합 테스트 작성**

Write to `scripts/test-pool-query-fallback.ts`:

```typescript
import assert from "node:assert/strict";
import { __test as poolTest } from "@/lib/strategy/pool-query";
import { __test as discoverTest } from "@/lib/md-strategy";

// Pool decision sanity — already covered, but verify both modules align.
const lwTarget = discoverTest.poolTargetSize(true);
const fullTarget = discoverTest.poolTargetSize(false);
assert.equal(lwTarget, 30);
assert.equal(fullTarget, 12);

// Decision crosswalk
const d1 = discoverTest.decideDiscoveryStrategy(0, lwTarget);
assert.equal(d1.strategy, "fresh_only");
assert.equal(d1.fillNeeded, lwTarget);

const d2 = discoverTest.decideDiscoveryStrategy(15, lwTarget);
assert.equal(d2.strategy, "pool_filled");
assert.equal(d2.fillNeeded, lwTarget - 15);

const d3 = discoverTest.decideDiscoveryStrategy(lwTarget + 5, lwTarget);
assert.equal(d3.strategy, "pool_only");
assert.equal(d3.fillNeeded, 0);

console.log("PASS: pool-query + discover decision integration");
```

- [ ] **Step 2: package.json 에 test 등록 + 통합 alias**

Edit `package.json` scripts:

```json
"test:pool-fallback": "tsx --env-file=.env.local scripts/test-pool-query-fallback.ts",
"test:strategy-pool": "npm run test:pool-query && npm run test:multi-seed && npm run test:discovery-pool-first && npm run test:pool-fallback",
"test:discovery-pool-first": "tsx --env-file=.env.local scripts/test-discover-pool-first.ts"
```

- [ ] **Step 3: 모든 신규 테스트 일괄 실행**

Run: `npm run test:strategy-pool`
Expected: 4 PASS 라인 (pool-query filters, multi-seed formatter, discover decision, pool-fallback integration).

- [ ] **Step 4: CLAUDE.md 업데이트**

`CLAUDE.md` 의 "### Discovery TV Channel Source (extends home_shopping)" 섹션 **바로 다음에** 신규 섹션 삽입:

```markdown
### Strategy ↔ Discovery Pool 統合 (2026-05-13)

- 戦略立案 (`/api/analytics/md-strategy`) 의 신상품 발굴 (`discoverNewProducts`) 은 항상 `discovered_products` 풀을 1차 소스로 사용한다.
- Pool query: `lib/strategy/pool-query.ts` — context · category(fuzzy via `CATEGORY_MAPPING`) · price · 60일 lookback · `tv_tier ASC, tv_fit_score DESC` 정렬.
- Lightweight 모드(워크플로 기본): pool target 30. Full 모드: target 12. 풀이 채워지면 Rakuten/Brave 외부 호출 skip; 부족분만 fresh search 로 채움.
- 다중 시드: URL `?seedIds=a,b,c` 또는 body `seedProductIds: string[]` → 모든 시드의 `c_package` 가 Gemini 프롬프트에 주입 (`formatMultiSeedPromptSection`), 시드 ID 는 pool query 에서 자동 제외.
- 출처 태그: `pool_source: 'discovery_pool' | 'fresh_search' | 'seed'` + `discovered_product_id` 를 추천 상품에 부착해 UI 배지로 노출.
- Fail-open: 카테고리/가격 필터 결과가 5개 미만이면 해당 필터를 무시 (관대 매치). 풀이 완전히 비면 기존 fresh-only 경로로 폴백.
- Env: `STRATEGY_POOL_LOOKBACK_DAYS` (default 60).
- Test alias: `npm run test:strategy-pool`.
```

- [ ] **Step 5: TypeScript + lint 최종 확인**

Run in parallel:
- `npx tsc --noEmit`
- `npm run lint`
- `npm run test:strategy-pool`

Expected: 0 errors, 모든 test PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/test-pool-query-fallback.ts package.json CLAUDE.md
git commit -m "docs(strategy): document pool-first integration and bundle tests"
```

---

## Verification Summary

이 plan 완료 후 다음이 동작해야 한다:

1. **상품 발굴 페이지** (`/ja/analytics/discovery/home`)
   - 카드 좌상단에 체크박스
   - 1개 이상 선택 시 하단 sticky 바에 "選択した N 件で戦略立案" 버튼
   - 클릭 시 `?seedIds=<csv>` 로 戦略立案 라우팅

2. **戦略立案 페이지** (`/ja/analytics/strategy/expansion`)
   - URL 의 `?seedIds=` 파싱하여 body 에 전달
   - 단일 시드(`?seedId=`) 후방 호환 유지
   - goal 입력만 한 케이스도 자동으로 발굴 풀 우선 사용

3. **discoverNewProducts (서버)**
   - 풀 조회 → 충분 시 외부 검색 skip
   - 부족 시 부족분만 Rakuten/Brave 로 채움
   - 풀 빈 경우 기존 동작과 동일
   - 콘솔 로그에 `[discover] pool-first decision: poolSize=X target=Y strategy=...` 출력

4. **결과 hero**
   - 각 추천 상품에 `발掘プール` (purple) / `新検索` (green) / `シード` (amber) 배지
   - 상단 카운트 요약 표시

5. **AI 학습 보존**
   - 商品発掘 의 매일 cron 발굴 + 학습 (`learning_state`, `feedback_events`) 은 **변경 없음**
   - 풀 안의 후보들은 매일 점수 갱신/축적되며, 戦略立案 이 자동으로 최신 풀을 활용
   - 사용자 피드백("거절") 이 戦略立案 결과에서도 자동 반영 (R2 제외 규칙)

---

## Self-Review

**1. Spec coverage:** 사용자 요구 4개를 각 task 에 매핑.
- "발굴 풀을 1차 소스로 사용" → Task 4, 5
- "조건으로 좁혀 검색" → Task 2 (필터 R3/R4/R5)
- "AI 학습/발굴 퀄리티 그대로 누적" → Task 4-5 가 `discovered_products` 를 그대로 읽으므로 발굴 파이프라인 미변경
- "팔 전략까지 도출" → 기존 6 skill 워크플로가 그대로 작동 + 다중 시드 프롬프트(Task 7)

**2. Placeholder scan:** 모든 step 에 구체 코드/명령 포함. "기존 코드 그대로" 표현은 Task 5 의 Step 4 에서 사용했으나 직전 ref(파일·라인 범위) 와 함께 명시되었으므로 reproducible.

**3. Type consistency:**
- `DiscoveryStrategyMode = "pool_only" | "pool_filled" | "fresh_only"` (Task 4)
- `pool_source: "discovery_pool" | "fresh_search" | "seed"` (Task 5, 11) — 일관됨
- `seedProductIds: string[]` Task 5–9 모두 동일 시그니처
- `PoolRow` Task 2 → Task 5 의 `rows.map((r) => ...)` 에서 r.id, r.name, r.price_jpy 등 필드 사용 — Task 2 의 select 컬럼과 모두 일치
