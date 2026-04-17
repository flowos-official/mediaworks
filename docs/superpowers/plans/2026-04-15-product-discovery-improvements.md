# 신상품 발굴 시스템 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 피드백 4가지 항목 (Fail 에러, 상품 수 부족, 정확도 개선, 탭 배치) 을 반영하여 신상품 발굴 시스템의 안정성·품질·접근성을 개선한다.

**Architecture:** 기존 `discoverNewProducts()` 함수의 에러 복원력과 Gemini 프롬프트를 강화하고, TV쇼핑 적합성 필터를 추가하며, Analytics 레이아웃에 독립 "신상品発掘" 탭을 신설한다.

**Tech Stack:** Next.js App Router, TypeScript, Google Gemini API, Rakuten API, Brave Search API, Supabase, shadcn/ui, Tailwind CSS

---

## 피드백 항목 ↔ 태스크 매핑

| # | 피드백 | 근본 원인 | 태스크 |
|---|--------|-----------|--------|
| 1 | 'Fail' 표시로 검색 결과 없음 | Rakuten/Brave API 실패 시 빈 배열 반환 → pool 0건 → undefined 반환. Gemini JSON 파싱 실패. Sanity-pass에서 전건 탈락. | Task 1 |
| 2 | 발굴 상품 수 평균 4-5개로 적다 | Gemini에 5개 요청하나 sanity-pass에서 URL 불일치 항목 탈락. Pool 30건 제한. | Task 2 |
| 3 | 정확도 낮음 (TV쇼핑 부적합 상품 포함) | 스코어링이 리뷰 수·평점 위주. TV쇼핑 적합성(실연 가능, 가격대, 시각적 매력) 판단 없음. | Task 3 |
| 4 | 신상품 검색을 라이브 커머스 옆 5번째 탭으로 | 현재 拡大戦略/ライブコマース 안에 내장. 독립 탭 없음. | Task 4, 5 |

## File Structure

| 파일 | 변경 유형 | 역할 |
|------|-----------|------|
| `lib/md-strategy.ts` | Modify | 재시도 로직, pool 확대, 상품 수 증가, TV적합성 필터, sanity-pass 개선 |
| `components/analytics/DiscoveredProductsHero.tsx` | Modify | 3열 그리드 확장 |
| `app/[locale]/analytics/layout.tsx` | Modify | 5번째 탭 추가 |
| `supabase/migrations/20260415_discovery_sessions.sql` | Create | 독립 발굴 세션 테이블 |
| `app/api/analytics/discovery/route.ts` | Create | 독립 신상품 발굴 API (persistence 포함) |
| `app/[locale]/analytics/discovery/page.tsx` | Create | 독립 신상품 발굴 페이지 |
| `components/analytics/ProductDiscoveryPanel.tsx` | Create | 독립 신상품 발굴 UI 패널 |

---

## Task 1: Fail 에러 복원력 강화 — `discoverNewProducts()` 재시도 & 폴백

**Files:**
- Modify: `lib/md-strategy.ts:494-752`

이 태스크는 `discoverNewProducts()` 함수에서 Fail이 발생하는 2가지 원인을 각각 처리한다:
1. Rakuten/Brave API 실패 → 개별 API 재시도
2. Pool이 비어있음 → 키워드 일반화 폴백

**주의**: `callGemini()` 내부에 이미 2모델 × 3 attempts + exponential backoff 재시도가 구현되어 있음 (line 100-129). Gemini 호출 자체의 외부 재시도는 추가하지 않는다. Sanity-pass 전건 탈락은 Task 2에서 요청 수 증가로 해결한다.

- [ ] **Step 1: Rakuten API 호출에 재시도 로직 추가**

`lib/md-strategy.ts`의 rakuten 호출부 (line 518-525)를 수정한다. 현재 `.catch(() => ({ items: [] }))`로 실패를 무시하고 있어 pool이 비는 원인이 된다.

```typescript
// lib/md-strategy.ts — line 518-525 교체
keywords.map(async (kw) => {
	const cleanKw = normalizeForRakuten(kw);
	// Retry once on transient failure before giving up
	const attempt = async () => {
		const search = await rakutenItemSearch(cleanKw, "-reviewCount", 10);
		if (search.items.length > 0) return search;
		console.log(`[discover] rakuten search empty for "${cleanKw}", falling back to Ranking API`);
		return await rakutenRankingSearch(cleanKw);
	};
	try {
		return await attempt();
	} catch (err) {
		console.warn(`[discover] rakuten first attempt failed for "${cleanKw}": ${err instanceof Error ? err.message : err}`);
		await new Promise((r) => setTimeout(r, 1000));
		try {
			return await attempt();
		} catch {
			console.warn(`[discover] rakuten retry also failed for "${cleanKw}" — skipping`);
			return { items: [] };
		}
	}
}),
```

- [ ] **Step 2: Brave Search 호출에 재시도 로직 추가**

`lib/md-strategy.ts`의 brave product search 호출부 (line 528-532)를 수정한다.

```typescript
// lib/md-strategy.ts — line 528-532 교체
keywords.map(async (kw) => {
	try {
		return await braveSearchStructured(`${kw} 売れ筋 人気 ランキング 2025 楽天 Amazon`);
	} catch (err) {
		console.warn(`[discover] brave search failed for "${kw}": ${err instanceof Error ? err.message : err}`);
		await new Promise((r) => setTimeout(r, 1000));
		try {
			return await braveSearchStructured(`${kw} 人気商品 おすすめ`);
		} catch {
			console.warn(`[discover] brave retry also failed for "${kw}" — skipping`);
			return [];
		}
	}
}),
```

- [ ] **Step 3: Pool이 비었을 때 키워드 일반화 폴백 추가**

`lib/md-strategy.ts`의 pool 빈 체크 부분 (line 610-615)을 수정한다. Pool이 0건일 때 바로 undefined를 반환하는 대신, 더 일반적인 키워드로 한 번 더 시도한다.

**중요**: `cappedPool`은 이후 `poolText` (line 619) 와 `validUrls` (line 741)에서 참조된다. 폴백으로 pool을 확장한 경우 `cappedPool` 재할당이 `poolText` 빌드보다 **반드시 앞에** 와야 한다. 따라서 기존 코드의 `const cappedPool = pool.slice(0, 30)` + empty check + 이후 `poolText` 빌드 순서를 유지하면서, empty일 때만 pool을 확장하고 `cappedPool`을 재할당한다.

```typescript
// lib/md-strategy.ts — line 610-615 교체
// Pool cap 확대 (30 → 40)
let cappedPool = pool.slice(0, 40);
console.log(`[discover] pool built: total=${pool.length} capped=${cappedPool.length} (rakuten=${pool.filter(p => p.source === 'rakuten').length} web=${pool.filter(p => p.source === 'web').length})`);

// Fallback: if pool is empty, retry with broader generic keywords
if (cappedPool.length === 0) {
	console.warn(`[discover] pool empty — retrying with broadened keywords`);
	const fallbackKeywords = ["人気商品", "売れ筋", "おすすめ"];
	const fallbackResults = await Promise.all(
		fallbackKeywords.map(async (kw) => {
			const search = await rakutenItemSearch(kw, "-reviewCount", 10).catch(() => ({ items: [] }));
			return search;
		}),
	);
	for (const r of fallbackResults) {
		for (const item of r.items.slice(0, 8)) {
			if (!item.itemUrl || seenUrls.has(item.itemUrl)) continue;
			if (isTvLike(item.itemName)) continue;
			seenUrls.add(item.itemUrl);
			pool.push({
				name: item.itemName.slice(0, 80),
				price: item.itemPrice,
				source: "rakuten",
				source_url: item.itemUrl,
				snippet: item.itemCaption.slice(0, 140),
				keyword: "fallback",
				reviewCount: item.reviewCount,
				reviewAverage: item.reviewAverage,
			});
		}
	}
	// 재할당 — 이 시점 이후에 poolText가 빌드되므로 안전
	cappedPool = pool.slice(0, 40);
	console.log(`[discover] fallback pool: ${cappedPool.length} items`);
	if (cappedPool.length === 0) {
		console.warn(`[discover] fallback also empty — returning undefined`);
		return undefined;
	}
}

// ↓ 여기서부터 poolText 빌드 (기존 line 619) — cappedPool이 확정된 후
```

- [ ] **Step 4: Gemini sanity-pass 개선 — URL 정규화로 탈락률 감소**

`callGemini()` 내부에 이미 2모델 × 3 attempts + exponential backoff 재시도가 있으므로 (line 100-129), 외부 Gemini 재시도는 추가하지 않는다. 대신 sanity-pass에서 불필요하게 탈락하는 원인을 개선한다.

현재 sanity-pass (line 740-746)는 Gemini가 반환한 `source_url`이 pool의 URL과 정확히 일치하는지 검사한다. Gemini가 URL 끝에 슬래시를 추가/제거하거나 query parameter 순서를 바꾸면 탈락한다.

`lib/md-strategy.ts` line 741을 수정한다:

```typescript
// lib/md-strategy.ts — line 740-746 교체
// Sanity-pass: drop items whose source_url isn't actually in the pool (anti-hallucination)
// Normalize URLs to reduce false rejections (trailing slash, protocol differences)
const normalizeUrl = (u: string) => u.replace(/\/+$/, '').replace(/^https?:\/\//, '');
const validUrls = new Set(cappedPool.map((p) => normalizeUrl(p.source_url)).filter(Boolean));
const filtered = parsed.filter((p) => !!p.source_url && validUrls.has(normalizeUrl(p.source_url)));
console.log(`[discover] sanity-pass: ${filtered.length}/${parsed.length} items survived URL whitelist`);
if (filtered.length === 0 && parsed.length > 0) {
	console.warn(`[discover] all ${parsed.length} Gemini items failed sanity-pass — Gemini may have hallucinated URLs`);
}
return filtered.length > 0 ? filtered : undefined;
```

- [ ] **Step 5: `npx tsc --noEmit` 실행하여 타입 에러 없는지 확인**

Run: `npx tsc --noEmit`
Expected: 에러 없이 통과

- [ ] **Step 6: Commit**

```bash
git add lib/md-strategy.ts
git commit -m "fix: add retry logic and fallback to product discovery to reduce Fail rate"
```

---

## Task 2: 발굴 상품 수 증가 — Pool 확대 & Gemini 요청 수 증가

**Files:**
- Modify: `lib/md-strategy.ts:494-752`

현재: Gemini에 5개 요청 → sanity-pass로 4-5개 → 때로 3-4개.
변경: Gemini에 8개 요청, pool 상한 40개로 확대, 최종 결과 최소 6개 보장.

- [ ] **Step 1: Pool 상한을 30 → 40으로 확대**

Task 1의 Step 3에서 이미 `pool.slice(0, 40)`으로 변경 완료.

- [ ] **Step 2: Rakuten 결과 per-keyword 상한을 6 → 8로 확대**

`lib/md-strategy.ts` line 567의 `.slice(0, 6)`를 `.slice(0, 8)`로 변경한다.

```typescript
// lib/md-strategy.ts — line 567
for (const item of r.items.slice(0, 8)) {
```

- [ ] **Step 3: Gemini 프롬프트의 요청 상품 수를 5 → 8로 변경**

`lib/md-strategy.ts`의 프롬프트 부분을 수정한다.

line 652의 `新商品を5つ選定` → `新商品を8つ選定`:
```typescript
const prompt = `あなたは日本の${roleLabel}です。下記の (1) TV自社販売シグナル と (2) 日本市場トレンド情報 の両方を根拠に、楽天/Webから検索された実在商品プールから「日本の消費者に今売れる/関心が高い」新商品を8つ選定し、各商品の販売戦略まで策定してください。
```

line 688の `exactly 5 items` → `exactly 8 items`:
```typescript
Return a JSON array of exactly 8 items (no markdown):
```

line 668의 `5商品を選定` → `8商品を選定`:
```typescript
- カテゴリが偏らないように8商品を選定。
```

- [ ] **Step 4: DiscoveredProductsHero의 그리드를 3열로 확장**

`components/analytics/DiscoveredProductsHero.tsx` line 401의 그리드를 수정한다. 8개 상품을 효과적으로 보여주기 위해 xl 이상에서 3열 그리드를 사용한다.

```typescript
// components/analytics/DiscoveredProductsHero.tsx — line 401
<div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
```

- [ ] **Step 5: `npx tsc --noEmit` 실행**

Run: `npx tsc --noEmit`
Expected: 에러 없이 통과

- [ ] **Step 6: Commit**

```bash
git add lib/md-strategy.ts components/analytics/DiscoveredProductsHero.tsx
git commit -m "feat: increase discovered products from 5 to 8 and expand pool size"
```

---

## Task 3: TV쇼핑 적합성 필터링 강화 — Gemini 프롬프트 개선

**Files:**
- Modify: `lib/md-strategy.ts:648-726`

현재 문제: 스코어링이 리뷰 수·평점·카테고리 일치 위주라서 TV쇼핑에 부적합한 상품(초소형 부품, 전문 기기, 설치 필요 대형 가전 등)도 추천됨.
해결: Gemini 프롬프트에 TV쇼핑 적합성 판단 기준과 명시적 배제 조건을 추가한다.

- [ ] **Step 1: TV쇼핑 부적합 상품 배제 조건을 프롬프트에 추가**

`lib/md-strategy.ts`의 `=== 厳守ルール ===` 섹션 (line 664-671) 뒤에 TV쇼핑 적합성 판단 블록을 추가한다.

```typescript
// lib/md-strategy.ts — line 671 뒤에 추가 (isLC가 false인 경우에만 적용)
const tvSuitabilityBlock = isLC ? "" : `
=== TV通販適合性フィルター ===
以下に該当する商品は選定から除外すること:
- 専門的な設置工事が必要な商品 (業務用機器、大型据付家電等)
- 画面上でデモンストレーションが困難な商品 (ソフトウェア、デジタルサービス等)
- 法規制により放送で販売促進が制限される商品 (医薬品、金融商品等)
- 消耗品のみで単価が低すぎる商品 (¥500未満の日用品)
- 専門資格がないと使用できない商品

以下の特性を持つ商品を優先すること:
- 映像でのビフォーアフターが見せやすい (美容、掃除、料理等)
- 実演デモで効果を即座に伝えられる
- 視聴者が衝動買いしやすい価格帯 (¥3,000〜¥30,000)
- ギフト需要があり、季節性を活かせる
- 既存TV通販カテゴリの隣接領域で新鮮味がある
`;
```

- [ ] **Step 2: プロンプトにTV適合性ブロックを挿入**

`lib/md-strategy.ts`のプロンプト文字列で `${channelGuidance}` の直前にこのブロックを挿入する。

```typescript
// lib/md-strategy.ts — prompt 문자열 내, line ~670 위치
// 기존:
- ${channelGuidance}
// 변경:
${tvSuitabilityBlock}
- ${channelGuidance}
```

- [ ] **Step 3: japan_fit_score 채점 기준에 TV적합성 항목 추가**

`lib/md-strategy.ts`의 채점 기준 (line 673-680)을 수정한다. 기존 5개 기준에 TV실연적합성을 추가하고, 총점 상한은 100 유지.

```typescript
// lib/md-strategy.ts — line 673-680 교체
=== japan_fit_score 採点ルール (0-100) ===
以下の加点で算出すること。各カテゴリで該当する一段階のみ加点 (重複加点禁止):
- 楽天レビュー数: ≥100件→+20 / 50-99件→+12 / 5-49件→+5 / それ以下→0
- 楽天レビュー平均: ≥4.0→+15 / 3.5-3.9→+8 / それ未満→0
- TVトップカテゴリ一致: 一致→+20 / 隣接→+10 / 不一致→0
- 日本市場トレンド情報に関連語句あり: あり→+15 / なし→0
- ユーザー目標/ターゲット市場合致: 合致→+10 / 不合致→0
- TV通販実演適合性 (映像デモ可能・衝動買い価格帯・ギフト需要): 高→+20 / 中→+10 / 低→0
- 合計は必ず 0-100 の範囲に収めること (上限超えは100に丸める)
```

注: `isLC` (ライブコマース) の場合はTV適合性の代わりにライブ配信適合性を使う。この分岐は既存の `channelGuidance` と同じパターンで処理する。

- [ ] **Step 4: ライブコマース用の適合性ブロックも追加**

```typescript
const lcSuitabilityBlock = isLC ? `
=== ライブ配信適合性フィルター ===
以下に該当する商品は選定から除外すること:
- 映像で魅力が伝わりにくい商品 (ソフトウェア、書籍等)
- 配送が困難な大型商品
- 法規制により放送で販売促進が制限される商品

以下の特性を持つ商品を優先すること:
- ホストが手に取って実演できる
- リアルタイムのコメント・質問に応えやすい
- 限定感・タイムセール感を演出できる
- SNSでシェアされやすいビジュアル
` : "";
```

そして `tvSuitabilityBlock` の代わりに `isLC ? lcSuitabilityBlock : tvSuitabilityBlock` を使う。ただし上の Step 1 で既に `isLC` 分岐していたので、実装は以下のようにまとめる:

```typescript
const suitabilityBlock = isLC ? lcSuitabilityBlock : tvSuitabilityBlock;
```

プロンプトに `${suitabilityBlock}` を挿入する。

- [ ] **Step 5: `npx tsc --noEmit` 実行**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 6: Commit**

```bash
git add lib/md-strategy.ts
git commit -m "feat: add TV/live-commerce suitability filters to product discovery prompt"
```

---

## Task 4: 독립 신상品発掘 API 엔드포인트 생성

**Files:**
- Create: `app/api/analytics/discovery/route.ts`

拡大戦略·ライブコマース에 의존하지 않고 독립적으로 신상품을 발굴할 수 있는 API. 사용자가 카테고리·목표 등을 직접 입력하면 `discoverNewProducts()`를 호출하여 결과를 반환한다.

**Persistence 설계**: 발굴 결과를 Supabase `discovery_sessions` 테이블에 저장하여 페이지 새로고침 후에도 이력이 유지되고, 재발굴 시 `excludeUrls`/`excludeNames` dedup이 동작하도록 한다.

- [ ] **Step 1: Supabase에 `discovery_sessions` 테이블 생성**

```sql
-- supabase/migrations/20260415_discovery_sessions.sql
CREATE TABLE IF NOT EXISTS discovery_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context text NOT NULL DEFAULT 'home_shopping',
  category text,
  target_market text,
  price_range text,
  user_goal text,
  discovery_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
```

- [ ] **Step 2: API 라우트 파일 생성**

```typescript
// app/api/analytics/discovery/route.ts
import { NextRequest } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { discoverNewProducts, type DiscoveryBatch } from "@/lib/md-strategy";

export const maxDuration = 120;

// POST: Run product discovery (new session or append to existing)
export async function POST(request: NextRequest) {
	const body = await request.json().catch(() => ({}));
	const {
		sessionId,
		context = "home_shopping",
		category,
		targetMarket,
		priceRange,
		userGoal,
		focus,
	} = body as {
		sessionId?: string;
		context?: "home_shopping" | "live_commerce";
		category?: string;
		targetMarket?: string;
		priceRange?: string;
		userGoal?: string;
		focus?: string;
	};

	const supabase = getServiceClient();

	// Load prior history if appending to existing session
	let priorHistory: DiscoveryBatch[] = [];
	if (sessionId) {
		const { data: session } = await supabase
			.from("discovery_sessions")
			.select("discovery_history")
			.eq("id", sessionId)
			.single();
		priorHistory = (session?.discovery_history as DiscoveryBatch[]) ?? [];
	}

	const excludeUrls = priorHistory
		.flatMap((b) => b.products.map((p) => p.source_url))
		.filter((u): u is string => !!u);
	const excludeNames = priorHistory.flatMap((b) => b.products.map((p) => p.name));

	// Fetch TV sales signals (same pattern as md-strategy rediscover)
	const [productResult, annualResult] = await Promise.all([
		supabase
			.from("product_summaries")
			.select("product_name, category, total_revenue, total_profit")
			.in("year", [2025, 2026])
			.order("total_revenue", { ascending: false })
			.limit(60),
		supabase
			.from("annual_summaries")
			.select("total_revenue, total_profit")
			.in("year", [2025, 2026]),
	]);

	const products = productResult.data ?? [];
	const annuals = annualResult.data ?? [];

	const categoryRevenue: Record<string, number> = {};
	for (const p of products) {
		const cat = p.category ?? "その他";
		categoryRevenue[cat] = (categoryRevenue[cat] ?? 0) + (p.total_revenue ?? 0);
	}
	const topCategoryNames = Object.entries(categoryRevenue)
		.sort(([, a], [, b]) => b - a)
		.slice(0, 3)
		.map(([cat]) => cat);

	const totalRevenue = annuals.reduce((s, a) => s + (a.total_revenue ?? 0), 0);
	const totalProfit = annuals.reduce((s, a) => s + (a.total_profit ?? 0), 0);
	const tvMarginRate = totalRevenue > 0
		? Math.round((totalProfit / totalRevenue) * 10000) / 100
		: 0;

	const discovered = await discoverNewProducts({
		context,
		topCategoryNames,
		explicitCategory: focus || category || undefined,
		targetMarket: targetMarket || undefined,
		priceRange: priceRange || undefined,
		userGoal: focus
			? `${userGoal ?? ""}\n追加フォーカス: ${focus}`.trim()
			: userGoal || undefined,
		tvProductNames: products.map((p) => p.product_name),
		tvMarginRate,
		excludeUrls,
		excludeNames,
	});

	if (!discovered || discovered.length === 0) {
		return Response.json(
			{ error: "新商品を発掘できませんでした。条件を変えて再度お試しください。" },
			{ status: 422 },
		);
	}

	const newBatch: DiscoveryBatch = {
		generatedAt: new Date().toISOString(),
		focus: focus || undefined,
		products: discovered,
	};
	const updatedHistory = [newBatch, ...priorHistory];

	// Upsert session
	if (sessionId) {
		await supabase
			.from("discovery_sessions")
			.update({
				discovery_history: updatedHistory as unknown as Record<string, unknown>[],
				updated_at: new Date().toISOString(),
			})
			.eq("id", sessionId);
	} else {
		const { data: newSession } = await supabase
			.from("discovery_sessions")
			.insert({
				context,
				category: category || null,
				target_market: targetMarket || null,
				price_range: priceRange || null,
				user_goal: userGoal || null,
				discovery_history: updatedHistory as unknown as Record<string, unknown>[],
			})
			.select("id")
			.single();

		return Response.json({
			sessionId: newSession?.id,
			batch: newBatch,
			discovery_history: updatedHistory,
		});
	}

	return Response.json({
		sessionId,
		batch: newBatch,
		discovery_history: updatedHistory,
	});
}

// GET: Load saved discovery sessions list
export async function GET() {
	const supabase = getServiceClient();
	const { data, error } = await supabase
		.from("discovery_sessions")
		.select("id, context, category, user_goal, created_at, updated_at, discovery_history")
		.order("updated_at", { ascending: false })
		.limit(20);

	if (error) {
		return Response.json({ error: error.message }, { status: 500 });
	}

	return Response.json({ sessions: data ?? [] });
}
```

- [ ] **Step 2: `npx tsc --noEmit` 실행**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 3: Commit**

```bash
git add app/api/analytics/discovery/route.ts
git commit -m "feat: add standalone product discovery API endpoint"
```

---

## Task 5: 독립 신상品発掘 탭 & UI 추가 (라이브 커머스 옆 5번째)

**Files:**
- Create: `app/[locale]/analytics/discovery/page.tsx`
- Create: `components/analytics/ProductDiscoveryPanel.tsx`
- Modify: `app/[locale]/analytics/layout.tsx:35-42`

### Sub-task 5a: Analytics 레이아웃에 5번째 탭 추가

- [ ] **Step 1: 탭 배열에 discovery 항목 추가**

`app/[locale]/analytics/layout.tsx` line 35-42의 TABS 배열을 수정한다.

```typescript
// app/[locale]/analytics/layout.tsx — line 35-42 교체
type TabKey = 'overview' | 'products' | 'expansion' | 'live-commerce' | 'discovery';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: '概要' },
  { key: 'products', label: '商品分析' },
  { key: 'expansion', label: '拡大戦略' },
  { key: 'live-commerce', label: 'ライブコマース' },
  { key: 'discovery', label: '新商品発掘' },
];
```

- [ ] **Step 2: Commit**

```bash
git add app/[locale]/analytics/layout.tsx
git commit -m "feat: add discovery tab to analytics layout as 5th tab"
```

### Sub-task 5b: ProductDiscoveryPanel 컴포넌트 생성

- [ ] **Step 3: 패널 컴포넌트 생성**

```typescript
// components/analytics/ProductDiscoveryPanel.tsx
'use client';

import { useState, useCallback } from 'react';
import { Search, Loader2, AlertTriangle, Sparkles } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import DiscoveredProductsHero from '@/components/analytics/DiscoveredProductsHero';
import type { DiscoveryBatch } from '@/lib/md-strategy';

// MDStrategyPanel과 동일한 카테고리 리스트 사용 (일관성 유지)
const CATEGORIES = [
  '指定なし', '美容・スキンケア', '健康食品', 'キッチン用品',
  'ファッション', '生活雑貨', '電気機器', 'フィットネス', 'その他',
];

const CONTEXTS = [
  { value: 'home_shopping' as const, label: 'TV通販向け' },
  { value: 'live_commerce' as const, label: 'ライブコマース向け' },
];

export default function ProductDiscoveryPanel() {
  const [context, setContext] = useState<'home_shopping' | 'live_commerce'>('home_shopping');
  const [category, setCategory] = useState('全カテゴリ');
  const [userGoal, setUserGoal] = useState('');
  const [priceRange, setPriceRange] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [history, setHistory] = useState<DiscoveryBatch[]>([]);

  const latestProducts = history.length > 0 ? history[0].products : undefined;

  const handleDiscover = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/analytics/discovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context,
          category: category === '指定なし' ? undefined : category,
          userGoal: userGoal.trim() || undefined,
          priceRange: priceRange.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setSessionId(data.sessionId);
      setHistory(data.discovery_history);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [context, category, userGoal, priceRange]);

  const handleRediscover = useCallback(async (focus: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/analytics/discovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          context,
          category: category === '指定なし' ? undefined : category,
          userGoal: userGoal.trim() || undefined,
          priceRange: priceRange.trim() || undefined,
          focus: focus || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setHistory(data.discovery_history);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId, context, category, userGoal, priceRange]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Search size={18} className="text-amber-600" />
        <h3 className="text-lg font-semibold text-gray-900">新商品発掘</h3>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
          AI Discovery
        </span>
      </div>

      <Card className="border-gray-200">
        <CardContent className="p-4 space-y-3">
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
              発掘の目的・方向性 (任意)
            </label>
            <textarea
              value={userGoal}
              onChange={(e) => setUserGoal(e.target.value)}
              placeholder="例: 美容家電で月商500万を目指したい / 季節商品を探している / 韓国で人気の商品を日本に"
              rows={2}
              disabled={loading}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 resize-none disabled:bg-gray-50"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1 block">
                チャネル
              </label>
              <select
                value={context}
                onChange={(e) => setContext(e.target.value as 'home_shopping' | 'live_commerce')}
                disabled={loading}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 disabled:bg-gray-50"
              >
                {CONTEXTS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1 block">
                カテゴリ
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                disabled={loading}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 disabled:bg-gray-50"
              >
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1 block">
                価格帯 (任意)
              </label>
              <input
                type="text"
                value={priceRange}
                onChange={(e) => setPriceRange(e.target.value)}
                disabled={loading}
                placeholder="例: ¥3,000-10,000"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 disabled:bg-gray-50"
              />
            </div>
          </div>

          <p className="text-[10px] text-gray-400">
            TV通販の販売シグナルと楽天・Web検索を組み合わせ、AIが新商品候補を選定します
          </p>

          <div className="flex items-center justify-end pt-1">
            <button
              type="button"
              onClick={handleDiscover}
              disabled={loading}
              className="flex items-center gap-2 px-5 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {loading ? '発掘中...' : '新商品を発掘'}
            </button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      {latestProducts && latestProducts.length > 0 && (
        <DiscoveredProductsHero
          products={latestProducts}
          contextLabel={context === 'live_commerce' ? 'ライブコマース' : 'TV通販'}
          history={history}
          onRediscover={handleRediscover}
          rediscovering={loading}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Discovery 페이지 생성**

```typescript
// app/[locale]/analytics/discovery/page.tsx
'use client';

import ProductDiscoveryPanel from '@/components/analytics/ProductDiscoveryPanel';

export default function DiscoveryPage() {
  return <ProductDiscoveryPanel />;
}
```

- [ ] **Step 5: `npx tsc --noEmit` 실행**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 6: dev 서버에서 탭 이동 및 발굴 동작 확인**

Run: `npm run dev`
확인 사항:
1. `/analytics/discovery` 접속 → 5번째 "新商品発掘" 탭이 라이브커머스 옆에 표시
2. 탭 클릭 → 폼이 보이고 카테고리/채널/가격대 선택 가능
3. "新商品を発掘" 클릭 → 로딩 후 상품 카드 8개 표시
4. "新商品を再発掘" → 추가 발굴 및 이력 표시

- [ ] **Step 7: Commit**

```bash
git add app/[locale]/analytics/discovery/page.tsx components/analytics/ProductDiscoveryPanel.tsx
git commit -m "feat: add standalone product discovery tab as 5th analytics tab"
```

---

## Self-Review Checklist

| # | 체크 항목 | 결과 |
|---|-----------|------|
| 1 | Fail 에러 → Task 1에서 API 재시도 + 폴백 + sanity-pass URL 정규화 | OK |
| 2 | 상품 수 부족 → Task 2에서 5→8개, pool 30→40, Rakuten 6→8 | OK |
| 3 | 정확도 → Task 3에서 TV쇼핑/라이브 적합성 필터 + 스코어링 기준 개선 | OK |
| 4 | 탭 배치 → Task 5에서 ライブコマース 옆 5번째 탭 추가 | OK |
| 5 | 타입 일관성: `DiscoveryBatch`, `DiscoverInput` 등 기존 타입 재사용 | OK |
| 6 | 플레이스홀더 없음: 모든 코드 블록 완전 | OK |
| 7 | Gemini 외부 재시도 제거 — `callGemini` 내부 retry와 중복/timeout 위험 방지 | OK (검증 후 수정) |
| 8 | `cappedPool` 재할당이 `poolText` 빌드보다 앞에 위치 보장 | OK (검증 후 수정) |
| 9 | Discovery API persistence → `discovery_sessions` 테이블 + sessionId 관리 | OK (검증 후 추가) |
| 10 | CATEGORIES 배열이 MDStrategyPanel과 동일 | OK (검증 후 수정) |

## 검증에서 발견 → 수정된 항목

1. **Gemini 외부 재시도 제거**: `callGemini()`이 이미 2모델×3회 retry + exponential backoff를 내장. 외부 재시도 시 `maxDuration=120s`를 초과할 위험. 대신 sanity-pass의 URL 정규화로 탈락률을 줄이는 접근으로 변경.
2. **`cappedPool` mutation 순서 보장**: 폴백 로직의 `cappedPool` 재할당이 `poolText` 빌드(line 619) 보다 반드시 앞에 오도록 코드 순서와 주석을 명시.
3. **Discovery API persistence 추가**: `discovery_sessions` 테이블 생성 + `sessionId` 기반 이력 관리. 페이지 새로고침 후 히스토리 유지, `excludeUrls`/`excludeNames` dedup 동작 보장.
4. **CATEGORIES 일관성**: MDStrategyPanel의 카테고리 (`'指定なし', '美容・スキンケア', ...`)와 동일하게 통일.
