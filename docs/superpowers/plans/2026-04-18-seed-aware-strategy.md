# Seed-Aware Strategy Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 発掘된 신상품의 B+C 패키지 상세를 拡大戦略 (6 skills) + ライブコマース (6 skills) Gemini 프롬프트에 주입해, 기존의 카테고리 평균 기반 전략이 아닌 신상품 실제 데이터 기반 맞춤 전략을 생성한다.

**Architecture:** 신규 `lib/strategy/seed-context.ts` 모듈이 SeedContext 타입 / DB loader / prompt formatter 를 제공. 두 워크플로(MD, LC) 가 workflow input에 `seedProductId` 옵션 수용 → context에 `seedProduct` 필드 주입 → 각 skill의 buildPrompt 함수가 `formatSeedPromptSection` 결과를 프롬프트에 append. 프론트엔드는 `SeedEnrichGate` 컴포넌트로 C 패키지 없을 때 사용자에게 자동 enrichment 옵션 팝업 표시.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (discovered_products.c_package jsonb), Google Gemini 3-Flash, next-intl, lucide-react.

**Spec reference:** `docs/superpowers/specs/2026-04-18-seed-aware-strategy-design.md`

**Phase 1-4.5 완료 상태:** 발굴 + context split + enrichment + 피드백 + 메뉴 재그룹핑. 이 phase는 같은 브랜치 `feature/product-discovery-phase1` 위에 누적.

**Out of scope:** DB 스키마 변경, seed 없는 기존 전략 플로우 수정, 전략 결과의 라이브 재계산.

---

## File Structure

**Create:**
```
lib/strategy/seed-context.ts           -- SeedContext 타입 + loadSeedContext + formatSeedPromptSection
components/discovery/SeedEnrichGate.tsx -- C 패키지 체크 + enrichment 자동 실행 팝업
```

**Modify:**
```
lib/md-strategy.ts                                -- StrategyContext + 6 buildPrompt*
lib/live-commerce-strategy.ts                     -- LCContext + 6 buildPrompt*
lib/workflows/md-strategy.workflow.ts             -- input 확장 + seedProduct 로드
lib/workflows/live-commerce.workflow.ts           -- 동일
app/api/analytics/expansion/route.ts              -- body.seedProductId 수용
app/api/analytics/live-commerce/route.ts          -- 동일
components/discovery/IntegrationActions.tsx       -- seedId param + Gate 래핑
components/analytics/MDStrategyPanel.tsx          -- seedId 읽어 body 포함
components/analytics/LiveCommercePanel.tsx        -- 동일
messages/ja.json, messages/en.json                -- seedGate* 키
```

---

## Task 1: `lib/strategy/seed-context.ts` — 공통 모듈

**Files:**
- Create: `lib/strategy/seed-context.ts`

- [ ] **Step 1: 파일 생성**

Write to `lib/strategy/seed-context.ts`:

```typescript
/**
 * Seed product context — loads a discovered product's B+C package and
 * formats it for Gemini prompt injection.
 * Ref: spec §3.
 */

import { getServiceClient } from "@/lib/supabase";

export interface SeedContext {
	id: string;
	name: string;
	priceJpy: number | null;
	category: string | null;
	reviewCount: number | null;
	reviewAvg: number | null;
	sellerName: string | null;
	productUrl: string;
	tvFitScore: number;
	tvFitReason: string | null;
	context: "home_shopping" | "live_commerce";
	broadcastTag: "broadcast_confirmed" | "broadcast_likely" | "unknown" | null;

	enriched?: {
		manufacturer: {
			name: string | null;
			official_site: string | null;
			address: string | null;
			contact_hints: string[];
			confidence: "high" | "medium" | "low";
		};
		wholesale: {
			estimated_cost_jpy: number | null;
			estimated_margin_rate: number | null;
			method: string;
			confidence: "high" | "medium" | "low";
		};
		moqHint: string | null;
		tvScriptDraft: string;
		snsTrend: { signal_strength: string; sources: string[] };
	};
}

/**
 * Load a seed product from discovered_products. Parses c_package if
 * enrichment is completed.
 */
export async function loadSeedContext(
	seedProductId: string,
): Promise<SeedContext | null> {
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("discovered_products")
		.select(
			"id, name, price_jpy, category, review_count, review_avg, seller_name, product_url, tv_fit_score, tv_fit_reason, context, broadcast_tag, c_package, enrichment_status",
		)
		.eq("id", seedProductId)
		.maybeSingle();

	if (error || !data) {
		console.warn(
			`[seed-context] load failed for ${seedProductId}:`,
			error?.message ?? "not found",
		);
		return null;
	}

	const row = data as Record<string, unknown>;
	const base: SeedContext = {
		id: String(row.id),
		name: String(row.name),
		priceJpy: row.price_jpy as number | null,
		category: row.category as string | null,
		reviewCount: row.review_count as number | null,
		reviewAvg: row.review_avg as number | null,
		sellerName: row.seller_name as string | null,
		productUrl: String(row.product_url),
		tvFitScore: Number(row.tv_fit_score ?? 0),
		tvFitReason: row.tv_fit_reason as string | null,
		context: row.context as SeedContext["context"],
		broadcastTag: row.broadcast_tag as SeedContext["broadcastTag"],
	};

	if (row.enrichment_status === "completed" && row.c_package) {
		try {
			const pkg = row.c_package as Record<string, unknown>;
			base.enriched = {
				manufacturer: pkg.manufacturer as SeedContext["enriched"]["manufacturer"],
				wholesale:
					pkg.wholesale_estimate as SeedContext["enriched"]["wholesale"],
				moqHint: (pkg.moq_hint as string | null) ?? null,
				tvScriptDraft: String(pkg.tv_script_draft ?? ""),
				snsTrend: pkg.sns_trend as SeedContext["enriched"]["snsTrend"],
			};
		} catch (err) {
			console.warn(
				`[seed-context] c_package parse failed for ${seedProductId}:`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	return base;
}

/**
 * Format a SeedContext into Japanese markdown for Gemini prompt injection.
 * If passed null, returns empty string.
 */
export function formatSeedPromptSection(seed: SeedContext | null): string {
	if (!seed) return "";

	const contextLabel =
		seed.context === "home_shopping" ? "ホームショッピング" : "ライブコマース";
	const broadcastLabel =
		seed.broadcastTag === "broadcast_confirmed"
			? "放送確認済み"
			: seed.broadcastTag === "broadcast_likely"
			? "放送の可能性あり"
			: "情報なし";

	const basics = [
		`- 商品名: ${seed.name}`,
		`- 価格: ${seed.priceJpy ? `¥${seed.priceJpy.toLocaleString()}` : "不明"}`,
		`- Rakuten評価: ${seed.reviewAvg ? `★${seed.reviewAvg} (${seed.reviewCount ?? 0}件)` : "レビューなし"}`,
		`- 販売者: ${seed.sellerName ?? "不明"}`,
		`- カテゴリ: ${seed.category ?? "未分類"}`,
		`- TVフィットスコア: ${seed.tvFitScore}/100`,
		`- TVフィット理由: ${seed.tvFitReason ?? "なし"}`,
		`- 競合放送状況: ${broadcastLabel}`,
		`- 対象チャネル: ${contextLabel}`,
		`- 商品URL: ${seed.productUrl}`,
	].join("\n");

	let enrichedSection = "\n【深掘り情報】\n- 未実行 — 製造元・卸値・TVスクリプト等のデータなし";
	if (seed.enriched) {
		const m = seed.enriched.manufacturer;
		const w = seed.enriched.wholesale;
		const s = seed.enriched.snsTrend;
		const mfg = m.name ? `${m.name} (信頼度:${m.confidence})` : "不明";
		const ws =
			w.estimated_cost_jpy !== null
				? `¥${w.estimated_cost_jpy.toLocaleString()} (マージン${Math.round((w.estimated_margin_rate ?? 0) * 100)}%, 方法:${w.method}, 信頼度:${w.confidence})`
				: "推定不可";
		const script = seed.enriched.tvScriptDraft
			? seed.enriched.tvScriptDraft.slice(0, 400)
			: "なし";
		enrichedSection = `\n【深掘り情報】\n- 製造元: ${mfg}\n- 公式サイト: ${m.official_site ?? "なし"}\n- 住所: ${m.address ?? "不明"}\n- 連絡先ヒント: ${m.contact_hints.length > 0 ? m.contact_hints.join(", ") : "なし"}\n- 卸値推定: ${ws}\n- MOQ情報: ${seed.enriched.moqHint ?? "なし"}\n- 既存TVスクリプト案:\n  ${script}\n- SNSトレンド: ${s.signal_strength}${s.sources.length > 0 ? ` (${s.sources.join(", ")})` : ""}`;
	}

	return `\n【新商品候補データ — 分析対象】\n${basics}\n${enrichedSection}\n\n【分析ガイダンス】\n各スキルは上記の「新商品候補データ」を中心に具体的な戦略を生成してください。\nproduct_summaries (既存MediaWorks実績) は「過去のカテゴリ成功パターン」の参考材料として使用してください。\n`;
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/strategy/seed-context.ts
git commit -m "feat(strategy): add SeedContext loader + prompt formatter"
```

---

## Task 2: `StrategyContext` + `LCContext` 확장

**Files:**
- Modify: `lib/md-strategy.ts`
- Modify: `lib/live-commerce-strategy.ts`

- [ ] **Step 1: StrategyContext에 seedProduct 필드 추가**

Open `lib/md-strategy.ts`. Find `export interface StrategyContext` (around line 375). Add import at top of file (after existing imports):

```typescript
import type { SeedContext } from "@/lib/strategy/seed-context";
```

Find the interface and add `seedProduct?: SeedContext;` field at the end (after `recommendedProducts?` block). Search for the closing brace `}` of StrategyContext:

```typescript
export interface StrategyContext {
	annualMetrics: { ... };
	categoryBreakdown: Array<{ ... }>;
	products: EnrichedProduct[];
	weeklyTrends: Array<{ ... }>;
	userGoal?: string;
	recommendedProducts?: Array<{ ... }>;
	parsedGoal?: ParsedGoal;
	// ... existing fields ...
	seedProduct?: SeedContext;  // NEW
}
```

Use Edit with sufficient surrounding context to locate the correct closing brace.

- [ ] **Step 2: LCContext에 seedProduct 필드 추가**

Open `lib/live-commerce-strategy.ts`. Add import at top:

```typescript
import type { SeedContext } from "@/lib/strategy/seed-context";
```

Find `export interface LCContext` (around line 336). Replace with:

```typescript
export interface LCContext {
	userGoal?: string;
	targetPlatforms?: string[];
	parsedGoal?: ParsedGoal;
	searchSources: SearchSource[];
	searchSummary: string;
	products: LCProduct[];
	recommendedProducts?: DiscoveredProduct[];
	topCategoryNames?: string[];
	avgMarginRate?: number;
	seedProduct?: SeedContext;
}
```

- [ ] **Step 3: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/md-strategy.ts lib/live-commerce-strategy.ts
git commit -m "feat(strategy): add seedProduct field to StrategyContext + LCContext"
```

---

## Task 3: MD 6 skills 프롬프트에 seed section 주입

**Files:**
- Modify: `lib/md-strategy.ts`

- [ ] **Step 1: 프롬프트 빌드 함수들에서 seed section 추가**

`lib/md-strategy.ts` 에는 `buildProductSelectionPrompt`, `buildChannelStrategyPrompt`, `buildPricingMarginPrompt`, `buildMarketingExecutionPrompt`, `buildFinancialProjectionPrompt`, `buildRiskContingencyPrompt` 6개 함수가 있다.

각 함수 구조는 대략:
```typescript
function buildXxxPrompt(ctx: StrategyContext, priorOutputs: Record<string, unknown>): string {
	return `기본 프롬프트...`;
}
```

Add import at top (after existing imports):
```typescript
import { formatSeedPromptSection } from "@/lib/strategy/seed-context";
```

For EACH of the 6 buildPrompt functions, modify the returned prompt to include seed section **before the JSON output instruction**. 

Example pattern — find each function and modify the return statement:

```typescript
function buildProductSelectionPrompt(ctx: StrategyContext, priorOutputs: Record<string, unknown>): string {
	const seedSection = formatSeedPromptSection(ctx.seedProduct ?? null);
	return `既存プロンプト本文...${seedSection}

【出力 — JSONのみ】
...
`;
}
```

The exact insertion point for each function: between the main analytical instructions and the "【出力 — JSONのみ】" (or equivalent) section. Use Grep to find the JSON output marker in each buildPrompt function:

```bash
grep -n "【出力|【Output|output:" lib/md-strategy.ts
```

For each buildPrompt function, insert `${seedSection}\n` immediately before the JSON output block.

Required edits for all 6 functions:
1. `buildProductSelectionPrompt`
2. `buildChannelStrategyPrompt`
3. `buildPricingMarginPrompt`
4. `buildMarketingExecutionPrompt`
5. `buildFinancialProjectionPrompt`
6. `buildRiskContingencyPrompt`

Note: If `runGoalAnalysis` is a separate simpler function that takes only userGoal string, no seed injection needed there (it analyzes user's intent, not products).

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/md-strategy.ts
git commit -m "feat(strategy): inject seed section into 6 MD skill prompts"
```

---

## Task 4: LC 6 skills 프롬프트에 seed section 주입

**Files:**
- Modify: `lib/live-commerce-strategy.ts`

- [ ] **Step 1: 프롬프트 빌드 함수들에서 seed section 추가**

Open `lib/live-commerce-strategy.ts`. Add import at top:
```typescript
import { formatSeedPromptSection } from "@/lib/strategy/seed-context";
```

Identify buildPrompt functions for 6 LC skills:
- `buildGoalAnalysisPrompt` (likely uses userGoal only — skip seed)
- `buildMarketResearchPrompt`
- `buildPlatformAnalysisPrompt`
- `buildContentStrategyPrompt`
- `buildExecutionPlanPrompt`
- `buildRiskAnalysisPrompt`

```bash
grep -n "function build[A-Z].*Prompt" lib/live-commerce-strategy.ts
```

For each non-goal-analysis buildPrompt function, insert `const seedSection = formatSeedPromptSection(ctx.seedProduct ?? null);` at the top of the function body, and embed `${seedSection}` into the template literal before the JSON output instruction.

Example:
```typescript
function buildMarketResearchPrompt(ctx: LCContext): string {
	const seedSection = formatSeedPromptSection(ctx.seedProduct ?? null);
	return `既存プロンプト本文...${seedSection}

【出力 — JSONのみ】
...
`;
}
```

Apply to 5 functions (skip `buildGoalAnalysisPrompt` if it doesn't take LCContext).

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/live-commerce-strategy.ts
git commit -m "feat(strategy): inject seed section into 5 LC skill prompts"
```

---

## Task 5: MD workflow — input 확장 + seed 로드

**Files:**
- Modify: `lib/workflows/md-strategy.workflow.ts`

- [ ] **Step 1: workflow input 타입 + seed 로드 로직**

Open `lib/workflows/md-strategy.workflow.ts`. Find `interface MDWorkflowInput` or type definition near top (line ~15). Add import:

```typescript
import { loadSeedContext } from "@/lib/strategy/seed-context";
```

Extend input type:
```typescript
export interface MDWorkflowInput {
	userGoal?: string;
	category?: string;
	targetMarket?: string;
	priceRange?: string;
	focus?: string;
	seedProductId?: string;  // NEW
}
```

Find `fetchContextStep` function (around line 28). Modify to load seed after fetching base context:

```typescript
async function fetchContextStep(input: MDWorkflowInput): Promise<StrategyContext> {
	const recommend = { ... };
	const ctx = await fetchStrategyContext(input.userGoal || undefined, recommend);
	
	// NEW: load seed product if seedProductId provided
	if (input.seedProductId) {
		const seed = await loadSeedContext(input.seedProductId);
		if (seed) {
			(ctx as StrategyContext).seedProduct = seed;
		}
	}
	
	return ctx;
}
```

(Preserve existing logic; only add the seed loading block.)

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/workflows/md-strategy.workflow.ts
git commit -m "feat(workflow): md-strategy accepts seedProductId and loads seed into context"
```

---

## Task 6: LC workflow — input 확장 + seed 로드

**Files:**
- Modify: `lib/workflows/live-commerce.workflow.ts`

- [ ] **Step 1: workflow input + seed 로드**

Open `lib/workflows/live-commerce.workflow.ts`. Find the input interface near top. Add:

```typescript
import { loadSeedContext } from "@/lib/strategy/seed-context";
```

Extend input type (find existing interface with `userGoal`, `targetPlatforms` fields):
```typescript
export interface LCWorkflowInput {
	userGoal?: string;
	targetPlatforms?: string[];
	seedProductId?: string;  // NEW
}
```

Find the context-fetching step (similar to MD workflow's `fetchContextStep`). Modify to load seed:

```typescript
// After existing fetchLCContext call:
if (input.seedProductId) {
	const seed = await loadSeedContext(input.seedProductId);
	if (seed) {
		ctx.seedProduct = seed;
	}
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/workflows/live-commerce.workflow.ts
git commit -m "feat(workflow): live-commerce accepts seedProductId and loads seed into context"
```

---

## Task 7: API routes — seedProductId 수용

**Files:**
- Modify: `app/api/analytics/expansion/route.ts`
- Modify: `app/api/analytics/live-commerce/route.ts`

- [ ] **Step 1: expansion route 수정**

Open `app/api/analytics/expansion/route.ts`. Find the POST handler's body extraction. It likely does:

```typescript
const body = await request.json();
const input = {
	userGoal: typeof body.userGoal === "string" ? body.userGoal : "",
	category: ...,
	// ...
};
```

Add `seedProductId` extraction:
```typescript
const input = {
	userGoal: typeof body.userGoal === "string" ? body.userGoal : "",
	category: typeof body.category === "string" ? body.category : undefined,
	targetMarket: typeof body.targetMarket === "string" ? body.targetMarket : undefined,
	priceRange: typeof body.priceRange === "string" ? body.priceRange : undefined,
	focus: typeof body.focus === "string" ? body.focus : undefined,
	seedProductId: typeof body.seedProductId === "string" ? body.seedProductId : undefined,  // NEW
};
```

(Keep existing fields, only add seedProductId. Exact shape may differ — adapt to actual file.)

- [ ] **Step 2: live-commerce route 수정**

Open `app/api/analytics/live-commerce/route.ts`. Find POST handler's input construction:

```typescript
const input = {
	userGoal: typeof body.userGoal === "string" ? body.userGoal : "",
	targetPlatforms: Array.isArray(body.targetPlatforms) ? (body.targetPlatforms as string[]) : undefined,
};
```

Add seedProductId:
```typescript
const input = {
	userGoal: typeof body.userGoal === "string" ? body.userGoal : "",
	targetPlatforms: Array.isArray(body.targetPlatforms) ? (body.targetPlatforms as string[]) : undefined,
	seedProductId: typeof body.seedProductId === "string" ? body.seedProductId : undefined,  // NEW
};
```

- [ ] **Step 3: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add app/api/analytics/expansion/route.ts app/api/analytics/live-commerce/route.ts
git commit -m "feat(api): accept seedProductId in strategy generation endpoints"
```

---

## Task 8: MDStrategyPanel + LiveCommercePanel — seedId 읽어 body 포함

**Files:**
- Modify: `components/analytics/MDStrategyPanel.tsx`
- Modify: `components/analytics/LiveCommercePanel.tsx`

- [ ] **Step 1: MDStrategyPanel 수정**

Open `components/analytics/MDStrategyPanel.tsx`. `useSearchParams` 와 `seedId` 읽기 로직은 이미 있음 (Phase 3.5 에서 seed, category, price 추가됨). `seedId` 추가:

Find the existing searchParams reads (near line 393-400):
```typescript
const searchParams = useSearchParams();
const seedName = searchParams?.get("seed") ?? null;
const seedCategory = searchParams?.get("category") ?? null;
const seedPrice = searchParams?.get("price") ?? null;
```

Add:
```typescript
const seedProductId = searchParams?.get("seedId") ?? null;
```

Find the fetch body construction for POST to /api/analytics/expansion or /api/analytics/md-strategy (search for `'/api/analytics/expansion'` or similar POST call). Add `seedProductId` to body:

```typescript
body: JSON.stringify({
	userGoal,
	category: category !== '指定なし' ? category : undefined,
	targetMarket,
	priceRange,
	// existing fields...
	seedProductId: seedProductId ?? undefined,  // NEW
}),
```

(Exact fetch call may differ — search for `JSON.stringify` in the file.)

- [ ] **Step 2: LiveCommercePanel 수정**

Open `components/analytics/LiveCommercePanel.tsx`. Similar pattern. Find existing searchParams near LCListView (lines 434-443 area):

```typescript
const seedName = searchParams?.get('seed') ?? null;
const seedCategory = searchParams?.get('category') ?? null;
const seedUrl = searchParams?.get('sourceUrl') ?? null;
const seedPrice = searchParams?.get('price') ?? null;
```

Add:
```typescript
const seedProductId = searchParams?.get('seedId') ?? null;
```

Find the POST to `/api/analytics/live-commerce` in `handleGenerate`:
```typescript
body: JSON.stringify({
	userGoal: userGoal || undefined,
	targetPlatforms: selectedPlatforms.length > 0 ? selectedPlatforms : undefined,
}),
```

Extend:
```typescript
body: JSON.stringify({
	userGoal: userGoal || undefined,
	targetPlatforms: selectedPlatforms.length > 0 ? selectedPlatforms : undefined,
	seedProductId: seedProductId ?? undefined,  // NEW
}),
```

- [ ] **Step 3: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add components/analytics/MDStrategyPanel.tsx components/analytics/LiveCommercePanel.tsx
git commit -m "feat(analytics): panels read seedId URL param and send in body"
```

---

## Task 9: i18n keys 추가

**Files:**
- Modify: `messages/ja.json`
- Modify: `messages/en.json`

- [ ] **Step 1: ja.json discovery 블록에 추가**

```json
"seedGateTitle": "深掘り情報なし",
"seedGateBody": "この商品はまだ詳細分析されていません。製造元・卸値・TVスクリプトなどが欠落します。戦略生成前に自動で深掘りしますか？(予想時間: 約30秒)",
"seedGateSkip": "スキップ(簡易戦略)",
"seedGateEnrich": "深掘りして戦略作成",
"seedGateRunning": "深掘り中...",
"seedGateFailed": "深掘り失敗. 簡易戦略で続行しますか？",
"seedGateContinueAnyway": "簡易戦略で続行"
```

- [ ] **Step 2: en.json 동일 키**

```json
"seedGateTitle": "No Deep Dive Data",
"seedGateBody": "This product hasn't been deep-analyzed yet. Manufacturer/wholesale/TV-script info will be unavailable. Run deep dive before generating strategy? (~30 seconds)",
"seedGateSkip": "Skip (simple strategy)",
"seedGateEnrich": "Deep Dive & Generate",
"seedGateRunning": "Deep diving...",
"seedGateFailed": "Deep dive failed. Continue with simple strategy?",
"seedGateContinueAnyway": "Continue with simple strategy"
```

- [ ] **Step 3: JSON 유효성 + 커밋**

```bash
node -e "JSON.parse(require('fs').readFileSync('messages/ja.json','utf8'));JSON.parse(require('fs').readFileSync('messages/en.json','utf8'));console.log('valid');"
git add messages/ja.json messages/en.json
git commit -m "feat(i18n): add seedGate keys for strategy integration popup"
```

---

## Task 10: SeedEnrichGate 컴포넌트

**Files:**
- Create: `components/discovery/SeedEnrichGate.tsx`

- [ ] **Step 1: 파일 생성**

Write to `components/discovery/SeedEnrichGate.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2, Sparkles, X, AlertTriangle } from "lucide-react";

type EnrichmentStatus = "idle" | "queued" | "running" | "completed" | "failed";

interface Props {
	productId: string;
	enrichmentStatus: EnrichmentStatus;
	hasCPackage: boolean;
	targetHref: string;
	children: React.ReactNode;
}

export function SeedEnrichGate({
	productId,
	enrichmentStatus,
	hasCPackage,
	targetHref,
	children,
}: Props) {
	const t = useTranslations("discovery");
	const router = useRouter();
	const [mounted, setMounted] = useState(false);
	const [gateOpen, setGateOpen] = useState(false);
	const [running, setRunning] = useState(false);
	const [failed, setFailed] = useState(false);

	useEffect(() => setMounted(true), []);

	const needGate = !hasCPackage && enrichmentStatus !== "completed";

	function handleClick(e: React.MouseEvent) {
		if (!needGate) {
			// Proceed as normal link
			return;
		}
		e.preventDefault();
		setGateOpen(true);
	}

	function skipAndNavigate() {
		setGateOpen(false);
		router.push(targetHref);
	}

	async function enrichAndNavigate() {
		setRunning(true);
		setFailed(false);
		try {
			// Start enrichment
			await fetch(`/api/discovery/enrich/${productId}`, { method: "POST" });
			// Poll until completed or failed (max 90s)
			const start = Date.now();
			const poll = async (): Promise<"completed" | "failed" | "timeout"> => {
				while (Date.now() - start < 90_000) {
					await new Promise((r) => setTimeout(r, 2000));
					const res = await fetch(`/api/discovery/enrich/${productId}`);
					if (!res.ok) continue;
					const data = await res.json();
					if (data.status === "completed") return "completed";
					if (data.status === "failed") return "failed";
				}
				return "timeout";
			};
			const result = await poll();
			if (result === "completed") {
				setGateOpen(false);
				router.push(targetHref);
			} else {
				setFailed(true);
				setRunning(false);
			}
		} catch (err) {
			console.error("[seed-gate] enrich error", err);
			setFailed(true);
			setRunning(false);
		}
	}

	const dialog = gateOpen && mounted
		? createPortal(
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
					onClick={() => !running && setGateOpen(false)}
				>
					<div
						className="bg-white rounded-lg shadow-lg p-5 w-full max-w-md mx-4"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="flex items-center justify-between mb-3">
							<h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
								<AlertTriangle size={14} className="text-amber-500" />
								{t("seedGateTitle")}
							</h3>
							{!running && (
								<button
									type="button"
									onClick={() => setGateOpen(false)}
									className="text-gray-400 hover:text-gray-600"
								>
									<X size={16} />
								</button>
							)}
						</div>

						<p className="text-xs text-gray-600 leading-relaxed mb-4">
							{failed ? t("seedGateFailed") : t("seedGateBody")}
						</p>

						{running ? (
							<div className="flex items-center justify-center gap-2 py-4 text-sm text-amber-700">
								<Loader2 size={16} className="animate-spin" />
								{t("seedGateRunning")}
							</div>
						) : failed ? (
							<div className="flex justify-end gap-2">
								<button
									type="button"
									onClick={() => setGateOpen(false)}
									className="px-4 py-1.5 text-xs text-gray-700 border border-gray-200 rounded hover:bg-gray-50"
								>
									{t("cancel")}
								</button>
								<button
									type="button"
									onClick={skipAndNavigate}
									className="px-4 py-1.5 text-xs bg-gray-500 text-white rounded hover:bg-gray-600"
								>
									{t("seedGateContinueAnyway")}
								</button>
							</div>
						) : (
							<div className="flex justify-end gap-2">
								<button
									type="button"
									onClick={skipAndNavigate}
									className="px-4 py-1.5 text-xs text-gray-700 border border-gray-200 rounded hover:bg-gray-50"
								>
									{t("seedGateSkip")}
								</button>
								<button
									type="button"
									onClick={enrichAndNavigate}
									className="px-4 py-1.5 text-xs bg-amber-500 text-white rounded hover:bg-amber-600 inline-flex items-center gap-1"
								>
									<Sparkles size={12} />
									{t("seedGateEnrich")}
								</button>
							</div>
						)}
					</div>
				</div>,
				document.body,
			)
		: null;

	return (
		<>
			<span onClick={handleClick}>{children}</span>
			{dialog}
		</>
	);
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add components/discovery/SeedEnrichGate.tsx
git commit -m "feat(discovery): add SeedEnrichGate component with portal modal"
```

---

## Task 11: IntegrationActions — seedId param + Gate 래핑

**Files:**
- Modify: `components/discovery/IntegrationActions.tsx`

- [ ] **Step 1: seedId URL 파라미터 추가 + Gate로 래핑**

Open `components/discovery/IntegrationActions.tsx`. Current signature:
```typescript
export function IntegrationActions({
	context,
	productName,
	category,
	productUrl,
	priceJpy,
}: {...})
```

Extend props to include productId + enrichment state:
```typescript
interface Props {
	productId: string;
	context: "home_shopping" | "live_commerce";
	productName: string;
	category: string | null;
	productUrl: string;
	priceJpy: number | null;
	enrichmentStatus: "idle" | "queued" | "running" | "completed" | "failed";
	hasCPackage: boolean;
}
```

Update the full file content:

```tsx
"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { TrendingUp, Radio } from "lucide-react";
import { SeedEnrichGate } from "./SeedEnrichGate";

interface Props {
	productId: string;
	context: "home_shopping" | "live_commerce";
	productName: string;
	category: string | null;
	productUrl: string;
	priceJpy: number | null;
	enrichmentStatus: "idle" | "queued" | "running" | "completed" | "failed";
	hasCPackage: boolean;
}

export function IntegrationActions({
	productId,
	context,
	productName,
	category,
	productUrl,
	priceJpy,
	enrichmentStatus,
	hasCPackage,
}: Props) {
	const t = useTranslations("discovery");
	const { locale } = useParams<{ locale: string }>();

	const targetPath =
		context === "live_commerce"
			? `/${locale}/analytics/strategy/live`
			: `/${locale}/analytics/strategy/expansion`;

	const params = new URLSearchParams();
	params.set("seedId", productId);
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
		<SeedEnrichGate
			productId={productId}
			enrichmentStatus={enrichmentStatus}
			hasCPackage={hasCPackage}
			targetHref={href}
		>
			<Link
				href={href}
				className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-800 text-xs font-semibold rounded-lg transition-colors"
			>
				{icon}
				{label}
			</Link>
		</SeedEnrichGate>
	);
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add components/discovery/IntegrationActions.tsx
git commit -m "feat(discovery): IntegrationActions adds seedId + wraps with SeedEnrichGate"
```

---

## Task 12: ProductCard — IntegrationActions에 neue prop 전달

**Files:**
- Modify: `components/discovery/ProductCard.tsx`

- [ ] **Step 1: IntegrationActions 호출에 enrichmentStatus + hasCPackage + productId 전달**

Open `components/discovery/ProductCard.tsx`. Find the existing `<IntegrationActions>` JSX. Update props:

Existing:
```tsx
<IntegrationActions
	context={product.context ?? "home_shopping"}
	productName={product.name}
	category={product.category}
	productUrl={product.product_url}
	priceJpy={product.price_jpy}
/>
```

Replace with:
```tsx
<IntegrationActions
	productId={product.id}
	context={product.context ?? "home_shopping"}
	productName={product.name}
	category={product.category}
	productUrl={product.product_url}
	priceJpy={product.price_jpy}
	enrichmentStatus={status}
	hasCPackage={!!pkg}
/>
```

(`status` and `pkg` variables already exist in ProductCard scope from the enrichment state — set by useState hooks `setStatus` / `setPkg`.)

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add components/discovery/ProductCard.tsx
git commit -m "feat(discovery): ProductCard wires enrichment state to IntegrationActions gate"
```

---

## Task 13: End-to-end 검증

**Files:** (실행만)

- [ ] **Step 1: Dev 서버 재시작**

```bash
pkill -f "next" 2>/dev/null
sleep 2
rm -rf .next
npm run dev
```

(Port may differ — note the actual port from log.)

- [ ] **Step 2: Gate 팝업 테스트 (C 패키지 없음 케이스)**

1. 브라우저에서 `http://localhost:<port>/ja/analytics/discovery/home` 접속
2. 깊이 파기 안 한 임의 카드에서 "拡大戦略を作成" 클릭
3. **예상**: 모달 팝업 표시 ("深掘り情報なし" 제목 + 설명 + 2개 버튼)
4. "スキップ(簡易戦略)" 클릭
5. **예상**: `/ja/analytics/strategy/expansion?seedId=<UUID>&seed=<name>&...` 으로 이동
6. userGoal 필드에 자동 pre-fill 텍스트 확인

- [ ] **Step 3: Gate 통과 테스트 (C 패키지 있음)**

1. 뒤로가기
2. 이전에 "깊이 파기" 완료한 카드 선택 (C 패키지 drawer 표시됨)
3. "拡大戦略を作成" 클릭
4. **예상**: 팝업 없이 바로 `/analytics/strategy/expansion?seedId=...` 이동

- [ ] **Step 4: 戦略 생성 테스트 (seed 주입 확인)**

1. MDStrategyPanel에서 pre-filled userGoal 확인 후 "戦略生成" 클릭
2. Gemini가 전략 생성 중 (약 30-60초)
3. **예상 (seed 있음)**: 결과의 pricing_margin 섹션에 실제 가격 반영 ("¥38,000" 등), product_selection의 제조사 정보 반영
4. 뒤로가기 → seedId 없이 직접 `/ja/analytics/strategy/expansion` 접속 → 戦略生成
5. **예상 (seed 없음)**: 기존 방식대로 일반 전략 생성 (fail-open 확인)

- [ ] **Step 5: 라이브 context 테스트**

1. `/ja/analytics/discovery/live` 접속
2. 임의 카드 "ライブ戦略を作成" 클릭
3. Gate 팝업 → 깊이 파기 실행 또는 스킵
4. `/ja/analytics/strategy/live?seedId=...` 이동 확인
5. "戦略生成" → 결과에 seed 데이터 반영 확인

- [ ] **Step 6: Enrichment 자동 실행 경로 테스트**

1. 발굴 페이지에서 깊이 파기 안 한 카드 "拡大戦略을作成" 클릭
2. 팝업에서 "深掘りして戦略作成" 클릭
3. **예상**: 스피너 + "深掘り中..." 표시 (~30초)
4. 완료되면 자동 페이지 이동
5. seed 풍부 버전 전략 생성 가능

- [ ] **Step 7: DB 검증 (선택)**

```sql
-- 최근 1시간 생성된 MD 전략이 seedProductId 기반인지 추정
-- (md_strategies.user_goal 텍스트에 상품명 포함 확인)
SELECT id, user_goal, created_at
FROM md_strategies
WHERE created_at > now() - interval '1 hour'
ORDER BY created_at DESC
LIMIT 5;
```

seedProductId 자체는 DB에 저장되지 않지만 userGoal 텍스트로 추적 가능.

- [ ] **Step 8: 완료 선언**

```bash
git log --oneline main..HEAD | head -15
```

---

## Self-Review

**Spec coverage:**
- §1 목적 + 성공 기준 → 전체 흐름 (Tasks 1-12)
- §3.1 SeedContext 타입 → Task 1 ✓
- §3.2 loadSeedContext → Task 1 ✓
- §3.3 formatSeedPromptSection → Task 1 ✓
- §4 API body.seedProductId → Task 7 ✓
- §5.1-5.2 MD workflow + context → Tasks 2, 5 ✓
- §5.3 LC workflow + context → Tasks 2, 6 ✓
- §5.2 MD 6 skills prompts → Task 3 ✓
- §5.3 LC 6 skills prompts → Task 4 ✓
- §6.1 SeedEnrichGate → Task 10 ✓
- §6.2 IntegrationActions → Task 11 ✓
- §6.3 MDStrategyPanel + LiveCommercePanel seedId → Task 8 ✓
- §6.4 i18n → Task 9 ✓
- §7 Fail-open → loadSeedContext 실패 시 null 반환 (Task 1) + workflow가 seed 없이 진행 (Task 5/6) ✓

**Placeholder scan:** 모든 task 실제 코드 포함. 없음.

**Type consistency:**
- `SeedContext` 타입이 Task 1에서 정의, Task 2에서 StrategyContext/LCContext에 사용, Task 10/11에서 hasCPackage/enrichmentStatus 파라미터로 간접 반영 ✓
- `formatSeedPromptSection(ctx.seedProduct ?? null)` — null 허용, 빈 문자열 반환 → 기존 프롬프트와 양립 가능 ✓
- `enrichmentStatus` 타입 `idle | queued | running | completed | failed` — Task 10, 11, 12 일관 사용 ✓
- `loadSeedContext` 반환 타입 `SeedContext | null` — Task 5, 6 workflow에서 null 체크 ✓

**Gaps:**
- Task 12에서 ProductCard가 IntegrationActions에 productId를 전달해야 하는데, 기존 코드에서 productId는 이미 있음 (product.id) — 정상.
- MD workflow의 `fetchContextStep` 이름은 추정. 실제 함수명이 다를 수 있음 — Task 5에서 Grep으로 확인 필요.
