# Product Discovery Phase 3.5 — Context Split + History + Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 발굴을 홈쇼핑 context 와 라이브커머스 context 로 분리. 각 context 별 일일 cron + 전용 스코어링 + 서브탭 UI. 캘린더+리스트 히스토리 페이지. 발굴 카드에서 기존 `/analytics/expansion` 및 `/analytics/live-commerce` 로 pre-fill URL 이동. 추가로 이미지 누락 버그 수정.

**Architecture:**
- `discovery_runs.context` + `discovered_products.context` 컬럼 추가 (`home_shopping` | `live_commerce`)
- 2개 cron: 09:00 JST (home) + 09:30 JST (live)
- `lib/discovery/plan.ts` + `curate.ts` 에 context 파라미터 추가, context별 프롬프트 분기
- UI: `/analytics/発掘/home` + `/発掘/live` + `/発掘/history` 서브라우트
- 히스토리: 캘린더(기본) + 리스트 혼합, context 필터
- 카드 "拡大戦略を作成" / "ライブ戦略を作成" 버튼 → seed URL param으로 pre-fill

**Tech Stack:** 기존 동일 (Next.js 16 App Router, Supabase, Gemini 3-Flash).

**Spec reference:** 본 계획서 (spec 업데이트는 후속). Phase 1-3 spec은 `docs/superpowers/specs/2026-04-18-product-discovery-redesign-design.md` 유지.

**Phase 3 완료 상태:** 단일 context 발굴 + enrichment (C 패키지) 완성. PR #7 open, 전체 Phase 1+2+3 포함.

**Out of scope for Phase 3.5:**
- 피드백 버튼 4종 (Phase 4 유지)
- 학습 cron + insights (Phase 4/5)
- MDStrategyPanel 대규모 리팩터 (seed URL 읽기만 추가)

---

## File Structure

**Create:**
```
supabase/migrations/2026-04-18_discovery_context.sql

app/api/cron/daily-discovery-home/route.ts
app/api/cron/daily-discovery-live/route.ts
app/api/discovery/history/route.ts

app/[locale]/analytics/discovery/home/page.tsx
app/[locale]/analytics/discovery/live/page.tsx
app/[locale]/analytics/discovery/history/page.tsx
app/[locale]/analytics/discovery/session/[sessionId]/page.tsx  (renamed from [sessionId])

components/discovery/
  ContextSubTabs.tsx             — home/live/history 서브탭
  ManualTriggerButton.tsx        — "今すぐ発掘" 버튼
  SessionCalendar.tsx            — 월 단위 캘린더
  SessionList.tsx                — 세션 리스트 (페이지네이션)
  IntegrationActions.tsx         — 拡大戦略 / ライブ戦略 버튼
```

**Modify:**
```
lib/rakuten.ts                   — RakutenItem.mediumImageUrl / smallImageUrl 필드 추가 + parseItems 수정
lib/discovery/pool.ts            — thumbnailUrl 설정
lib/discovery/types.ts           — Context 타입 + PoolItem.context + Candidate.context
lib/discovery/plan.ts            — context 파라미터
lib/discovery/curate.ts          — context 파라미터
lib/discovery/orchestrator.ts    — runStage1(learning, targetCount, context)
lib/discovery/save.ts            — createSession({..., context}) + INSERT에 context 포함
app/api/discovery/today/route.ts — ?context=home|live 필터
app/api/discovery/sessions/route.ts — ?context 필터
app/api/discovery/sessions/[id]/route.ts — (변경 없음, 응답에 context 자동 포함)
app/api/cron/daily-discovery/route.ts — DEPRECATED (삭제 or 내부에서 home+live 모두 실행)
app/api/discovery/manual-trigger/route.ts — body.context 파라미터 지원

app/[locale]/analytics/layout.tsx — discovery 탭 → 서브탭 인식 (home/live/history)
app/[locale]/analytics/discovery/page.tsx — redirect to /discovery/home
components/discovery/ProductCard.tsx — IntegrationActions 추가

components/analytics/MDStrategyPanel.tsx — useSearchParams로 seed pre-fill
components/analytics/LiveCommercePanel.tsx — 동일 (필요시)

messages/ja.json, messages/en.json — 추가 키
vercel.json — 2 cron + 2 function timeout
```

---

## Task 1: 이미지 버그 수정 (rakuten.ts + pool.ts)

**Files:**
- Modify: `lib/rakuten.ts`
- Modify: `lib/discovery/pool.ts`

**Why:** Rakuten API는 `mediumImageUrls` 배열을 반환하지만 현재 파싱하지 않아 `thumbnailUrl` 이 항상 null.

- [ ] **Step 1: `lib/rakuten.ts` RakutenItem 타입 및 parseItems 수정**

Find the `RakutenItem` type and add image fields:

```typescript
export type RakutenItem = {
	rank: number;
	itemName: string;
	itemPrice: number;
	itemCaption: string;
	itemUrl: string;
	shopName: string;
	reviewCount: number;
	reviewAverage: number;
	genreId?: string;
	imageUrl?: string;           // NEW — primary image
};
```

Find `parseItems` and extract image URL:

```typescript
function parseItems(data: Record<string, unknown>): RakutenItem[] {
	return (data.Items as unknown[] ?? []).map(
		(entry: unknown, idx: number) => {
			const e = entry as Record<string, unknown>;
			const item = (e.Item ?? e.item ?? e) as Record<string, unknown>;

			// Rakuten returns mediumImageUrls as array of { imageUrl: "..." }
			// Some responses use smallImageUrls. Extract first non-empty.
			const imgArr = (item.mediumImageUrls ?? item.smallImageUrls ?? []) as Array<
				{ imageUrl?: string } | string
			>;
			let imageUrl: string | undefined;
			for (const img of imgArr) {
				const raw = typeof img === "string" ? img : img?.imageUrl;
				if (raw) {
					// Rakuten sometimes appends ?_ex=128x128 — strip for higher res
					imageUrl = raw.replace(/\?_ex=\d+x\d+/, "");
					break;
				}
			}

			return {
				rank: idx + 1,
				itemName: String(item.itemName ?? ""),
				itemPrice: Number(item.itemPrice ?? 0),
				itemCaption: String(item.itemCaption ?? "").slice(0, 200),
				itemUrl: String(item.itemUrl ?? ""),
				shopName: String(item.shopName ?? ""),
				reviewCount: Number(item.reviewCount ?? 0),
				reviewAverage: Number(item.reviewAverage ?? 0),
				genreId: String(item.genreId ?? ""),
				imageUrl,
			};
		},
	);
}
```

- [ ] **Step 2: `lib/discovery/pool.ts` rakutenItemToPoolItem 수정**

Find `rakutenItemToPoolItem` and set `thumbnailUrl`:

```typescript
function rakutenItemToPoolItem(
	it: RakutenItem,
	seed: string,
	track: Track,
): PoolItem {
	return {
		name: it.itemName,
		productUrl: it.itemUrl,
		thumbnailUrl: it.imageUrl,   // NEW
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
```

- [ ] **Step 3: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/rakuten.ts lib/discovery/pool.ts
git commit -m "fix(discovery): extract Rakuten image URL for thumbnail display"
```

Note: 기존 발굴 데이터는 다음 cron 실행 또는 수동 재발굴 후 이미지 표시됨.

---

## Task 2: DB migration — context 컬럼 추가

**Files:**
- Create: `supabase/migrations/2026-04-18_discovery_context.sql`

- [ ] **Step 1: 마이그레이션 파일 생성**

Write:

```sql
-- Add context column to support home_shopping vs live_commerce split
-- Ref: Phase 3.5 plan

ALTER TABLE discovery_runs
  ADD COLUMN IF NOT EXISTS context text NOT NULL DEFAULT 'home_shopping'
    CHECK (context IN ('home_shopping', 'live_commerce'));

CREATE INDEX IF NOT EXISTS idx_discovery_runs_context
  ON discovery_runs (context, run_at DESC);

ALTER TABLE discovered_products
  ADD COLUMN IF NOT EXISTS context text NOT NULL DEFAULT 'home_shopping'
    CHECK (context IN ('home_shopping', 'live_commerce'));

CREATE INDEX IF NOT EXISTS idx_discovered_products_context
  ON discovered_products (context, created_at DESC);
```

- [ ] **Step 2: 커밋**

```bash
git add supabase/migrations/2026-04-18_discovery_context.sql
git commit -m "feat(db): add context column to discovery tables (home_shopping | live_commerce)"
```

- [ ] **Step 3: 사용자에게 마이그레이션 실행 요청 (이 task 10 직전 수행)**

Supabase Studio SQL Editor에서 위 SQL을 실행.

---

## Task 3: types.ts — Context 타입 + 필드 추가

**Files:**
- Modify: `lib/discovery/types.ts`

- [ ] **Step 1: Context 타입 및 필드 추가**

Open `lib/discovery/types.ts`. Add after existing `Track` type:

```typescript
export type Context = "home_shopping" | "live_commerce";
```

Modify `PoolItem` — add `context` field (optional, because pool stage doesn't always know it upfront — it's inherited from the run):

```typescript
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
	context?: Context;           // NEW — set during candidate → save step
}
```

Modify `Candidate` interface — now extends PoolItem with confirmed context:

```typescript
export interface Candidate extends PoolItem {
	tvFitScore: number;
	tvFitReason: string;
	isTvApplicable: boolean;
	isLiveApplicable: boolean;
	scoreBreakdown: CurationScore;
	context: Context;              // NEW — required on Candidate
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/discovery/types.ts
git commit -m "feat(discovery): add Context type and context field on Candidate"
```

**Note:** `npx tsc --noEmit` 이 curate.ts, save.ts, orchestrator.ts에서 에러를 낼 것 (Candidate.context 미설정). 다음 task들이 순차 수정. 수정 전까지 build 불가.

---

## Task 4: plan.ts — context 파라미터 + 프롬프트 분기

**Files:**
- Modify: `lib/discovery/plan.ts`

- [ ] **Step 1: `buildCategoryPlan` 시그니처 변경 및 프롬프트 분기**

Open `lib/discovery/plan.ts`. Update the function signature and replace the prompt generation:

```typescript
import type { CategoryPlan, Context, LearningState } from "./types";

export async function buildCategoryPlan(
	learning: LearningState,
	topCategories: string[],
	recentlyUsed: Set<string>,
	context: Context = "home_shopping",
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

	const contextGuidance =
		context === "live_commerce"
			? `
【Context: ライブコマース】
- ターゲット: 20-40代、SNS利用者、即決購入層
- カテゴリ優先: 化粧品 / ファッション小物 / 美容家電 / ガジェット / 季節限定品 / トレンド雑貨
- 価格帯: ¥1,000-15,000 (即購入可能)
- 重視: SNS拡散性、ビジュアル、若年層共感、トレンド感`
			: `
【Context: ホームショッピング】
- ターゲット: 40-60代、TV視聴者、じっくり検討層
- カテゴリ優先: 美容家電 / キッチン調理器具 / 健康機器 / 寝具 / 防災 / 実演映え家電
- 価格帯: ¥3,000-30,000 (衝動買いゾーン)
- 重視: 実演適性、ギフト需要、信頼感、TVデモ可能性`;

	const prompt = `あなたは日本のテレビ通販・ライブコマース向け商品ソーシング専門家です。
今日の発掘キーワード${TOTAL_KEYWORDS}個を選んでください。
${contextGuidance}

【キーワード生成ルール — 厳守】
- 各キーワードは楽天市場で検索可能な短い汎用語（2〜5語）
- 具体的なブランド名や型番は含めない
- 修飾語は最小限
- 長い造語を避け、消費者が実際に検索する語を優先

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

	// ... rest unchanged (Gemini call + fallback)
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

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/discovery/plan.ts
git commit -m "feat(discovery): context-aware category planning (home vs live)"
```

---

## Task 5: curate.ts — context 파라미터 + 스코어링 분기

**Files:**
- Modify: `lib/discovery/curate.ts`

- [ ] **Step 1: `curatePool` 시그니처 + 프롬프트 + Candidate.context 설정**

Open `lib/discovery/curate.ts`. Update:

```typescript
import type {
	Candidate,
	Context,
	CurationScore,
	LearningState,
	PoolItem,
} from "./types";

export async function curatePool(
	pool: PoolItem[],
	targetCount: number,
	learning: LearningState,
	context: Context = "home_shopping",
): Promise<Candidate[]> {
	if (pool.length === 0) return [];

	const sampled = pool.slice(0, POOL_SAMPLE_LIMIT);
	const poolList = sampled.map((p, i) => formatPoolLine(p, i)).join("\n");

	const rejectionHints =
		learning.recent_rejection_reasons
			.slice(0, 3)
			.map((r) => `${r.reason}(${r.count}件)`)
			.join(", ") || "(データ不足)";

	const contextBlock =
		context === "live_commerce"
			? `
【Context: ライブコマース (20-40代、SNS利用者)】
- 重視: SNS拡散性、ビジュアル訴求、トレンド感、若年層共感
- 価格帯ゾーン: ¥1,000-15,000 (即購入)
- 除外特性: じっくり検討が必要な高額品、高齢者専用商品`
			: `
【Context: ホームショッピング (40-60代、TV視聴者)】
- 重視: 実演適性、ギフト需要、信頼感、TVデモ可能性
- 価格帯ゾーン: ¥3,000-30,000 (衝動買い)
- 除外特性: 若年層向けトレンド商品、SNS専用商品`;

	const prompt = `あなたは日本のテレビ通販・ライブコマースに適した商品を選ぶバイヤーです。
以下の商品プールから上位${targetCount}個を選び、各商品を評価してください。
${contextBlock}

【採点基準 (合計0-100)】
- review_signal (0-35): Rakutenレビュー数と評価の強さ (≥100件→30+, 50-99→20, 5-49→10, <5→0)
- tv_category_match (0-20): Context実績カテゴリとの一致 (一致=20, 隣接=10, 不一致=0)
- trend_signal (0-15): 日本市場のトレンド信号の強さ
- price_fit (0-15): Context別価格帯ゾーンに近いほど高い
- purchase_signal (0-15): Context別の購買トリガー (実演映え or SNS拡散性)

【除外すべき特性 (採点せず応答から除外)】
- 単価¥500未満の消耗品
- 専門設置が必要な高額家電 (デモ不可)
- 医薬品・処方箋必要
- 資格・許認可が必要な販売カテゴリ

【最近の却下理由 (減点対象)】
${rejectionHints}

【商品プール — index: name | price | review | seller | seed | track】
${poolList}

【tv_fit_reason 作成ルール】
- 商品の実際の特性（カテゴリ、レビュー数、価格帯、実演映えなど）を根拠に説明
- seed_keyword（検索に使ったキーワード）は参照しないこと
- 商品名から推定される機能・ベネフィットに焦点

【出力 — JSONのみ、前置き/後書き・コメントなし】
{
  "candidates": [
    {
      "index": <プールのインデックス>,
      "tv_fit_score": <0-100>,
      "tv_fit_reason": "1行 (日本語, 50字以内, 商品特性のみ)",
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
			context,                                   // NEW — set from parameter
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

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/discovery/curate.ts
git commit -m "feat(discovery): context-aware curation (home vs live scoring)"
```

---

## Task 6: orchestrator.ts + save.ts — context 전파

**Files:**
- Modify: `lib/discovery/orchestrator.ts`
- Modify: `lib/discovery/save.ts`

- [ ] **Step 1: orchestrator.ts — context 파라미터 추가**

Open `lib/discovery/orchestrator.ts`. Update the `runStage1` function:

```typescript
import type {
	Candidate,
	CategoryPlan,
	Context,
	LearningState,
	PoolItem,
} from "./types";

export async function runStage1(
	learning: LearningState,
	targetCount: number,
	context: Context = "home_shopping",
): Promise<OrchestrateResult> {
	// Step 1: plan
	const [topCategories, recentlyUsed] = await Promise.all([
		loadTopCategories(),
		loadRecentPlannedKeywords(),
	]);
	const plan = await buildCategoryPlan(learning, topCategories, recentlyUsed, context);

	// Step 2: initial pool + exclusion
	let pool = await buildPool(plan);
	const exclusionCtx = await loadExclusionContext(learning);
	let filtered = applyExclusions(pool, exclusionCtx);

	// Step 3: curate with bounded iteration
	let candidates = await curatePool(filtered, targetCount, learning, context);
	let iterations = 0;
	let qualityCount = candidates.filter(
		(c) => c.tvFitScore >= QUALITY_SCORE_THRESHOLD,
	).length;

	while (qualityCount < MIN_QUALITY_COUNT && iterations < MAX_ITERATIONS) {
		iterations += 1;
		const extraKeywords = await suggestMoreKeywords(plan, qualityCount);
		if (extraKeywords.length === 0) break;

		const extension = await buildAdditionalPool(extraKeywords);
		pool = mergePools(pool, extension);
		filtered = applyExclusions(pool, exclusionCtx);
		candidates = await curatePool(filtered, targetCount, learning, context);
		qualityCount = candidates.filter(
			(c) => c.tvFitScore >= QUALITY_SCORE_THRESHOLD,
		).length;
	}

	return {
		candidates,
		plan,
		poolSize: pool.length,
		iterations,
	};
}
```

- [ ] **Step 2: save.ts — createSession + saveDiscoveredProducts에 context 전파**

Open `lib/discovery/save.ts`. Update:

```typescript
import type {
	BroadcastTag,
	Candidate,
	CategoryPlan,
	Context,
	SessionStatus,
} from "./types";

export async function createSession(input: {
	targetCount: number;
	explorationRatio: number;
	context: Context;                            // NEW required
}): Promise<string> {
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("discovery_runs")
		.insert({
			status: "running" as SessionStatus,
			target_count: input.targetCount,
			produced_count: 0,
			exploration_ratio: input.explorationRatio,
			iterations: 0,
			context: input.context,                   // NEW
		})
		.select("id")
		.single();
	if (error || !data) {
		throw new Error(
			`[save] createSession failed: ${error?.message ?? "unknown"}`,
		);
	}
	return data.id as string;
}
```

In `saveDiscoveredProducts`, add context to the row object:

```typescript
const rows = batch.map(({ candidate, broadcastTag, broadcastSources }) => ({
    session_id: sessionId,
    name: candidate.name,
    name_normalized: normalizeName(candidate.name),
    thumbnail_url: candidate.thumbnailUrl ?? null,
    product_url: candidate.productUrl,
    price_jpy: candidate.priceJpy ?? null,
    category: candidate.seedKeyword,
    source: candidate.source,
    rakuten_item_code: candidate.rakutenItemCode ?? null,
    review_count: candidate.reviewCount ?? null,
    review_avg: candidate.reviewAvg ?? null,
    seller_name: candidate.sellerName ?? null,
    stock_status: candidate.stockStatus ?? null,
    tv_fit_score: candidate.tvFitScore,
    tv_fit_reason: candidate.tvFitReason,
    broadcast_tag: broadcastTag,
    broadcast_sources: broadcastSources,
    track: candidate.track,
    is_tv_applicable: candidate.isTvApplicable,
    is_live_applicable: candidate.isLiveApplicable,
    context: candidate.context,                          // NEW
}));
```

- [ ] **Step 3: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/discovery/orchestrator.ts lib/discovery/save.ts
git commit -m "feat(discovery): propagate context through orchestrator + save"
```

---

## Task 7: 2개 cron + vercel.json + deprecate 구 cron

**Files:**
- Create: `app/api/cron/daily-discovery-home/route.ts`
- Create: `app/api/cron/daily-discovery-live/route.ts`
- Delete or repurpose: `app/api/cron/daily-discovery/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: `daily-discovery-home/route.ts` 생성**

Create directory. Write:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { tagBroadcastEvidence } from "@/lib/discovery/broadcast";
import { runStage1 } from "@/lib/discovery/orchestrator";
import {
	attachPlanToSession,
	createSession,
	finalizeSession,
	saveDiscoveredProducts,
} from "@/lib/discovery/save";
import { getServiceClient } from "@/lib/supabase";
import { DEFAULT_LEARNING_STATE, type LearningState } from "@/lib/discovery/types";

export const maxDuration = 300;

const TARGET_COUNT = Number(process.env.DISCOVERY_TARGET_COUNT ?? 30);
const CONTEXT = "home_shopping" as const;

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

	const learning = await loadLearningState();
	const sessionId = await createSession({
		targetCount: TARGET_COUNT,
		explorationRatio: learning.exploration_ratio,
		context: CONTEXT,
	});

	try {
		const orchestrated = await runStage1(learning, TARGET_COUNT, CONTEXT);
		await attachPlanToSession(sessionId, orchestrated.plan);

		const broadcasts = await tagBroadcastEvidence(orchestrated.candidates);
		const broadcastMap = new Map(broadcasts.map((b) => [b.productUrl, b]));

		const batch = orchestrated.candidates.map((c) => {
			const bc = broadcastMap.get(c.productUrl);
			return {
				candidate: c,
				broadcastTag: bc?.tag ?? ("unknown" as const),
				broadcastSources: bc?.sources ?? [],
			};
		});
		const savedCount = await saveDiscoveredProducts(sessionId, batch);

		const partial = savedCount < TARGET_COUNT;
		await finalizeSession({
			sessionId,
			status: partial ? "partial" : "completed",
			producedCount: savedCount,
			iterations: orchestrated.iterations,
		});

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

- [ ] **Step 2: `daily-discovery-live/route.ts` 생성**

Same content, but:
- Change `CONTEXT = "live_commerce" as const;`
- Change log prefix implicit via `CONTEXT` var

The file is almost identical to home — simplest is to copy the home file and change the one constant.

- [ ] **Step 3: `daily-discovery/route.ts` 비활성화**

Option A (recommended): **Replace its content** with a deprecation notice:

```typescript
import { NextResponse } from "next/server";

export const maxDuration = 10;

/**
 * DEPRECATED — replaced by /api/cron/daily-discovery-home and /-live.
 * Kept for backwards compatibility: returns 410 Gone.
 */
export async function GET() {
	return NextResponse.json(
		{
			error: "deprecated",
			replacement: [
				"/api/cron/daily-discovery-home",
				"/api/cron/daily-discovery-live",
			],
		},
		{ status: 410 },
	);
}
```

- [ ] **Step 4: `vercel.json` 업데이트**

Remove the old cron entry; add two new ones. Final `crons`:

```json
"crons": [
  { "path": "/api/cron/daily-refresh", "schedule": "0 9 * * *" },
  { "path": "/api/cron/daily-discovery-home", "schedule": "0 0 * * *" },
  { "path": "/api/cron/daily-discovery-live", "schedule": "30 0 * * *" }
]
```

Add two new function timeouts, remove old if present:

```json
"app/api/cron/daily-discovery-home/route.ts": { "maxDuration": 300 },
"app/api/cron/daily-discovery-live/route.ts": { "maxDuration": 300 }
```

Keep the old `daily-discovery/route.ts` entry at a short timeout (or remove).

- [ ] **Step 5: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add app/api/cron/daily-discovery-home/ app/api/cron/daily-discovery-live/ app/api/cron/daily-discovery/ vercel.json
git commit -m "feat(discovery): split cron into home + live (9AM + 9:30AM JST)"
```

---

## Task 8: manual-trigger API — context 파라미터 지원

**Files:**
- Modify: `app/api/discovery/manual-trigger/route.ts`

- [ ] **Step 1: body.context 읽어서 해당 context 크론 호출**

Replace entire file content:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { GET as runHomeCron } from "@/app/api/cron/daily-discovery-home/route";
import { GET as runLiveCron } from "@/app/api/cron/daily-discovery-live/route";

export const maxDuration = 300;

/**
 * Manual admin trigger for discovery cron.
 * Body: { context: 'home_shopping' | 'live_commerce' }
 * Protected by CRON_SECRET.
 */
export async function POST(req: NextRequest) {
	const secret = process.env.CRON_SECRET;
	if (secret) {
		const header = req.headers.get("authorization");
		if (header !== `Bearer ${secret}`) {
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		}
	}

	let context: "home_shopping" | "live_commerce" = "home_shopping";
	try {
		const body = (await req.json()) as { context?: string };
		if (body.context === "live_commerce") context = "live_commerce";
	} catch {
		// fall back to default
	}

	const runner = context === "live_commerce" ? runLiveCron : runHomeCron;
	return runner(req);
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add app/api/discovery/manual-trigger/route.ts
git commit -m "feat(discovery): manual-trigger accepts context in body"
```

---

## Task 9: 조회 API 업데이트 (context 필터 + history API)

**Files:**
- Modify: `app/api/discovery/today/route.ts`
- Modify: `app/api/discovery/sessions/route.ts`
- Create: `app/api/discovery/history/route.ts`

- [ ] **Step 1: `today/route.ts` — ?context 필터 추가**

Open `app/api/discovery/today/route.ts`. Add context filter to the session query:

Find:
```typescript
	const { data: session, error: sessErr } = await sb
		.from("discovery_runs")
		.select("*")
		.in("status", ["completed", "partial"])
		.order("run_at", { ascending: false })
		.limit(1)
		.maybeSingle();
```

Replace with:
```typescript
	const contextFilter = searchParams.get("context");
	let sessQuery = sb
		.from("discovery_runs")
		.select("*")
		.in("status", ["completed", "partial"])
		.order("run_at", { ascending: false })
		.limit(1);
	if (contextFilter === "home_shopping" || contextFilter === "live_commerce") {
		sessQuery = sessQuery.eq("context", contextFilter);
	}
	const { data: session, error: sessErr } = await sessQuery.maybeSingle();
```

(Move `searchParams` declaration above if needed — current file declares `const { searchParams } = new URL(req.url);` at top of GET, keep it.)

- [ ] **Step 2: `sessions/route.ts` — ?context 필터 추가**

Find the query:
```typescript
	const { data, error } = await sb
		.from("discovery_runs")
		.select("id, run_at, completed_at, status, target_count, produced_count, iterations")
		.order("run_at", { ascending: false })
		.range(offset, offset + limit - 1);
```

Replace with:
```typescript
	let q = sb
		.from("discovery_runs")
		.select("id, run_at, completed_at, status, target_count, produced_count, iterations, context")
		.order("run_at", { ascending: false });

	const contextFilter = searchParams.get("context");
	if (contextFilter === "home_shopping" || contextFilter === "live_commerce") {
		q = q.eq("context", contextFilter);
	}

	const { data, error } = await q.range(offset, offset + limit - 1);
```

- [ ] **Step 3: `history/route.ts` 생성**

Create `app/api/discovery/history/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * History API — returns sessions grouped by date for calendar rendering,
 * with optional context filter and date range.
 * Query params:
 *   - context: home_shopping | live_commerce (optional)
 *   - from: ISO date (default: now - 60 days)
 *   - to: ISO date (default: now)
 */
export async function GET(req: NextRequest) {
	const sb = getServiceClient();
	const { searchParams } = new URL(req.url);

	const contextFilter = searchParams.get("context");
	const toDate = searchParams.get("to") ?? new Date().toISOString();
	const fromDate =
		searchParams.get("from") ??
		new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();

	let q = sb
		.from("discovery_runs")
		.select("id, run_at, completed_at, status, target_count, produced_count, iterations, context")
		.gte("run_at", fromDate)
		.lte("run_at", toDate)
		.order("run_at", { ascending: false });

	if (contextFilter === "home_shopping" || contextFilter === "live_commerce") {
		q = q.eq("context", contextFilter);
	}

	const { data, error } = await q;
	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}

	return NextResponse.json({
		sessions: data ?? [],
		range: { from: fromDate, to: toDate },
	});
}
```

- [ ] **Step 4: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add app/api/discovery/today/route.ts app/api/discovery/sessions/route.ts app/api/discovery/history/route.ts
git commit -m "feat(discovery): add context filter to APIs + new history endpoint"
```

---

## Task 10: **사용자 수동 작업** — 마이그레이션 실행

**Files:** (사용자 액션)

**Depends on:** Task 2 완료.

- [ ] **Step 1: Supabase Studio에서 마이그레이션 실행**

SQL Editor에서 `supabase/migrations/2026-04-18_discovery_context.sql` 내용 실행:

```sql
ALTER TABLE discovery_runs
  ADD COLUMN IF NOT EXISTS context text NOT NULL DEFAULT 'home_shopping'
    CHECK (context IN ('home_shopping', 'live_commerce'));
CREATE INDEX IF NOT EXISTS idx_discovery_runs_context
  ON discovery_runs (context, run_at DESC);

ALTER TABLE discovered_products
  ADD COLUMN IF NOT EXISTS context text NOT NULL DEFAULT 'home_shopping'
    CHECK (context IN ('home_shopping', 'live_commerce'));
CREATE INDEX IF NOT EXISTS idx_discovered_products_context
  ON discovered_products (context, created_at DESC);
```

- [ ] **Step 2: 검증 쿼리**

```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'discovery_runs' AND column_name = 'context';
-- expected: context | text | 'home_shopping'::text

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'discovered_products' AND column_name = 'context';
-- expected: same
```

기존 rows는 모두 `context='home_shopping'` 으로 자동 채워짐.

---

## Task 11: UI 컴포넌트 — ContextSubTabs, ManualTriggerButton

**Files:**
- Create: `components/discovery/ContextSubTabs.tsx`
- Create: `components/discovery/ManualTriggerButton.tsx`
- Modify: `messages/ja.json`, `messages/en.json`

- [ ] **Step 1: i18n 키 추가 (discovery 블록 안에)**

`messages/ja.json` discovery 블록에 추가:
```json
"subTabHome": "ホームショッピング",
"subTabLive": "ライブコマース",
"subTabHistory": "履歴",
"manualTrigger": "今すぐ発掘",
"manualTriggerRunning": "実行中...",
"manualTriggerSuccess": "発掘完了 — ページを再読込",
"manualTriggerFailed": "発掘失敗",
"viewStrategy": "拡大戦略を作成",
"viewLiveStrategy": "ライブ戦略を作成",
"calendarLegendCompleted": "完了",
"calendarLegendPartial": "部分完了",
"calendarLegendFailed": "失敗",
"noSessionsYet": "履歴なし",
"loadMore": "もっと見る"
```

`messages/en.json` 대응:
```json
"subTabHome": "Home Shopping",
"subTabLive": "Live Commerce",
"subTabHistory": "History",
"manualTrigger": "Run Discovery Now",
"manualTriggerRunning": "Running...",
"manualTriggerSuccess": "Done — refresh page",
"manualTriggerFailed": "Failed",
"viewStrategy": "Create Expansion Strategy",
"viewLiveStrategy": "Create Live Strategy",
"calendarLegendCompleted": "Completed",
"calendarLegendPartial": "Partial",
"calendarLegendFailed": "Failed",
"noSessionsYet": "No history",
"loadMore": "Load more"
```

- [ ] **Step 2: `components/discovery/ContextSubTabs.tsx` 생성**

```tsx
"use client";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Home, Tv, Calendar } from "lucide-react";

type SubTab = "home" | "live" | "history";

const TABS: Array<{ key: SubTab; icon: React.ReactNode; labelKey: "subTabHome" | "subTabLive" | "subTabHistory" }> = [
	{ key: "home", icon: <Home size={14} />, labelKey: "subTabHome" },
	{ key: "live", icon: <Tv size={14} />, labelKey: "subTabLive" },
	{ key: "history", icon: <Calendar size={14} />, labelKey: "subTabHistory" },
];

export function ContextSubTabs() {
	const t = useTranslations("discovery");
	const { locale } = useParams<{ locale: string }>();
	const pathname = usePathname();

	const activeTab = (() => {
		const parts = pathname.split("/").filter(Boolean); // [locale, 'analytics', 'discovery', sub?]
		const sub = parts[3];
		if (sub === "home" || sub === "live" || sub === "history") return sub;
		return "home";
	})();

	return (
		<div className="flex gap-1 p-1 bg-white border border-gray-200 rounded-lg shadow-sm mb-4 w-fit">
			{TABS.map((tab) => {
				const href = `/${locale}/analytics/discovery/${tab.key}`;
				const active = activeTab === tab.key;
				return (
					<Link
						key={tab.key}
						href={href}
						className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
							active
								? "bg-amber-500 text-white shadow-sm"
								: "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
						}`}
					>
						{tab.icon}
						{t(tab.labelKey)}
					</Link>
				);
			})}
		</div>
	);
}
```

- [ ] **Step 3: `components/discovery/ManualTriggerButton.tsx` 생성**

```tsx
"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Sparkles } from "lucide-react";
import type { Context } from "@/lib/discovery/types";

export function ManualTriggerButton({ context, onStarted }: { context: Context; onStarted?: () => void }) {
	const t = useTranslations("discovery");
	const [loading, setLoading] = useState(false);
	const [status, setStatus] = useState<"idle" | "running" | "done" | "failed">("idle");

	async function trigger() {
		setLoading(true);
		setStatus("running");
		onStarted?.();
		try {
			const res = await fetch("/api/discovery/manual-trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ context }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setStatus("done");
		} catch {
			setStatus("failed");
		} finally {
			setLoading(false);
		}
	}

	return (
		<button
			type="button"
			onClick={trigger}
			disabled={loading}
			className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg border transition-colors disabled:opacity-60 disabled:cursor-not-allowed bg-amber-500 text-white border-amber-500 hover:bg-amber-600"
		>
			{loading ? (
				<>
					<Loader2 size={12} className="animate-spin" />
					{t("manualTriggerRunning")}
				</>
			) : status === "done" ? (
				<>
					<Sparkles size={12} />
					{t("manualTriggerSuccess")}
				</>
			) : status === "failed" ? (
				<>{t("manualTriggerFailed")}</>
			) : (
				<>
					<Sparkles size={12} />
					{t("manualTrigger")}
				</>
			)}
		</button>
	);
}
```

- [ ] **Step 4: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add components/discovery/ContextSubTabs.tsx components/discovery/ManualTriggerButton.tsx messages/ja.json messages/en.json
git commit -m "feat(discovery): add ContextSubTabs + ManualTriggerButton components"
```

---

## Task 12: SessionCalendar + SessionList 컴포넌트

**Files:**
- Create: `components/discovery/SessionCalendar.tsx`
- Create: `components/discovery/SessionList.tsx`

- [ ] **Step 1: `SessionCalendar.tsx` 생성**

```tsx
"use client";
import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

export type SessionRow = {
	id: string;
	run_at: string;
	status: "running" | "completed" | "partial" | "failed";
	produced_count: number;
	context: "home_shopping" | "live_commerce";
};

function statusColor(status: SessionRow["status"]): string {
	switch (status) {
		case "completed":
			return "bg-green-500";
		case "partial":
			return "bg-yellow-500";
		case "failed":
			return "bg-red-500";
		default:
			return "bg-blue-500";
	}
}

function monthKey(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Simple month calendar showing dots per session on each day.
 * Defaults to current month; uses UTC dates to avoid timezone drift.
 */
export function SessionCalendar({ sessions, month }: { sessions: SessionRow[]; month?: Date }) {
	const { locale } = useParams<{ locale: string }>();
	const base = month ?? new Date();
	const year = base.getFullYear();
	const mon = base.getMonth();
	const firstDay = new Date(year, mon, 1);
	const lastDay = new Date(year, mon + 1, 0);
	const totalDays = lastDay.getDate();
	const startWeekday = firstDay.getDay(); // 0=Sun

	const byDay = useMemo(() => {
		const map = new Map<number, SessionRow[]>();
		for (const s of sessions) {
			const d = new Date(s.run_at);
			if (monthKey(d) !== monthKey(base)) continue;
			const day = d.getDate();
			const arr = map.get(day) ?? [];
			arr.push(s);
			map.set(day, arr);
		}
		return map;
	}, [sessions, base]);

	const cells: Array<{ day: number | null; sessions: SessionRow[] }> = [];
	for (let i = 0; i < startWeekday; i++) cells.push({ day: null, sessions: [] });
	for (let d = 1; d <= totalDays; d++) {
		cells.push({ day: d, sessions: byDay.get(d) ?? [] });
	}

	return (
		<div className="bg-white border border-gray-200 rounded-lg p-4">
			<div className="text-sm font-semibold text-gray-800 mb-3">
				{year}年 {mon + 1}月
			</div>
			<div className="grid grid-cols-7 gap-1 text-[10px] text-gray-400 mb-1">
				{["日", "月", "火", "水", "木", "金", "土"].map((d) => (
					<div key={d} className="text-center py-1">{d}</div>
				))}
			</div>
			<div className="grid grid-cols-7 gap-1">
				{cells.map((cell, i) => {
					if (cell.day === null) return <div key={i} />;
					if (cell.sessions.length === 0) {
						return (
							<div key={i} className="aspect-square flex flex-col items-center justify-start pt-1 text-[10px] text-gray-300">
								{cell.day}
							</div>
						);
					}
					const first = cell.sessions[0];
					const href = `/${locale}/analytics/discovery/session/${first.id}`;
					return (
						<Link
							key={i}
							href={href}
							className="aspect-square flex flex-col items-center justify-start pt-1 rounded hover:bg-gray-50 transition-colors"
							title={cell.sessions.map((s) => `${s.context === "home_shopping" ? "ホーム" : "ライブ"}: ${s.status} (${s.produced_count})`).join("\n")}
						>
							<span className="text-[10px] text-gray-700">{cell.day}</span>
							<div className="flex gap-0.5 mt-0.5">
								{cell.sessions.slice(0, 4).map((s) => (
									<span
										key={s.id}
										className={`w-1.5 h-1.5 rounded-full ${statusColor(s.status)} ${s.context === "live_commerce" ? "ring-1 ring-purple-400" : ""}`}
									/>
								))}
							</div>
						</Link>
					);
				})}
			</div>
			<div className="flex flex-wrap gap-3 mt-3 text-[10px] text-gray-500">
				<span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" />完了</span>
				<span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500" />部分</span>
				<span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" />失敗</span>
				<span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-300 ring-1 ring-purple-400" />ライブ</span>
			</div>
		</div>
	);
}
```

- [ ] **Step 2: `SessionList.tsx` 생성**

```tsx
"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Home, Tv } from "lucide-react";
import type { SessionRow } from "./SessionCalendar";

function statusBadge(status: SessionRow["status"]): { label: string; color: string } {
	switch (status) {
		case "completed":
			return { label: "完了", color: "bg-green-100 text-green-700" };
		case "partial":
			return { label: "部分", color: "bg-yellow-100 text-yellow-700" };
		case "failed":
			return { label: "失敗", color: "bg-red-100 text-red-700" };
		default:
			return { label: "実行中", color: "bg-blue-100 text-blue-700" };
	}
}

export function SessionList({ sessions }: { sessions: SessionRow[] }) {
	const { locale } = useParams<{ locale: string }>();

	if (sessions.length === 0) {
		return (
			<div className="bg-white border border-gray-200 rounded-lg py-10 text-center text-sm text-gray-400">
				(履歴なし)
			</div>
		);
	}

	return (
		<div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
			{sessions.map((s) => {
				const badge = statusBadge(s.status);
				const isHome = s.context === "home_shopping";
				return (
					<Link
						key={s.id}
						href={`/${locale}/analytics/discovery/session/${s.id}`}
						className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 transition-colors text-sm"
					>
						<span className="text-xs font-mono text-gray-500 w-32 shrink-0">
							{new Date(s.run_at).toLocaleString("ja-JP")}
						</span>
						<span
							className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold ${
								isHome
									? "bg-blue-50 text-blue-700 border border-blue-200"
									: "bg-purple-50 text-purple-700 border border-purple-200"
							}`}
						>
							{isHome ? <Home size={9} /> : <Tv size={9} />}
							{isHome ? "ホーム" : "ライブ"}
						</span>
						<span className={`text-[10px] px-2 py-0.5 rounded-full ${badge.color}`}>
							{badge.label}
						</span>
						<span className="text-xs text-gray-600">{s.produced_count}件</span>
						<span className="ml-auto text-xs text-blue-600">詳細 →</span>
					</Link>
				);
			})}
		</div>
	);
}
```

- [ ] **Step 3: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add components/discovery/SessionCalendar.tsx components/discovery/SessionList.tsx
git commit -m "feat(discovery): add SessionCalendar + SessionList components"
```

---

## Task 13: 라우트 재구성 — home / live / history / session 페이지

**Files:**
- Create: `app/[locale]/analytics/discovery/home/page.tsx`
- Create: `app/[locale]/analytics/discovery/live/page.tsx`
- Create: `app/[locale]/analytics/discovery/history/page.tsx`
- Rename: `app/[locale]/analytics/discovery/[sessionId]/page.tsx` → `app/[locale]/analytics/discovery/session/[sessionId]/page.tsx`
- Modify: `app/[locale]/analytics/discovery/page.tsx` → redirect to `/home`

- [ ] **Step 1: `discovery/page.tsx` redirect로 교체**

Replace file content:

```tsx
import { redirect } from "next/navigation";

export default async function DiscoveryIndexPage({
	params,
}: {
	params: Promise<{ locale: string }>;
}) {
	const { locale } = await params;
	redirect(`/${locale}/analytics/discovery/home`);
}
```

- [ ] **Step 2: `discovery/home/page.tsx` 생성**

Copy the existing page logic but add `?context=home_shopping` to the API call + ManualTriggerButton + ContextSubTabs:

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { DiscoveryHeader } from "@/components/discovery/DiscoveryHeader";
import { ProductCard, type DiscoveredProductRow } from "@/components/discovery/ProductCard";
import {
	DiscoveryFilters,
	type SortKey,
	type StatusFilter,
} from "@/components/discovery/DiscoveryFilters";
import { ContextSubTabs } from "@/components/discovery/ContextSubTabs";
import { ManualTriggerButton } from "@/components/discovery/ManualTriggerButton";

type Session = {
	id: string;
	run_at: string;
	completed_at: string | null;
	status: "running" | "completed" | "partial" | "failed";
	target_count: number;
	produced_count: number;
	iterations: number;
};

export default function DiscoveryHomePage() {
	const t = useTranslations("discovery");
	const [session, setSession] = useState<Session | null>(null);
	const [products, setProducts] = useState<DiscoveredProductRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [status, setStatus] = useState<StatusFilter>("all");
	const [sort, setSort] = useState<SortKey>("score");

	const load = async () => {
		setLoading(true);
		const res = await fetch("/api/discovery/today?context=home_shopping");
		const data = await res.json();
		setSession(data.session);
		setProducts(data.products ?? []);
		setLoading(false);
	};

	useEffect(() => {
		load();
	}, []);

	const filtered = useMemo(() => {
		let list = products;
		if (status === "uncategorized") list = list.filter((p) => !(p as unknown as { user_action?: string }).user_action);
		else if (status !== "all")
			list = list.filter((p) => (p as unknown as { user_action?: string }).user_action === status);
		if (sort === "score") list = [...list].sort((a, b) => (b.tv_fit_score ?? 0) - (a.tv_fit_score ?? 0));
		else if (sort === "price") list = [...list].sort((a, b) => (b.price_jpy ?? 0) - (a.price_jpy ?? 0));
		return list;
	}, [products, status, sort]);

	const counts = useMemo(() => {
		const total = products.length;
		const uncategorized = products.filter((p) => !(p as unknown as { user_action?: string }).user_action).length;
		const sourced = products.filter((p) => (p as unknown as { user_action?: string }).user_action === "sourced").length;
		return { total, uncategorized, sourced };
	}, [products]);

	return (
		<div>
			<ContextSubTabs />
			<div className="flex items-center justify-between mb-4 flex-wrap gap-2">
				<p className="text-sm text-gray-500">{t("subtitle")} — ホームショッピング</p>
				<ManualTriggerButton context="home_shopping" onStarted={() => setTimeout(load, 180_000)} />
			</div>

			{loading ? (
				<div className="py-20 text-center text-sm text-gray-500">Loading...</div>
			) : (
				<>
					<DiscoveryHeader
						session={session}
						totalCount={counts.total}
						uncategorizedCount={counts.uncategorized}
						sourcedCount={counts.sourced}
					/>
					<DiscoveryFilters status={status} onStatusChange={setStatus} sort={sort} onSortChange={setSort} />
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
				</>
			)}
		</div>
	);
}
```

- [ ] **Step 3: `discovery/live/page.tsx` 생성**

Same file but:
- `fetch("/api/discovery/today?context=live_commerce")`
- `<ManualTriggerButton context="live_commerce" ...`
- Label: "ライブコマース"

- [ ] **Step 4: `discovery/history/page.tsx` 생성**

```tsx
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ContextSubTabs } from "@/components/discovery/ContextSubTabs";
import { SessionCalendar, type SessionRow } from "@/components/discovery/SessionCalendar";
import { SessionList } from "@/components/discovery/SessionList";

type FilterContext = "all" | "home_shopping" | "live_commerce";

export default function DiscoveryHistoryPage() {
	const t = useTranslations("discovery");
	const [sessions, setSessions] = useState<SessionRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [contextFilter, setContextFilter] = useState<FilterContext>("all");
	const [month, setMonth] = useState<Date>(new Date());

	useEffect(() => {
		let cancelled = false;
		async function load() {
			setLoading(true);
			const q = new URLSearchParams();
			if (contextFilter !== "all") q.set("context", contextFilter);
			// range: 6 weeks around the viewed month
			const from = new Date(month.getFullYear(), month.getMonth() - 1, 1);
			const to = new Date(month.getFullYear(), month.getMonth() + 2, 0);
			q.set("from", from.toISOString());
			q.set("to", to.toISOString());

			const res = await fetch(`/api/discovery/history?${q}`);
			const data = await res.json();
			if (!cancelled) {
				setSessions(data.sessions ?? []);
				setLoading(false);
			}
		}
		load();
		return () => {
			cancelled = true;
		};
	}, [contextFilter, month]);

	return (
		<div>
			<ContextSubTabs />

			<div className="flex items-center gap-2 mb-4 flex-wrap">
				<span className="text-xs text-gray-500">Context:</span>
				{(["all", "home_shopping", "live_commerce"] as FilterContext[]).map((c) => (
					<button
						key={c}
						onClick={() => setContextFilter(c)}
						className={`px-3 py-1 text-xs rounded-full border transition-colors ${
							contextFilter === c
								? "bg-amber-500 text-white border-amber-500"
								: "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
						}`}
					>
						{c === "all" ? "全て" : c === "home_shopping" ? "ホーム" : "ライブ"}
					</button>
				))}
				<div className="ml-auto flex items-center gap-2">
					<button
						onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
						className="px-2 py-1 text-xs bg-white border border-gray-200 rounded hover:bg-gray-50"
					>
						←
					</button>
					<span className="text-xs text-gray-600 font-mono">
						{month.getFullYear()}-{String(month.getMonth() + 1).padStart(2, "0")}
					</span>
					<button
						onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
						className="px-2 py-1 text-xs bg-white border border-gray-200 rounded hover:bg-gray-50"
					>
						→
					</button>
				</div>
			</div>

			{loading ? (
				<div className="py-20 text-center text-sm text-gray-500">Loading...</div>
			) : (
				<div className="space-y-4">
					<SessionCalendar sessions={sessions} month={month} />
					<SessionList sessions={sessions} />
				</div>
			)}
		</div>
	);
}
```

- [ ] **Step 5: 세션 상세 페이지 이동**

Current: `app/[locale]/analytics/discovery/[sessionId]/page.tsx`
Target: `app/[locale]/analytics/discovery/session/[sessionId]/page.tsx`

Use `git mv`:
```bash
mkdir -p "app/[locale]/analytics/discovery/session"
git mv "app/[locale]/analytics/discovery/[sessionId]/page.tsx" "app/[locale]/analytics/discovery/session/[sessionId]/page.tsx"
rm -rf "app/[locale]/analytics/discovery/[sessionId]"
```

In the moved file, add `<ContextSubTabs />` at the top of the render to keep navigation consistent.

- [ ] **Step 6: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add app/[locale]/analytics/discovery/
git commit -m "feat(discovery): restructure routes — home/live/history/session sub-pages"
```

---

## Task 14: ProductCard — 연계 버튼 추가

**Files:**
- Create: `components/discovery/IntegrationActions.tsx`
- Modify: `components/discovery/ProductCard.tsx`

- [ ] **Step 1: `IntegrationActions.tsx` 생성**

```tsx
"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { TrendingUp, Radio } from "lucide-react";

export function IntegrationActions({
	context,
	productName,
	category,
	productUrl,
	priceJpy,
}: {
	context: "home_shopping" | "live_commerce";
	productName: string;
	category: string | null;
	productUrl: string;
	priceJpy: number | null;
}) {
	const t = useTranslations("discovery");
	const { locale } = useParams<{ locale: string }>();

	const targetPath =
		context === "live_commerce"
			? `/${locale}/analytics/live-commerce`
			: `/${locale}/analytics/expansion`;

	const params = new URLSearchParams();
	params.set("seed", productName);
	if (category) params.set("category", category);
	if (productUrl) params.set("sourceUrl", productUrl);
	if (priceJpy) params.set("price", String(priceJpy));

	const href = `${targetPath}?${params.toString()}`;

	const label =
		context === "live_commerce" ? t("viewLiveStrategy") : t("viewStrategy");
	const icon =
		context === "live_commerce" ? <Radio size={12} /> : <TrendingUp size={12} />;

	return (
		<Link
			href={href}
			className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-800 text-xs font-semibold rounded-lg transition-colors"
		>
			{icon}
			{label}
		</Link>
	);
}
```

- [ ] **Step 2: `ProductCard.tsx` 에 IntegrationActions 통합**

Open `components/discovery/ProductCard.tsx`. Add import:

```typescript
import { IntegrationActions } from "./IntegrationActions";
```

Add `context` field to `DiscoveredProductRow` type:

```typescript
export type DiscoveredProductRow = {
	// ... existing fields ...
	context?: "home_shopping" | "live_commerce";    // NEW
	// ...
};
```

In the render JSX, between `External link` section and `Enrichment control`, add:

```tsx
{/* Integration action */}
<div className="mb-3">
	<IntegrationActions
		context={product.context ?? "home_shopping"}
		productName={product.name}
		category={product.category}
		productUrl={product.product_url}
		priceJpy={product.price_jpy}
	/>
</div>
```

- [ ] **Step 3: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add components/discovery/IntegrationActions.tsx components/discovery/ProductCard.tsx
git commit -m "feat(discovery): add integration buttons (拡大戦略 / ライブ戦略) with URL pre-fill"
```

---

## Task 15: MDStrategyPanel seed URL pre-fill

**Files:**
- Modify: `components/analytics/MDStrategyPanel.tsx`

- [ ] **Step 1: useSearchParams로 seed 파라미터 읽어 초기 state 설정**

Open `components/analytics/MDStrategyPanel.tsx`. Near the top where state is initialized (around line 395 with `const [category, setCategory] = useState('指定なし');`):

Add import if missing:
```typescript
import { useSearchParams } from "next/navigation";
```

Replace the initial state declarations:
```typescript
const searchParams = useSearchParams();
const seedName = searchParams.get("seed");
const seedCategory = searchParams.get("category");
const seedPrice = searchParams.get("price");
const seedUrl = searchParams.get("sourceUrl");

const [userGoal, setUserGoal] = useState(
    seedName ? `新商品「${seedName}」の拡大戦略を立てる。${seedUrl ? `参考URL: ${seedUrl}` : ""}` : "",
);
const [category, setCategory] = useState(seedCategory ?? "指定なし");
const [targetMarket, setTargetMarket] = useState("");
const [priceRange, setPriceRange] = useState(
    seedPrice ? `¥${Number(seedPrice).toLocaleString()}前後` : "",
);
```

(If these states already exist, modify their initial values only, not add duplicates.)

The existing `CATEGORIES` dropdown may not contain the exact category — if seedCategory doesn't match, it'll display as the raw string. That's OK for pre-fill; user adjusts.

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add components/analytics/MDStrategyPanel.tsx
git commit -m "feat(mdstrategy): pre-fill from discovery seed URL params"
```

**Note:** `LiveCommercePanel.tsx` 에도 동일 패턴을 적용하려면 별도 수정 필요. 파일 구조가 비슷하다면 동일 방식으로 `seed` / `category` / `price` 읽기. 구조 다르면 이 task에서 skip하고 follow-up task로 분리.

---

## Task 16: end-to-end 검증

**Files:** (실행만)

- [ ] **Step 1: 타입 체크 + dev 서버 재시작**

```bash
npx tsc --noEmit
npm run dev
```

- [ ] **Step 2: 수동 cron 트리거 (양쪽 context)**

```bash
# Home shopping
curl -X POST http://localhost:3000/api/discovery/manual-trigger \
  -H "Content-Type: application/json" \
  -d '{"context":"home_shopping"}'

# Wait 2-3 min, then live
curl -X POST http://localhost:3000/api/discovery/manual-trigger \
  -H "Content-Type: application/json" \
  -d '{"context":"live_commerce"}'
```

각 응답에 `producedCount: 30` + `context: "home_shopping" | "live_commerce"` 표시 확인.

- [ ] **Step 3: 브라우저 UI 검증**

**http://localhost:3000/ja/analytics/discovery** → auto-redirect to `/home`

확인 사항:
- [ ] 상단에 3 서브탭 (ホームショッピング / ライブコマース / 履歴), 현재 탭 하이라이트
- [ ] "今すぐ発掘" 버튼 보임
- [ ] 오늘의 홈쇼핑 세션 (30개) 표시
- [ ] 각 카드에 이미지 표시 (재발굴 후)
- [ ] "拡大戦略を作成" 버튼 → 클릭 시 `/analytics/expansion?seed=...` 로 이동, MDStrategyPanel의 userGoal/category/priceRange pre-filled

`/analytics/discovery/live` 접속:
- [ ] 라이브커머스 세션 (30개) 표시
- [ ] "ライブ戦略を作成" 버튼

`/analytics/discovery/history` 접속:
- [ ] 캘린더 표시, 세션 있는 날짜에 도트
- [ ] 월 이동 ← → 작동
- [ ] Context 필터 (全て / ホーム / ライブ) 작동
- [ ] 도트 클릭 → 세션 상세 페이지 이동
- [ ] 아래 리스트 뷰 표시, 순차 정렬

- [ ] **Step 4: DB 검증**

```sql
-- 양쪽 컨텍스트 세션 존재 확인
SELECT context, COUNT(*) FROM discovery_runs GROUP BY context;

-- 최근 24시간 가장 최근 세션
SELECT id, run_at, context, status, produced_count
FROM discovery_runs
WHERE run_at > now() - interval '24 hours'
ORDER BY run_at DESC;

-- 제품들도 컨텍스트별 구분되는지
SELECT context, COUNT(*), COUNT(DISTINCT session_id)
FROM discovered_products
WHERE created_at > now() - interval '24 hours'
GROUP BY context;
```

- [ ] **Step 5: Phase 3.5 완료 선언**

```bash
git log --oneline main..HEAD | head -20
```

---

## Self-Review

**Spec coverage:**
- Issue 1 (이미지): Task 1 ✓
- Issue 2 (피드백 버튼): out of scope (Phase 4) ✓
- Issue 3 (히스토리): Task 12, 13 (캘린더 + 리스트) ✓
- Issue 4 (연계): Task 14, 15 (버튼 + pre-fill) ✓
- Context split: Tasks 2-7 ✓
- Manual trigger: Tasks 8, 11 ✓

**Placeholder scan:** 모든 task 구체적 코드 포함.

**Type consistency:**
- `Context` 타입이 types.ts에 단일 정의, 모든 사용처에서 import.
- `Candidate.context` required, `PoolItem.context` optional (pool 단계에서는 미정).
- DB `context` 컬럼 default 'home_shopping' → 기존 row 모두 home으로 분류됨 (합리적).

**Gaps / 주의:**
- LiveCommercePanel pre-fill은 Task 15에서 skip했음. 필요 시 후속 task.
- 기존 `discovery_runs` 최근 세션들은 이제 `context='home_shopping'` 으로 뜸. ライブ 탭은 빈 상태로 시작. 첫 실행 후 데이터 채워짐.
- cron 스케줄이 UTC 00:00 + 00:30이라 순차 실행으로 API rate-limit 안전.
- 마이그레이션(Task 10)은 Task 2 SQL 파일 작성 후, 코드 변경들이 모두 적용된 다음에 실행해야 함. Task 순서상 Task 10을 Task 7 이후, Task 11 이전에 수행.
