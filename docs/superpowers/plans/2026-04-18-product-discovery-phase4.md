# Product Discovery Phase 4 — Feedback & Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 피드백 4버튼(소싱/관심/거절/중복) + 거절 이유 모달 + 토글 동작을 구현하고, 매일 23:45 UTC에 실행되는 learning cron이 context별 learning_state를 갱신하여 다음 발굴 cron에 반영되도록 구축한다.

**Architecture:** `learning_state` 테이블을 context PK로 재구조화 (home/live 2 rows). 피드백 API는 `product_feedback` 이벤트 로그 + `discovered_products.user_action` 동시 업데이트. 토글 해제 시 로그는 생략하고 state만 NULL. Learning cron은 최근 30일 피드백을 context별로 집계하여 category_weights / rejected_seeds / exploration_ratio 갱신. exclusion.ts는 sourced/duplicate user_action을 영구 제외 필터에 추가.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (PostgreSQL), Tailwind CSS 4, next-intl, lucide-react icons.

**Spec reference:** `docs/superpowers/specs/2026-04-18-product-discovery-phase4-design.md`

**Phase 1-3.5 완료 상태:** context split, enrichment, history page, integration buttons 완성. PR #7 open. 이 Phase 4는 같은 브랜치(`feature/product-discovery-phase1`) 위에 누적 커밋.

**Out of scope for Phase 4:** Phase 5 weekly-insights cron + insights 대시보드 + 차트.

---

## File Structure

**Create:**
```
supabase/migrations/2026-04-18_learning_per_context.sql
app/api/discovery/feedback/route.ts
app/api/cron/daily-learning/route.ts
lib/discovery/learning.ts
components/discovery/FeedbackButtons.tsx
components/discovery/RejectDialog.tsx
```

**Modify:**
```
lib/discovery/exclusion.ts                     — add sourced/duplicate exclusion
app/api/cron/daily-discovery-home/route.ts     — loadLearningState('home_shopping')
app/api/cron/daily-discovery-live/route.ts    — loadLearningState('live_commerce')
scripts/test-discovery-dry-run.ts              — update learning_state query (PK change)
components/discovery/ProductCard.tsx           — integrate FeedbackButtons + RejectDialog
messages/ja.json, messages/en.json             — feedback + reject reason keys
vercel.json                                    — add daily-learning cron + function timeouts
```

---

## Task 1: DB migration SQL

**Files:**
- Create: `supabase/migrations/2026-04-18_learning_per_context.sql`

- [ ] **Step 1: 파일 생성**

Write to `supabase/migrations/2026-04-18_learning_per_context.sql`:

```sql
-- Phase 4: split learning_state per context

-- Step 1: add context column as nullable
ALTER TABLE learning_state
  ADD COLUMN IF NOT EXISTS context text
    CHECK (context IN ('home_shopping', 'live_commerce'));

-- Step 2: assign existing row(s) to home_shopping
UPDATE learning_state SET context = 'home_shopping' WHERE context IS NULL;

-- Step 3: make context NOT NULL
ALTER TABLE learning_state ALTER COLUMN context SET NOT NULL;

-- Step 4: drop old PK + id column + CHECK (id = 1) constraint
ALTER TABLE learning_state DROP CONSTRAINT IF EXISTS learning_state_pkey;
ALTER TABLE learning_state DROP CONSTRAINT IF EXISTS learning_state_id_check;
ALTER TABLE learning_state DROP COLUMN IF EXISTS id;

-- Step 5: add new PK on context
ALTER TABLE learning_state ADD PRIMARY KEY (context);

-- Step 6: insert live_commerce row if not exists
INSERT INTO learning_state (context)
  VALUES ('live_commerce')
  ON CONFLICT (context) DO NOTHING;
```

- [ ] **Step 2: 커밋**

```bash
git add supabase/migrations/2026-04-18_learning_per_context.sql
git commit -m "feat(db): migrate learning_state to context-based PK (home/live split)"
```

---

## Task 2: 사용자 수동 마이그레이션 실행

**Files:** (사용자 액션, 코드 변경 없음. Task 1 파일 작성 후 Task 6 이전에 수행.)

- [ ] **Step 1: Supabase Studio → SQL Editor 에서 실행**

Task 1에서 작성한 SQL 전체를 복사하여 SQL Editor 에 붙여넣고 **Run**.

- [ ] **Step 2: 검증**

```sql
-- Context PK 확인
SELECT context, is_cold_start, exploration_ratio, feedback_sample_size
FROM learning_state
ORDER BY context;
-- expected: 2 rows (home_shopping, live_commerce) both with defaults
```

```sql
-- 기존 singleton constraint 제거 확인
SELECT constraint_name FROM information_schema.table_constraints
WHERE table_name = 'learning_state';
-- expected: PRIMARY KEY on context, NO id-related check
```

---

## Task 3: `lib/discovery/exclusion.ts` — sourced/duplicate 제외 추가

**Files:**
- Modify: `lib/discovery/exclusion.ts`

- [ ] **Step 1: 타입에 신규 필드 추가**

Open `lib/discovery/exclusion.ts`. Find the import of types and update:

```typescript
import type { ExclusionContext, LearningState, PoolItem } from "./types";
```

(Assuming ExclusionContext type will need extension — it already has 6 fields. Add 2 new fields in `lib/discovery/types.ts` first.)

Open `lib/discovery/types.ts` and update `ExclusionContext`:

```typescript
export interface ExclusionContext {
	ownSourcedNames: string[];
	recentDiscoveredUrls: Set<string>;
	crossSessionRakutenCodes: Set<string>;
	rejectedUrls: Set<string>;
	rejectedBrands: Set<string>;
	rejectedTerms: string[];
	feedbackSourcedUrls: Set<string>;
	feedbackSourcedCodes: Set<string>;
}
```

- [ ] **Step 2: `loadExclusionContext` 에 신규 쿼리 추가**

In `lib/discovery/exclusion.ts`, modify `loadExclusionContext`. Find the Promise.all block that fetches 3 queries and add a 4th:

```typescript
export async function loadExclusionContext(
	learning: LearningState,
): Promise<ExclusionContext> {
	const sb = getServiceClient();

	const [ownRes, recentRes, codesRes, feedbackRes] = await Promise.all([
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
		sb
			.from("discovered_products")
			.select("product_url, rakuten_item_code")
			.in("user_action", ["sourced", "duplicate"]),
	]);

	if (ownRes.error) {
		console.warn(
			"[exclusion] product_summaries query failed:",
			ownRes.error.message,
		);
	}
	if (recentRes.error) {
		console.warn(
			"[exclusion] discovered_products (7d) query failed:",
			recentRes.error.message,
		);
	}
	if (codesRes.error) {
		console.warn(
			"[exclusion] discovered_products (codes) query failed:",
			codesRes.error.message,
		);
	}
	if (feedbackRes.error) {
		console.warn(
			"[exclusion] discovered_products (feedback sourced) query failed:",
			feedbackRes.error.message,
		);
	}

	const ownSourcedNames = (ownRes.data ?? [])
		.map((r: { product_name: string | null }) =>
			r.product_name ? normalizeName(r.product_name) : "",
		)
		.filter((s) => s.length >= OWN_NAME_PREFIX_LEN);

	const recentDiscoveredUrls = new Set(
		(recentRes.data ?? []).map((r: { product_url: string }) => r.product_url),
	);

	const crossSessionRakutenCodes = new Set(
		(codesRes.data ?? [])
			.map((r: { rakuten_item_code: string | null }) => r.rakuten_item_code)
			.filter((c): c is string => !!c),
	);

	const feedbackRows = (feedbackRes.data ?? []) as Array<{
		product_url: string;
		rakuten_item_code: string | null;
	}>;
	const feedbackSourcedUrls = new Set(feedbackRows.map((r) => r.product_url));
	const feedbackSourcedCodes = new Set(
		feedbackRows.map((r) => r.rakuten_item_code).filter((c): c is string => !!c),
	);

	return {
		ownSourcedNames,
		recentDiscoveredUrls,
		crossSessionRakutenCodes,
		rejectedUrls: new Set(learning.rejected_seeds.urls),
		rejectedBrands: new Set(learning.rejected_seeds.brands),
		rejectedTerms: learning.rejected_seeds.terms,
		feedbackSourcedUrls,
		feedbackSourcedCodes,
	};
}
```

- [ ] **Step 3: `applyExclusions` 에 신규 필터 추가**

Update `applyExclusions` function body to check new fields. Find the filter predicate and add after the existing cross-session check:

```typescript
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

		// 4. user feedback sourced/duplicate (permanent exclusion)
		if (ctx.feedbackSourcedUrls.has(item.productUrl)) return false;
		if (
			item.rakutenItemCode &&
			ctx.feedbackSourcedCodes.has(item.rakutenItemCode)
		)
			return false;

		// 5. rejected seeds (context-specific via learning.rejected_seeds)
		if (ctx.rejectedUrls.has(item.productUrl)) return false;
		if (item.sellerName && ctx.rejectedBrands.has(item.sellerName)) return false;
		for (const term of ctx.rejectedTerms) {
			if (term && item.name.includes(term)) return false;
		}

		return true;
	});
}
```

- [ ] **Step 4: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/discovery/types.ts lib/discovery/exclusion.ts
git commit -m "feat(discovery): add sourced/duplicate permanent exclusion from user feedback"
```

---

## Task 4: Update `loadLearningState` — context parameter in 3 places

**Files:**
- Modify: `app/api/cron/daily-discovery-home/route.ts`
- Modify: `app/api/cron/daily-discovery-live/route.ts`
- Modify: `scripts/test-discovery-dry-run.ts`

**Depends on:** Task 2 (DB migration done — learning_state now uses context PK).

- [ ] **Step 1: `daily-discovery-home/route.ts` 수정**

Find the `loadLearningState` function. Replace:

```typescript
		const { data, error } = await sb
			.from("learning_state")
			.select("*")
			.eq("id", 1)
			.single();
```

With:

```typescript
		const { data, error } = await sb
			.from("learning_state")
			.select("*")
			.eq("context", "home_shopping")
			.single();
```

- [ ] **Step 2: `daily-discovery-live/route.ts` 수정**

Same change but `.eq("context", "live_commerce")`.

- [ ] **Step 3: `scripts/test-discovery-dry-run.ts` 수정**

Find same pattern and default to `home_shopping`:

```typescript
		const { data, error } = await sb
			.from("learning_state")
			.select("*")
			.eq("context", "home_shopping")
			.single();
```

- [ ] **Step 4: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add app/api/cron/daily-discovery-home/route.ts app/api/cron/daily-discovery-live/route.ts scripts/test-discovery-dry-run.ts
git commit -m "feat(discovery): load learning_state by context (id=1 → context=home/live)"
```

---

## Task 5: `lib/discovery/learning.ts` — aggregation logic

**Files:**
- Create: `lib/discovery/learning.ts`

- [ ] **Step 1: 파일 생성**

Write to `lib/discovery/learning.ts`:

```typescript
/**
 * Learning aggregation — computes context-specific learning_state values
 * from the last 30 days of product_feedback + discovered_products.
 * Ref: spec §5 Phase 4.
 *
 * Sources:
 *  - discovered_products.user_action: current toggle state (respects undo)
 *  - product_feedback (action='deep_dive'): implicit interest signal
 */

import { getServiceClient } from "@/lib/supabase";
import type { Context } from "./types";

const WINDOW_DAYS = 30;
const COLD_START_THRESHOLD = 10;
const EXPLORATION_ADJUST_STEP = 0.05;
const EXPLORATION_MIN = 0.2;
const EXPLORATION_MAX = 0.67;
const EXPLORATION_LOSS_MARGIN = 0.1;
const CATEGORY_MIN_SAMPLES = 5;
const REJECTION_TOP_N = 5;

export interface ContextLearningStats {
	exploration_ratio: number;
	category_weights: Record<string, number>;
	rejected_seeds: { urls: string[]; brands: string[]; terms: string[] };
	recent_rejection_reasons: Array<{ reason: string; count: number }>;
	feedback_sample_size: number;
	is_cold_start: boolean;
}

interface ExplicitRow {
	category: string | null;
	seller_name: string | null;
	product_url: string;
	track: "tv_proven" | "exploration";
	user_action: "sourced" | "interested" | "rejected" | "duplicate";
	action_reason: string | null;
}

interface ShownRow {
	category: string | null;
	track: "tv_proven" | "exploration";
}

interface DeepDiveRow {
	discovered_products: { category: string | null; track: "tv_proven" | "exploration" } | null;
}

function unique<T>(arr: T[]): T[] {
	return [...new Set(arr)];
}

export async function computeContextLearning(
	context: Context,
	currentExplorationRatio: number,
): Promise<ContextLearningStats> {
	const sb = getServiceClient();
	const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

	// Query 1: explicit actions (current state respects toggle-off)
	const { data: explicitData, error: exErr } = await sb
		.from("discovered_products")
		.select("category, seller_name, product_url, track, user_action, action_reason")
		.eq("context", context)
		.not("user_action", "is", null)
		.gte("action_at", since);

	if (exErr) {
		console.warn(`[learning] explicit query failed (${context}):`, exErr.message);
	}
	const explicit = (explicitData ?? []) as ExplicitRow[];

	// Query 2: all shown products (for success-rate denominator)
	const { data: shownData, error: shErr } = await sb
		.from("discovered_products")
		.select("category, track")
		.eq("context", context)
		.gte("created_at", since);

	if (shErr) {
		console.warn(`[learning] shown query failed (${context}):`, shErr.message);
	}
	const shown = (shownData ?? []) as ShownRow[];

	// Query 3: deep_dive events
	const { data: ddData, error: ddErr } = await sb
		.from("product_feedback")
		.select("discovered_products!inner(category, track, context)")
		.eq("action", "deep_dive")
		.eq("discovered_products.context", context)
		.gte("created_at", since);

	if (ddErr) {
		console.warn(`[learning] deep_dive query failed (${context}):`, ddErr.message);
	}
	const deepDives = (ddData ?? []) as unknown as DeepDiveRow[];

	// feedback_sample_size = explicit actions + deep_dives
	const feedbackSampleSize = explicit.length + deepDives.length;

	const isColdStart = feedbackSampleSize < COLD_START_THRESHOLD;

	if (isColdStart) {
		return {
			exploration_ratio: currentExplorationRatio,
			category_weights: {},
			rejected_seeds: { urls: [], brands: [], terms: [] },
			recent_rejection_reasons: [],
			feedback_sample_size: feedbackSampleSize,
			is_cold_start: true,
		};
	}

	// category_weights: success_rate per category
	// success = sourced + interested + deep_dive (count)
	// shown = all discovered products in category
	const categoryStats = new Map<string, { success: number; shown: number }>();
	for (const s of shown) {
		const cat = s.category;
		if (!cat) continue;
		const stat = categoryStats.get(cat) ?? { success: 0, shown: 0 };
		stat.shown += 1;
		categoryStats.set(cat, stat);
	}
	for (const e of explicit) {
		if (!e.category) continue;
		if (e.user_action === "sourced" || e.user_action === "interested") {
			const stat = categoryStats.get(e.category) ?? { success: 0, shown: 0 };
			stat.success += 1;
			categoryStats.set(e.category, stat);
		}
	}
	for (const d of deepDives) {
		const cat = d.discovered_products?.category;
		if (!cat) continue;
		const stat = categoryStats.get(cat) ?? { success: 0, shown: 0 };
		stat.success += 1;
		categoryStats.set(cat, stat);
	}

	const categoryWeights: Record<string, number> = {};
	for (const [cat, { success, shown: total }] of categoryStats) {
		if (total < CATEGORY_MIN_SAMPLES) {
			categoryWeights[cat] = 0.5;
		} else {
			categoryWeights[cat] = Number((success / total).toFixed(3));
		}
	}

	// rejected_seeds
	const rejected = explicit.filter((e) => e.user_action === "rejected");
	const rejectedUrls = unique(rejected.map((r) => r.product_url));
	const rejectedBrands = unique(
		rejected.map((r) => r.seller_name).filter((s): s is string => !!s),
	);

	// recent_rejection_reasons
	const reasonCounts = new Map<string, number>();
	for (const r of rejected) {
		if (!r.action_reason) continue;
		reasonCounts.set(r.action_reason, (reasonCounts.get(r.action_reason) ?? 0) + 1);
	}
	const recentRejectionReasons = [...reasonCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, REJECTION_TOP_N)
		.map(([reason, count]) => ({ reason, count }));

	// exploration_ratio adjustment
	const trackStats = {
		tv_proven: { success: 0, shown: 0 },
		exploration: { success: 0, shown: 0 },
	};
	for (const s of shown) trackStats[s.track].shown += 1;
	for (const e of explicit) {
		if (e.user_action === "sourced" || e.user_action === "interested") {
			trackStats[e.track].success += 1;
		}
	}
	for (const d of deepDives) {
		const track = d.discovered_products?.track;
		if (track) trackStats[track].success += 1;
	}

	const tvRate =
		trackStats.tv_proven.shown > 0
			? trackStats.tv_proven.success / trackStats.tv_proven.shown
			: 0;
	const expRate =
		trackStats.exploration.shown > 0
			? trackStats.exploration.success / trackStats.exploration.shown
			: 0;

	let nextRatio = currentExplorationRatio;
	if (feedbackSampleSize >= 20) {
		if (expRate >= tvRate) {
			nextRatio = Math.min(EXPLORATION_MAX, currentExplorationRatio + EXPLORATION_ADJUST_STEP);
		} else if (expRate < tvRate - EXPLORATION_LOSS_MARGIN) {
			nextRatio = Math.max(EXPLORATION_MIN, currentExplorationRatio - EXPLORATION_ADJUST_STEP);
		}
	}

	return {
		exploration_ratio: Number(nextRatio.toFixed(2)),
		category_weights: categoryWeights,
		rejected_seeds: { urls: rejectedUrls, brands: rejectedBrands, terms: [] },
		recent_rejection_reasons: recentRejectionReasons,
		feedback_sample_size: feedbackSampleSize,
		is_cold_start: false,
	};
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/discovery/learning.ts
git commit -m "feat(discovery): add learning.ts aggregation (category weights, rejected seeds, exploration ratio)"
```

---

## Task 6: `POST /api/discovery/feedback` endpoint

**Files:**
- Create: `app/api/discovery/feedback/route.ts`

- [ ] **Step 1: 파일 생성**

Write to `app/api/discovery/feedback/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 10;

type Action = "sourced" | "interested" | "rejected" | "duplicate";
const VALID_ACTIONS: Action[] = ["sourced", "interested", "rejected", "duplicate"];

const VALID_REASONS = [
	"価格帯不適合",
	"カテゴリ過飽和",
	"既に放送中",
	"品質懸念",
	"その他",
];

interface FeedbackBody {
	productId: string;
	action: Action;
	reason?: string;
}

export async function POST(req: NextRequest) {
	let body: FeedbackBody;
	try {
		body = (await req.json()) as FeedbackBody;
	} catch {
		return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
	}

	if (!body.productId) {
		return NextResponse.json({ error: "productId required" }, { status: 400 });
	}
	if (!VALID_ACTIONS.includes(body.action)) {
		return NextResponse.json({ error: "invalid action" }, { status: 400 });
	}
	if (body.action === "rejected" && !VALID_REASONS.includes(body.reason ?? "")) {
		return NextResponse.json(
			{ error: "reason required and must be one of: " + VALID_REASONS.join(", ") },
			{ status: 400 },
		);
	}

	const sb = getServiceClient();

	const { data: product, error: prodErr } = await sb
		.from("discovered_products")
		.select("id, user_action")
		.eq("id", body.productId)
		.maybeSingle();

	if (prodErr) {
		return NextResponse.json({ error: prodErr.message }, { status: 500 });
	}
	if (!product) {
		return NextResponse.json({ error: "product not found" }, { status: 404 });
	}

	const isToggleOff = product.user_action === body.action;
	const now = new Date().toISOString();

	if (isToggleOff) {
		// Toggle OFF: clear user_action only. Skip event log (per spec).
		const { error: updErr } = await sb
			.from("discovered_products")
			.update({ user_action: null, action_reason: null, action_at: null })
			.eq("id", body.productId);
		if (updErr) {
			return NextResponse.json({ error: updErr.message }, { status: 500 });
		}
		return NextResponse.json({
			ok: true,
			action: "toggled_off",
			user_action: null,
		});
	}

	// Set / overwrite: log event + update state
	const reason = body.action === "rejected" ? body.reason ?? null : null;

	const [insertRes, updRes] = await Promise.all([
		sb.from("product_feedback").insert({
			discovered_product_id: body.productId,
			action: body.action,
			reason,
		}),
		sb
			.from("discovered_products")
			.update({ user_action: body.action, action_reason: reason, action_at: now })
			.eq("id", body.productId),
	]);

	if (insertRes.error) {
		console.warn(`[feedback] insert failed:`, insertRes.error.message);
	}
	if (updRes.error) {
		return NextResponse.json({ error: updRes.error.message }, { status: 500 });
	}

	return NextResponse.json({
		ok: true,
		action: "set",
		user_action: body.action,
	});
}
```

- [ ] **Step 2: vercel.json 타임아웃 추가**

In `vercel.json` add to `functions`:
```json
"app/api/discovery/feedback/route.ts": { "maxDuration": 10 }
```

- [ ] **Step 3: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add app/api/discovery/feedback/route.ts vercel.json
git commit -m "feat(discovery): add feedback API (toggle + reject reason)"
```

---

## Task 7: `GET /api/cron/daily-learning` endpoint

**Files:**
- Create: `app/api/cron/daily-learning/route.ts`

**Depends on:** Tasks 2, 5.

- [ ] **Step 1: 파일 생성**

Write to `app/api/cron/daily-learning/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { computeContextLearning } from "@/lib/discovery/learning";
import { getServiceClient } from "@/lib/supabase";
import type { Context } from "@/lib/discovery/types";

export const maxDuration = 60;

const CONTEXTS: Context[] = ["home_shopping", "live_commerce"];

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

	const sb = getServiceClient();
	const results: Array<{ context: Context; ok: boolean; error?: string }> = [];

	for (const context of CONTEXTS) {
		try {
			const { data: current } = await sb
				.from("learning_state")
				.select("exploration_ratio")
				.eq("context", context)
				.single();

			const currentRatio = Number(current?.exploration_ratio ?? 0.47);

			const stats = await computeContextLearning(context, currentRatio);

			const { error: upsertErr } = await sb.from("learning_state").upsert(
				{
					context,
					exploration_ratio: stats.exploration_ratio,
					category_weights: stats.category_weights,
					rejected_seeds: stats.rejected_seeds,
					recent_rejection_reasons: stats.recent_rejection_reasons,
					feedback_sample_size: stats.feedback_sample_size,
					is_cold_start: stats.is_cold_start,
					updated_at: new Date().toISOString(),
				},
				{ onConflict: "context" },
			);

			if (upsertErr) {
				throw new Error(upsertErr.message);
			}
			results.push({ context, ok: true });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[daily-learning] ${context} failed:`, msg);
			results.push({ context, ok: false, error: msg });
		}
	}

	return NextResponse.json({ results });
}
```

- [ ] **Step 2: `vercel.json` 업데이트**

Add to `functions` block:
```json
"app/api/cron/daily-learning/route.ts": { "maxDuration": 60 }
```

Add to `crons` array:
```json
{ "path": "/api/cron/daily-learning", "schedule": "45 23 * * *" }
```

- [ ] **Step 3: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add app/api/cron/daily-learning/route.ts vercel.json
git commit -m "feat(discovery): add daily-learning cron (23:45 UTC, per-context aggregation)"
```

---

## Task 8: i18n feedback keys

**Files:**
- Modify: `messages/ja.json`
- Modify: `messages/en.json`

- [ ] **Step 1: `messages/ja.json` discovery 블록에 추가**

Add inside the existing `discovery` object:

```json
"sourceButton": "ソーシング済み",
"interestedButton": "関心あり",
"rejectedButton": "却下",
"duplicateButton": "既にあり",
"rejectDialogTitle": "却下理由を選択",
"rejectReason_priceMismatch": "価格帯不適合",
"rejectReason_categorySaturated": "カテゴリ過飽和",
"rejectReason_alreadyBroadcast": "既に放送中",
"rejectReason_qualityConcern": "品質懸念",
"rejectReason_other": "その他",
"confirm": "確定",
"cancel": "キャンセル",
"feedbackSaving": "保存中..."
```

- [ ] **Step 2: `messages/en.json` discovery 블록에 추가**

```json
"sourceButton": "Sourced",
"interestedButton": "Interested",
"rejectedButton": "Rejected",
"duplicateButton": "Duplicate",
"rejectDialogTitle": "Select rejection reason",
"rejectReason_priceMismatch": "Price mismatch",
"rejectReason_categorySaturated": "Category saturated",
"rejectReason_alreadyBroadcast": "Already broadcasting",
"rejectReason_qualityConcern": "Quality concern",
"rejectReason_other": "Other",
"confirm": "Confirm",
"cancel": "Cancel",
"feedbackSaving": "Saving..."
```

- [ ] **Step 3: 검증 + 커밋**

```bash
node -e "JSON.parse(require('fs').readFileSync('messages/ja.json','utf8'));JSON.parse(require('fs').readFileSync('messages/en.json','utf8'));console.log('valid');"
git add messages/ja.json messages/en.json
git commit -m "feat(discovery): add i18n keys for feedback buttons + reject reasons"
```

---

## Task 9: `components/discovery/RejectDialog.tsx`

**Files:**
- Create: `components/discovery/RejectDialog.tsx`

- [ ] **Step 1: 파일 생성**

Write to `components/discovery/RejectDialog.tsx`:

```tsx
"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";

const REASON_KEYS = [
	"rejectReason_priceMismatch",
	"rejectReason_categorySaturated",
	"rejectReason_alreadyBroadcast",
	"rejectReason_qualityConcern",
	"rejectReason_other",
] as const;

type ReasonKey = (typeof REASON_KEYS)[number];

// Map i18n key → value stored in DB
const REASON_VALUE: Record<ReasonKey, string> = {
	rejectReason_priceMismatch: "価格帯不適合",
	rejectReason_categorySaturated: "カテゴリ過飽和",
	rejectReason_alreadyBroadcast: "既に放送中",
	rejectReason_qualityConcern: "品質懸念",
	rejectReason_other: "その他",
};

export function RejectDialog({
	open,
	onConfirm,
	onCancel,
}: {
	open: boolean;
	onConfirm: (reason: string) => void;
	onCancel: () => void;
}) {
	const t = useTranslations("discovery");
	const [selected, setSelected] = useState<ReasonKey>(REASON_KEYS[0]);

	if (!open) return null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
			onClick={onCancel}
		>
			<div
				className="bg-white rounded-lg shadow-lg p-5 w-full max-w-sm mx-4"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between mb-3">
					<h3 className="text-sm font-semibold text-gray-900">
						{t("rejectDialogTitle")}
					</h3>
					<button
						type="button"
						onClick={onCancel}
						className="text-gray-400 hover:text-gray-600"
					>
						<X size={16} />
					</button>
				</div>

				<div className="space-y-2 mb-5">
					{REASON_KEYS.map((key) => (
						<label
							key={key}
							className={`flex items-center gap-2 px-3 py-2 rounded border cursor-pointer transition-colors ${
								selected === key
									? "bg-red-50 border-red-300"
									: "bg-white border-gray-200 hover:bg-gray-50"
							}`}
						>
							<input
								type="radio"
								name="rejectReason"
								value={key}
								checked={selected === key}
								onChange={() => setSelected(key)}
								className="accent-red-500"
							/>
							<span className="text-xs text-gray-800">{t(key)}</span>
						</label>
					))}
				</div>

				<div className="flex justify-end gap-2">
					<button
						type="button"
						onClick={onCancel}
						className="px-4 py-1.5 text-xs text-gray-700 border border-gray-200 rounded hover:bg-gray-50"
					>
						{t("cancel")}
					</button>
					<button
						type="button"
						onClick={() => onConfirm(REASON_VALUE[selected])}
						className="px-4 py-1.5 text-xs bg-red-500 text-white rounded hover:bg-red-600"
					>
						{t("confirm")}
					</button>
				</div>
			</div>
		</div>
	);
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add components/discovery/RejectDialog.tsx
git commit -m "feat(discovery): add RejectDialog for rejection reason selection"
```

---

## Task 10: `components/discovery/FeedbackButtons.tsx`

**Files:**
- Create: `components/discovery/FeedbackButtons.tsx`

- [ ] **Step 1: 파일 생성**

Write to `components/discovery/FeedbackButtons.tsx`:

```tsx
"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Star, XCircle, Copy, Loader2 } from "lucide-react";
import { RejectDialog } from "./RejectDialog";

export type FeedbackAction = "sourced" | "interested" | "rejected" | "duplicate";
export type FeedbackState = FeedbackAction | null;

interface Props {
	productId: string;
	current: FeedbackState;
	onUpdate: (next: FeedbackState, reason?: string | null) => void;
}

const BUTTONS: Array<{
	action: FeedbackAction;
	icon: React.ReactNode;
	labelKey: "sourceButton" | "interestedButton" | "rejectedButton" | "duplicateButton";
	activeClass: string;
	hoverClass: string;
}> = [
	{
		action: "sourced",
		icon: <CheckCircle2 size={12} />,
		labelKey: "sourceButton",
		activeClass: "bg-green-500 text-white border-green-500",
		hoverClass: "hover:bg-green-50 hover:border-green-300",
	},
	{
		action: "interested",
		icon: <Star size={12} />,
		labelKey: "interestedButton",
		activeClass: "bg-orange-500 text-white border-orange-500",
		hoverClass: "hover:bg-orange-50 hover:border-orange-300",
	},
	{
		action: "rejected",
		icon: <XCircle size={12} />,
		labelKey: "rejectedButton",
		activeClass: "bg-red-500 text-white border-red-500",
		hoverClass: "hover:bg-red-50 hover:border-red-300",
	},
	{
		action: "duplicate",
		icon: <Copy size={12} />,
		labelKey: "duplicateButton",
		activeClass: "bg-gray-500 text-white border-gray-500",
		hoverClass: "hover:bg-gray-100 hover:border-gray-400",
	},
];

export function FeedbackButtons({ productId, current, onUpdate }: Props) {
	const t = useTranslations("discovery");
	const [loading, setLoading] = useState(false);
	const [rejectOpen, setRejectOpen] = useState(false);

	async function callApi(action: FeedbackAction, reason?: string) {
		setLoading(true);
		try {
			const res = await fetch("/api/discovery/feedback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ productId, action, reason }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			onUpdate(data.user_action as FeedbackState, reason ?? null);
		} catch (err) {
			console.error("feedback failed", err);
		} finally {
			setLoading(false);
		}
	}

	async function handleClick(action: FeedbackAction) {
		if (loading) return;
		if (action === "rejected" && current !== "rejected") {
			// Open dialog for new rejection
			setRejectOpen(true);
			return;
		}
		await callApi(action);
	}

	async function handleRejectConfirm(reason: string) {
		setRejectOpen(false);
		await callApi("rejected", reason);
	}

	return (
		<>
			<div className="grid grid-cols-4 gap-1 mb-2">
				{BUTTONS.map((btn) => {
					const active = current === btn.action;
					return (
						<button
							key={btn.action}
							type="button"
							onClick={() => handleClick(btn.action)}
							disabled={loading}
							className={`inline-flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-semibold rounded border transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
								active ? btn.activeClass : `bg-white text-gray-700 border-gray-200 ${btn.hoverClass}`
							}`}
						>
							{loading && active ? <Loader2 size={10} className="animate-spin" /> : btn.icon}
							<span className="hidden sm:inline">{t(btn.labelKey)}</span>
						</button>
					);
				})}
			</div>
			<RejectDialog
				open={rejectOpen}
				onConfirm={handleRejectConfirm}
				onCancel={() => setRejectOpen(false)}
			/>
		</>
	);
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add components/discovery/FeedbackButtons.tsx
git commit -m "feat(discovery): add FeedbackButtons (4-button toggle + reject flow)"
```

---

## Task 11: ProductCard integration

**Files:**
- Modify: `components/discovery/ProductCard.tsx`

- [ ] **Step 1: FeedbackButtons 통합**

Open `components/discovery/ProductCard.tsx`. Add imports at the top:

```typescript
import { FeedbackButtons, type FeedbackState } from "./FeedbackButtons";
```

Find the `DiscoveredProductRow` type. Add `user_action` and `action_reason` fields (they likely already exist as optional). Verify the type includes:

```typescript
export type DiscoveredProductRow = {
	id: string;
	name: string;
	thumbnail_url: string | null;
	product_url: string;
	price_jpy: number | null;
	category: string | null;
	seller_name: string | null;
	review_count: number | null;
	review_avg: number | null;
	tv_fit_score: number | null;
	tv_fit_reason: string | null;
	broadcast_tag: "broadcast_confirmed" | "broadcast_likely" | "unknown" | null;
	track: "tv_proven" | "exploration";
	stock_status: string | null;
	source: "rakuten" | "brave" | "other" | null;
	enrichment_status?: EnrichmentStatus | null;
	c_package?: CPackage | null;
	enrichment_error?: string | null;
	context?: "home_shopping" | "live_commerce";
	user_action?: FeedbackState;
	action_reason?: string | null;
};
```

In the ProductCard component body, add feedback state:

```typescript
	const [feedbackState, setFeedbackState] = useState<FeedbackState>(product.user_action ?? null);
	const [feedbackReason, setFeedbackReason] = useState<string | null>(product.action_reason ?? null);

	const isRejected = feedbackState === "rejected";
	const isDimmed = feedbackState === "rejected" || feedbackState === "duplicate";
```

In the JSX return, change the outer `<article>` className to conditionally dim:

Find:
```tsx
<article className="bg-white border border-amber-200 rounded-xl p-4 shadow-sm flex flex-col hover:shadow-md transition-shadow">
```

Replace with:
```tsx
<article
	className={`bg-white border border-amber-200 rounded-xl p-4 shadow-sm flex flex-col hover:shadow-md transition-all ${
		isDimmed ? "opacity-60" : ""
	}`}
	title={isRejected && feedbackReason ? `却下理由: ${feedbackReason}` : undefined}
>
```

Find the "External link" section (with 商品ページへ). AFTER that block and BEFORE any integration/enrichment buttons, add the FeedbackButtons. If there's a `<div className="pb-2 border-b border-gray-100 mb-3">` wrapping the external link, add AFTER it:

```tsx
			{/* Feedback buttons (Phase 4) */}
			<FeedbackButtons
				productId={product.id}
				current={feedbackState}
				onUpdate={(next, reason) => {
					setFeedbackState(next);
					setFeedbackReason(reason ?? null);
				}}
			/>
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add components/discovery/ProductCard.tsx
git commit -m "feat(discovery): integrate FeedbackButtons into ProductCard (+ dim on reject/duplicate)"
```

---

## Task 12: Today API returns user_action/action_reason

**Files:** (verify only — likely no change)

- [ ] **Step 1: 확인**

Open `app/api/discovery/today/route.ts` and `app/api/discovery/sessions/[id]/route.ts`. Both use `select("*")` on `discovered_products`, so `user_action`, `action_reason`, `action_at` are already returned.

If not using `*`, update to include these columns.

- [ ] **Step 2: 타입 체크 (변경 없으면 skip)**

No commit if no changes.

---

## Task 13: End-to-end verification

**Files:** (실행만)

- [ ] **Step 1: Dev 서버 시작**

```bash
npm run dev
```

- [ ] **Step 2: 피드백 버튼 테스트**

`http://localhost:<port>/ja/analytics/discovery/home` 접속.

카드에서:
- [ ] "✅ ソーシング済み" 클릭 → 녹색 강조 (카드 dim 없음)
- [ ] 같은 버튼 재클릭 → 해제 (흰 배경 복귀)
- [ ] "❌ 却下" 클릭 → RejectDialog 모달 → 이유 선택 → 확정 → 빨강 강조 + 카드 dim (opacity 0.6)
- [ ] 카드 호버 시 툴팁에 "却下理由: 価格帯不適合" 표시
- [ ] "🗑 既にあり" 클릭 → 회색 강조 + dim
- [ ] "⭐ 関心あり" 클릭 → 주황 강조 (dim 없음)
- [ ] DevTools Network: POST `/api/discovery/feedback` 200 응답, body에 `user_action` 올바름

- [ ] **Step 3: DB 검증**

Supabase SQL Editor:
```sql
-- 오늘 피드백 확인
SELECT dp.id, dp.name, dp.user_action, dp.action_reason, dp.action_at
FROM discovered_products dp
WHERE dp.action_at > now() - interval '10 minutes'
ORDER BY dp.action_at DESC;

-- 이벤트 로그 확인 (토글 off는 없어야 함)
SELECT pf.action, pf.reason, pf.created_at
FROM product_feedback pf
WHERE pf.created_at > now() - interval '10 minutes'
ORDER BY pf.created_at DESC;
```

- [ ] **Step 4: daily-learning cron 수동 트리거**

```bash
curl -s http://localhost:<port>/api/cron/daily-learning
```

응답 예시:
```json
{"results":[{"context":"home_shopping","ok":true},{"context":"live_commerce","ok":true}]}
```

- [ ] **Step 5: learning_state 갱신 확인**

```sql
SELECT context, exploration_ratio, is_cold_start, feedback_sample_size,
       jsonb_object_keys(category_weights) as tracked_categories,
       jsonb_array_length(rejected_seeds->'urls') as rejected_url_count
FROM learning_state;
```

피드백이 적으면 `is_cold_start=true` 이고 category_weights/rejected_seeds는 비어있음 (정상).

- [ ] **Step 6: 발굴 시 exclusion 작동 확인 (선택)**

"소싱함" 처리한 제품을 수동 재발굴하여 다시 나오지 않는지 확인:

```bash
curl -s -X POST http://localhost:<port>/api/discovery/manual-trigger \
  -H "Content-Type: application/json" \
  -d '{"context":"home_shopping"}'
```

완료 후 DB 확인:
```sql
-- 소싱 처리된 상품이 새 세션에 없어야 함
SELECT EXISTS (
  SELECT 1 FROM discovered_products
  WHERE session_id = (SELECT id FROM discovery_runs ORDER BY run_at DESC LIMIT 1)
    AND product_url IN (
      SELECT product_url FROM discovered_products WHERE user_action = 'sourced'
    )
);
-- expected: false
```

- [ ] **Step 7: Phase 4 완료 선언**

```bash
git log --oneline main..HEAD | head -20
```

---

## Self-Review

**Spec coverage:**
- §3 DB 변경 → Task 1, 2 ✓
- §4.1 feedback API (toggle, reject reason validation) → Task 6 ✓
- §4.2 daily-learning cron → Task 7 ✓
- §5.1-5.4 learning computation → Task 5 ✓
- §5.4 exclusion sourced/duplicate → Task 3 ✓
- §5.5 loadLearningState context param → Task 4 ✓
- §6.1 FeedbackButtons → Task 10 ✓
- §6.2 RejectDialog → Task 9 ✓
- §6.3 ProductCard integration + dim on rejected/duplicate → Task 11 ✓
- §6.4 i18n → Task 8 ✓
- §7.1 vercel.json crons → Task 7 ✓

**Placeholder scan:** 모든 task에 실제 코드 포함. 없음.

**Type consistency:**
- `FeedbackState = FeedbackAction | null` — FeedbackButtons, ProductCard에서 동일 사용 ✓
- `Context = 'home_shopping' | 'live_commerce'` — 기존 types.ts 정의, learning.ts + cron에서 import ✓
- `ExclusionContext` 에 `feedbackSourcedUrls`, `feedbackSourcedCodes` 추가 — exclusion.ts loadExclusionContext + applyExclusions 일관 사용 ✓
- `discovery_products.user_action` 값 subset ('sourced' | 'interested' | 'rejected' | 'duplicate') — DB CHECK와 TypeScript action 타입 일치 ✓

**Gaps:**
- product_feedback 테이블은 CHECK에 'deep_dive' 포함 (Phase 1 스키마). 본 Phase에서 deep_dive 이벤트 삽입 로직은 enrichment POST 쪽에 있을 텐데 그건 변경 없이 유지됨. learning.ts에서 deep_dive 집계만 추가 확인 ✓

**토글 해제 시 이벤트 로그 미기록** (spec §4.1 결정 유지):
- product_feedback 테이블에는 set 이벤트만 축적됨
- learning.ts는 `discovered_products.user_action` (현재 상태)를 주 신호로 사용하므로 토글 해제가 올바르게 반영됨 (rejected → cleared 하면 user_action=NULL → rejected 집계 제외)
