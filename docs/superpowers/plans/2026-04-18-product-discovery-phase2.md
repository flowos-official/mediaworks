# Product Discovery Phase 2 — Save/Query/UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 pipeline의 결과를 DB에 저장하고, cron 자동 실행 + 사용자 조회 UI를 완성한다. Phase 2 종료 시점에 사용자는 매일 아침 `/discovery` 페이지에서 자동 발굴된 30개 제품을 열람할 수 있다.

**Architecture:** Stage 1 파이프라인(Task 1-3 Phase 1 완성본)을 cron이 orchestrate → broadcast tag 추가 → discovery_runs + discovered_products에 저장. 별도 API 3개가 UI에 데이터 공급. 피드백 버튼과 enrichment는 Phase 3/4에서 추가.

**Tech Stack:** Next.js 15 App Router, TypeScript, Supabase, next-intl, shadcn/ui, Tailwind CSS 4.

**Spec reference:** `docs/superpowers/specs/2026-04-18-product-discovery-redesign-design.md` §4.2 단계 6-8, §5 API, §9 UI.

**Phase 1 완료 상태:** `lib/discovery/{types,exclusion,plan,pool,curate}.ts` 완성, DB 5테이블 마이그레이션 적용됨, dry-run으로 end-to-end 파이프라인 검증됨 (pool 225 → candidates 30, avg score 94.3).

**Out of scope for Phase 2:**
- 피드백 버튼 (4버튼 + 거절 모달) → Phase 4
- Enrichment agent (C package) → Phase 3
- 학습 크론 (daily-learning, weekly-insights) → Phase 4/5
- Insights 대시보드 → Phase 5

---

## File Structure for Phase 2

**Create:**
```
lib/discovery/
  save.ts              -- discovery_runs + discovered_products 저장/업데이트
  broadcast.ts         -- 경쟁사 방송 체크 (Brave per candidate + Gemini 배치 판정)
  orchestrator.ts      -- bounded agent: plan → pool → filter → curate → iterate → save

app/api/
  cron/daily-discovery/route.ts
  discovery/today/route.ts
  discovery/sessions/route.ts
  discovery/sessions/[id]/route.ts
  discovery/manual-trigger/route.ts

components/discovery/
  DiscoveryHeader.tsx       -- 날짜/상태/카운트 배너
  ProductCard.tsx           -- B 패키지 카드 (버튼 없음, Phase 4에서 추가)
  DiscoveryFilters.tsx      -- 정렬/필터 (track, 점수순)
  SessionSelector.tsx       -- 과거 세션 네비 (날짜 드롭다운)

app/[locale]/discovery/
  page.tsx                  -- 오늘의 발굴
  [sessionId]/page.tsx      -- 특정 세션

messages/en.json            -- discovery.* 키 추가
messages/ja.json            -- discovery.* 키 추가
```

**Modify:**
```
vercel.json             -- crons + functions 섹션 확장
```

---

## Task 1: `lib/discovery/save.ts` — 세션/상품 저장

**Files:**
- Create: `lib/discovery/save.ts`

- [ ] **Step 1: 파일 생성**

Write to `lib/discovery/save.ts`:

```typescript
/**
 * Persistence for discovery pipeline — writes to discovery_runs and
 * discovered_products. All DB writes gated through service role client.
 * Ref: spec §4.2 단계 1, 단계 8.
 */

import { getServiceClient } from "@/lib/supabase";
import { normalizeName } from "./exclusion";
import type {
	BroadcastTag,
	Candidate,
	CategoryPlan,
	SessionStatus,
} from "./types";

/**
 * Create a new discovery_runs row with status='running'.
 * Returns the inserted row id.
 */
export async function createSession(input: {
	targetCount: number;
	explorationRatio: number;
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

/**
 * Update session with plan after planning step.
 */
export async function attachPlanToSession(
	sessionId: string,
	plan: CategoryPlan,
): Promise<void> {
	const sb = getServiceClient();
	const { error } = await sb
		.from("discovery_runs")
		.update({ category_plan: plan })
		.eq("id", sessionId);
	if (error) {
		console.warn(`[save] attachPlanToSession failed: ${error.message}`);
	}
}

export interface SaveBatch {
	candidate: Candidate;
	broadcastTag: BroadcastTag;
	broadcastSources: Array<{ title: string; url: string }>;
}

/**
 * Bulk insert discovered_products for a session.
 * Skips rows that violate unique (session_id, product_url) — idempotent on retry.
 */
export async function saveDiscoveredProducts(
	sessionId: string,
	batch: SaveBatch[],
): Promise<number> {
	if (batch.length === 0) return 0;
	const sb = getServiceClient();

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
	}));

	const { data, error } = await sb
		.from("discovered_products")
		.upsert(rows, { onConflict: "session_id,product_url", ignoreDuplicates: true })
		.select("id");

	if (error) {
		throw new Error(
			`[save] saveDiscoveredProducts failed: ${error.message}`,
		);
	}
	return data?.length ?? 0;
}

/**
 * Finalize session with status, produced_count, iteration count.
 */
export async function finalizeSession(input: {
	sessionId: string;
	status: SessionStatus;
	producedCount: number;
	iterations: number;
	error?: string;
}): Promise<void> {
	const sb = getServiceClient();
	const { error } = await sb
		.from("discovery_runs")
		.update({
			status: input.status,
			produced_count: input.producedCount,
			iterations: input.iterations,
			completed_at: new Date().toISOString(),
			error: input.error ?? null,
		})
		.eq("id", input.sessionId);
	if (error) {
		console.error(
			`[save] finalizeSession failed (${input.sessionId}): ${error.message}`,
		);
	}
}
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: 커밋**

```bash
git add lib/discovery/save.ts
git commit -m "feat(discovery): add save.ts for session + product persistence"
```

---

## Task 2: `lib/discovery/broadcast.ts` — 경쟁사 방송 태깅

**Files:**
- Create: `lib/discovery/broadcast.ts`

- [ ] **Step 1: 파일 생성**

Write to `lib/discovery/broadcast.ts`:

```typescript
/**
 * Broadcast tagging — for each candidate, query Brave for competitor
 * TV-shopping broadcast evidence, then batch-classify via Gemini.
 * Ref: spec §4.2 단계 7.
 *
 * Output tags: broadcast_confirmed | broadcast_likely | unknown.
 * NEVER used as exclusion — only as UI metadata.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { braveSearchItems, type BraveWebResult } from "@/lib/brave";
import type { BroadcastTag, Candidate } from "./types";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = "gemini-3-flash-preview";

const COMPETITORS = "(QVCジャパン OR ジャパネット OR ショップチャンネル OR テレ東ポシュレ)";

export interface BroadcastResult {
	productUrl: string;
	tag: BroadcastTag;
	sources: Array<{ title: string; url: string }>;
}

/**
 * Query Brave for broadcast evidence per candidate (parallel).
 * Truncates product name to 40 chars for query length safety.
 */
async function fetchEvidenceForCandidates(
	candidates: Candidate[],
): Promise<Map<string, BraveWebResult[]>> {
	const results = new Map<string, BraveWebResult[]>();

	const batch = await Promise.allSettled(
		candidates.map(async (c) => {
			const query = `"${c.name.slice(0, 40)}" ${COMPETITORS} 放送`;
			const items = await braveSearchItems(query, 5);
			return { url: c.productUrl, items };
		}),
	);

	for (const r of batch) {
		if (r.status !== "fulfilled") continue;
		results.set(r.value.url, r.value.items);
	}
	return results;
}

/**
 * Batch-classify candidates using Gemini from their Brave evidence.
 * One Gemini call for all candidates to reduce latency.
 * On failure, tags all 'unknown' (fail-open).
 */
export async function tagBroadcastEvidence(
	candidates: Candidate[],
): Promise<BroadcastResult[]> {
	if (candidates.length === 0) return [];

	const evidenceMap = await fetchEvidenceForCandidates(candidates);

	const evidenceBlocks = candidates
		.map((c, i) => {
			const items = evidenceMap.get(c.productUrl) ?? [];
			const lines = items
				.slice(0, 3)
				.map(
					(it, j) =>
						`    (${j + 1}) ${it.title} | ${it.url}\n        ${it.description.slice(0, 140)}`,
				)
				.join("\n");
			return `[${i}] ${c.name.slice(0, 80)}\n${lines || "    (no search results)"}`;
		})
		.join("\n\n");

	const prompt = `日本のTV通販・ライブコマース企業の放送実績を判定します。
以下の各商品について、競合TV通販チャンネル（QVCジャパン、ジャパネット、ショップチャンネル、テレ東ポシュレなど）での放送歴があるか、検索結果から判定してください。

【判定基準】
- broadcast_confirmed: 放送された証拠が明確（チャンネル名+商品名+放送/販売キーワード）
- broadcast_likely: 間接的な兆候あり（通販実績のある類似商品、店舗ページで扱いなど）
- unknown: 検索結果から判断できない

【判定対象】
${evidenceBlocks}

【出力 — JSONのみ、前置き/後書きなし】
{
  "results": [
    {"index": 0, "tag": "unknown"},
    {"index": 1, "tag": "broadcast_confirmed"}
  ]
}`;

	try {
		const model = genAI.getGenerativeModel({ model: MODEL_ID });
		const res = await model.generateContent(prompt);
		const text = res.response.text();
		const match = text.match(/\{[\s\S]+\}/);
		if (!match) throw new Error("no JSON in broadcast tag response");
		const parsed = JSON.parse(match[0]) as {
			results?: Array<{ index: number; tag: BroadcastTag }>;
		};
		const tagMap = new Map<number, BroadcastTag>();
		for (const r of parsed.results ?? []) {
			tagMap.set(r.index, r.tag);
		}
		return candidates.map((c, i) => ({
			productUrl: c.productUrl,
			tag: tagMap.get(i) ?? "unknown",
			sources: (evidenceMap.get(c.productUrl) ?? []).slice(0, 3).map((e) => ({
				title: e.title,
				url: e.url,
			})),
		}));
	} catch (err) {
		console.warn(
			"[broadcast] Gemini classification failed, defaulting to unknown:",
			err instanceof Error ? err.message : String(err),
		);
		return candidates.map((c) => ({
			productUrl: c.productUrl,
			tag: "unknown" as BroadcastTag,
			sources: (evidenceMap.get(c.productUrl) ?? []).slice(0, 3).map((e) => ({
				title: e.title,
				url: e.url,
			})),
		}));
	}
}
```

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: 커밋**

```bash
git add lib/discovery/broadcast.ts
git commit -m "feat(discovery): add broadcast tagging via Brave + Gemini batch classify"
```

---

## Task 3: `lib/discovery/orchestrator.ts` — bounded agent 오케스트레이션

**Files:**
- Create: `lib/discovery/orchestrator.ts`

- [ ] **Step 1: 파일 생성**

Write to `lib/discovery/orchestrator.ts`:

```typescript
/**
 * Orchestrator — drives the Stage 1 pipeline end-to-end with bounded-agent
 * iteration: if curation yields < MIN_QUALITY candidates, re-asks Gemini for
 * additional keywords and re-curates (max MAX_ITERATIONS).
 * Ref: spec §4.2 단계 6.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { curatePool } from "./curate";
import { applyExclusions, loadExclusionContext } from "./exclusion";
import { buildCategoryPlan, loadRecentPlannedKeywords, loadTopCategories } from "./plan";
import { buildPool } from "./pool";
import type {
	Candidate,
	CategoryPlan,
	LearningState,
	PoolItem,
	Track,
} from "./types";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = "gemini-3-flash-preview";
const MAX_ITERATIONS = Number(process.env.DISCOVERY_MAX_ITERATIONS ?? 3);
const MIN_QUALITY_COUNT = 20; // threshold: need 20+ score>=60 to skip iteration
const QUALITY_SCORE_THRESHOLD = 60;

export interface OrchestrateResult {
	candidates: Candidate[];
	plan: CategoryPlan;
	poolSize: number;
	iterations: number;
}

/**
 * Ask Gemini for additional fallback keywords if quality is insufficient.
 */
async function suggestMoreKeywords(
	currentPlan: CategoryPlan,
	qualityCount: number,
): Promise<string[]> {
	const prompt = `日本のテレビ通販向け商品発掘。現在のキーワードプランで品質基準(score>=60)を満たす候補が${qualityCount}件しかありません（目標20件以上）。

追加で3個のキーワードを提案してください。
- 短い汎用語（2〜5語）
- 楽天市場で検索可能
- 既存キーワードと異なる角度

既存キーワード: ${[...currentPlan.tv_proven, ...currentPlan.exploration].join(", ")}

【出力 — JSONのみ】
{ "keywords": ["キーワード1", "キーワード2", "キーワード3"] }`;

	try {
		const model = genAI.getGenerativeModel({ model: MODEL_ID });
		const res = await model.generateContent(prompt);
		const text = res.response.text();
		const match = text.match(/\{[\s\S]+\}/);
		if (!match) return [];
		const parsed = JSON.parse(match[0]) as { keywords?: string[] };
		return (parsed.keywords ?? []).slice(0, 3);
	} catch (err) {
		console.warn(
			"[orchestrator] suggestMoreKeywords failed:",
			err instanceof Error ? err.message : String(err),
		);
		return [];
	}
}

/**
 * Fetch additional pool for extra keywords (tagged as tv_proven since origin is curation-driven).
 */
async function buildAdditionalPool(keywords: string[]): Promise<PoolItem[]> {
	if (keywords.length === 0) return [];
	const partialPlan: CategoryPlan = {
		tv_proven: keywords,
		exploration: [],
	};
	return buildPool(partialPlan);
}

/**
 * Merge a pool extension into the main pool, deduping by productUrl.
 */
function mergePools(base: PoolItem[], extension: PoolItem[]): PoolItem[] {
	const seen = new Set(base.map((p) => p.productUrl));
	const merged = [...base];
	for (const item of extension) {
		if (seen.has(item.productUrl)) continue;
		seen.add(item.productUrl);
		merged.push(item);
	}
	return merged;
}

/**
 * Run the full Stage 1 orchestration: plan → pool → filter → curate, with
 * bounded-agent iteration on insufficient quality.
 * Caller provides learning state (loaded upstream).
 * Does NOT save to DB — caller handles persistence.
 */
export async function runStage1(
	learning: LearningState,
	targetCount: number,
): Promise<OrchestrateResult> {
	// Step 1: plan
	const [topCategories, recentlyUsed] = await Promise.all([
		loadTopCategories(),
		loadRecentPlannedKeywords(),
	]);
	const plan = await buildCategoryPlan(learning, topCategories, recentlyUsed);

	// Step 2: initial pool + exclusion
	let pool = await buildPool(plan);
	const exclusionCtx = await loadExclusionContext(learning);
	let filtered = applyExclusions(pool, exclusionCtx);

	// Step 3: curate with bounded iteration
	let candidates = await curatePool(filtered, targetCount, learning);
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
		candidates = await curatePool(filtered, targetCount, learning);
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

- [ ] **Step 2: 타입 체크**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: 커밋**

```bash
git add lib/discovery/orchestrator.ts
git commit -m "feat(discovery): add orchestrator with bounded-agent iteration (max 3)"
```

---

## Task 4: `/api/cron/daily-discovery` + `vercel.json` 업데이트

**Files:**
- Create: `app/api/cron/daily-discovery/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: API 라우트 생성**

Write to `app/api/cron/daily-discovery/route.ts`:

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
	// Vercel Cron auto-injects Authorization: Bearer <CRON_SECRET>
	const secret = process.env.CRON_SECRET;
	if (!secret) return true; // dev mode — allow
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
	});

	try {
		// Stage 1 pipeline
		const orchestrated = await runStage1(learning, TARGET_COUNT);
		await attachPlanToSession(sessionId, orchestrated.plan);

		// Stage 1 단계 7: broadcast tagging
		const broadcasts = await tagBroadcastEvidence(orchestrated.candidates);
		const broadcastMap = new Map(broadcasts.map((b) => [b.productUrl, b]));

		// Stage 1 단계 8: save
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
			sessionId,
			producedCount: savedCount,
			iterations: orchestrated.iterations,
			poolSize: orchestrated.poolSize,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("[cron daily-discovery] failed:", msg);
		await finalizeSession({
			sessionId,
			status: "failed",
			producedCount: 0,
			iterations: 0,
			error: msg.slice(0, 500),
		});
		return NextResponse.json(
			{ ok: false, sessionId, error: msg },
			{ status: 500 },
		);
	}
}
```

- [ ] **Step 2: `vercel.json` 수정**

Open `vercel.json`. Current structure has `functions` and `crons` top-level keys.

Add new function timeout entry inside `functions`:
```json
"app/api/cron/daily-discovery/route.ts": {
  "maxDuration": 300
}
```

Add new cron entry inside `crons` array:
```json
{
  "path": "/api/cron/daily-discovery",
  "schedule": "0 0 * * *"
}
```

The full updated `vercel.json` should look like:

```json
{
  "functions": {
    "app/api/analyze/synthesize/route.ts": { "maxDuration": 300 },
    "app/api/analyze/route.ts": { "maxDuration": 120 },
    "app/api/cron/daily-refresh/route.ts": { "maxDuration": 300 },
    "app/api/cron/daily-discovery/route.ts": { "maxDuration": 300 },
    "app/api/recommend/route.ts": { "maxDuration": 60 },
    "app/api/analytics/expansion/route.ts": { "maxDuration": 120 },
    "app/api/products/upload-taicho/route.ts": { "maxDuration": 120 },
    "app/api/analytics/md-strategy/route.ts": { "maxDuration": 300 },
    "app/api/analytics/live-commerce/route.ts": { "maxDuration": 300 }
  },
  "crons": [
    { "path": "/api/cron/daily-refresh", "schedule": "0 9 * * *" },
    { "path": "/api/cron/daily-discovery", "schedule": "0 0 * * *" }
  ]
}
```

- [ ] **Step 3: 타입 체크**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: 커밋**

```bash
git add app/api/cron/daily-discovery/route.ts vercel.json
git commit -m "feat(discovery): add daily-discovery cron endpoint + vercel.json wiring"
```

---

## Task 5: `/api/discovery/manual-trigger` — 관리자 재실행

**Files:**
- Create: `app/api/discovery/manual-trigger/route.ts`

- [ ] **Step 1: 파일 생성**

Write to `app/api/discovery/manual-trigger/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { GET as runCron } from "@/app/api/cron/daily-discovery/route";

export const maxDuration = 300;

/**
 * Manual admin trigger for discovery cron — used when the scheduled run
 * fails or for ad-hoc runs. Protected by CRON_SECRET (matches cron auth).
 */
export async function POST(req: NextRequest) {
	const secret = process.env.CRON_SECRET;
	if (secret) {
		const header = req.headers.get("authorization");
		if (header !== `Bearer ${secret}`) {
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		}
	}
	return runCron(req);
}
```

- [ ] **Step 2: `vercel.json`에 함수 타임아웃 추가**

Add inside `functions`:
```json
"app/api/discovery/manual-trigger/route.ts": { "maxDuration": 300 }
```

- [ ] **Step 3: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add app/api/discovery/manual-trigger/route.ts vercel.json
git commit -m "feat(discovery): add manual-trigger admin endpoint"
```

---

## Task 6: 조회 API 3종 (today, sessions, sessions/[id])

**Files:**
- Create: `app/api/discovery/today/route.ts`
- Create: `app/api/discovery/sessions/route.ts`
- Create: `app/api/discovery/sessions/[id]/route.ts`

- [ ] **Step 1: today/route.ts 생성**

Write to `app/api/discovery/today/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * Return the most recent completed or partial session + its products.
 * Query params:
 *   - status: filter discovered_products.user_action (sourced|interested|rejected|duplicate)
 *   - track: filter by tv_proven|exploration
 */
export async function GET(req: NextRequest) {
	const sb = getServiceClient();
	const { searchParams } = new URL(req.url);

	const { data: session, error: sessErr } = await sb
		.from("discovery_runs")
		.select("*")
		.in("status", ["completed", "partial"])
		.order("run_at", { ascending: false })
		.limit(1)
		.maybeSingle();

	if (sessErr) {
		return NextResponse.json({ error: sessErr.message }, { status: 500 });
	}
	if (!session) {
		return NextResponse.json({ session: null, products: [] });
	}

	let q = sb
		.from("discovered_products")
		.select("*")
		.eq("session_id", session.id)
		.order("tv_fit_score", { ascending: false });

	const statusFilter = searchParams.get("status");
	if (statusFilter) {
		if (statusFilter === "uncategorized") {
			q = q.is("user_action", null);
		} else {
			q = q.eq("user_action", statusFilter);
		}
	}

	const trackFilter = searchParams.get("track");
	if (trackFilter) {
		q = q.eq("track", trackFilter);
	}

	const { data: products, error: prodErr } = await q;
	if (prodErr) {
		return NextResponse.json({ error: prodErr.message }, { status: 500 });
	}

	return NextResponse.json({ session, products: products ?? [] });
}
```

- [ ] **Step 2: sessions/route.ts 생성**

Write to `app/api/discovery/sessions/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 30;

/**
 * List recent sessions for navigation.
 * Query params:
 *   - limit (default 30, max 100)
 *   - offset (default 0)
 */
export async function GET(req: NextRequest) {
	const sb = getServiceClient();
	const { searchParams } = new URL(req.url);

	const limit = Math.min(
		Number(searchParams.get("limit") ?? DEFAULT_LIMIT),
		100,
	);
	const offset = Number(searchParams.get("offset") ?? 0);

	const { data, error } = await sb
		.from("discovery_runs")
		.select("id, run_at, completed_at, status, target_count, produced_count, iterations")
		.order("run_at", { ascending: false })
		.range(offset, offset + limit - 1);

	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
	return NextResponse.json({ sessions: data ?? [] });
}
```

- [ ] **Step 3: sessions/[id]/route.ts 생성**

Write to `app/api/discovery/sessions/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(
	_req: NextRequest,
	ctx: { params: Promise<{ id: string }> },
) {
	const { id } = await ctx.params;
	const sb = getServiceClient();

	const [sessionRes, productsRes] = await Promise.all([
		sb.from("discovery_runs").select("*").eq("id", id).maybeSingle(),
		sb
			.from("discovered_products")
			.select("*")
			.eq("session_id", id)
			.order("tv_fit_score", { ascending: false }),
	]);

	if (sessionRes.error) {
		return NextResponse.json({ error: sessionRes.error.message }, { status: 500 });
	}
	if (!sessionRes.data) {
		return NextResponse.json({ error: "session not found" }, { status: 404 });
	}
	if (productsRes.error) {
		return NextResponse.json({ error: productsRes.error.message }, { status: 500 });
	}

	return NextResponse.json({
		session: sessionRes.data,
		products: productsRes.data ?? [],
	});
}
```

- [ ] **Step 4: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add app/api/discovery/today/route.ts app/api/discovery/sessions/route.ts app/api/discovery/sessions/[id]/route.ts
git commit -m "feat(discovery): add 3 read APIs (today, sessions list, session detail)"
```

---

## Task 7: i18n 키 추가

**Files:**
- Modify: `messages/ja.json`
- Modify: `messages/en.json`

- [ ] **Step 1: `messages/ja.json` 에 discovery 블록 추가**

Find the last top-level key in `messages/ja.json` and add a `"discovery"` block at the end (before the closing `}`). Example:

```json
  "discovery": {
    "title": "本日の発掘",
    "subtitle": "毎日自動発掘される30商品の一覧",
    "noSession": "まだセッションがありません。cronを手動実行してください。",
    "sessionRunning": "実行中...",
    "sessionFailed": "実行失敗",
    "sessionPartial": "部分完了",
    "sessionCompleted": "完了",
    "filterAll": "すべて",
    "filterUncategorized": "未レビュー",
    "filterSourced": "ソーシング済み",
    "filterInterested": "関心あり",
    "filterRejected": "却下",
    "trackTvProven": "TV実績",
    "trackExploration": "探索",
    "broadcastConfirmed": "放送確認",
    "broadcastLikely": "放送の可能性",
    "broadcastUnknown": "情報なし",
    "sortByScore": "スコア順",
    "sortByPrice": "価格順",
    "viewHistory": "履歴を見る",
    "goLive": "商品ページへ"
  }
```

- [ ] **Step 2: `messages/en.json` 에 같은 블록 추가 (영어)**

```json
  "discovery": {
    "title": "Today's Discovery",
    "subtitle": "30 auto-discovered products each day",
    "noSession": "No session yet. Trigger cron manually.",
    "sessionRunning": "Running...",
    "sessionFailed": "Failed",
    "sessionPartial": "Partial",
    "sessionCompleted": "Completed",
    "filterAll": "All",
    "filterUncategorized": "Unreviewed",
    "filterSourced": "Sourced",
    "filterInterested": "Interested",
    "filterRejected": "Rejected",
    "trackTvProven": "TV Proven",
    "trackExploration": "Exploration",
    "broadcastConfirmed": "Broadcast confirmed",
    "broadcastLikely": "Likely broadcast",
    "broadcastUnknown": "Unknown",
    "sortByScore": "By score",
    "sortByPrice": "By price",
    "viewHistory": "View history",
    "goLive": "Product page"
  }
```

- [ ] **Step 3: 커밋**

```bash
git add messages/ja.json messages/en.json
git commit -m "feat(discovery): add i18n keys for discovery UI"
```

---

## Task 8: `components/discovery/*` — UI 컴포넌트 3종

**Files:**
- Create: `components/discovery/DiscoveryHeader.tsx`
- Create: `components/discovery/ProductCard.tsx`
- Create: `components/discovery/DiscoveryFilters.tsx`

- [ ] **Step 1: DiscoveryHeader.tsx 생성**

Write to `components/discovery/DiscoveryHeader.tsx`:

```tsx
import { useTranslations } from "next-intl";

type Session = {
	id: string;
	run_at: string;
	completed_at: string | null;
	status: "running" | "completed" | "partial" | "failed";
	target_count: number;
	produced_count: number;
	iterations: number;
};

export function DiscoveryHeader({
	session,
	totalCount,
	uncategorizedCount,
	sourcedCount,
}: {
	session: Session | null;
	totalCount: number;
	uncategorizedCount: number;
	sourcedCount: number;
}) {
	const t = useTranslations("discovery");

	if (!session) {
		return (
			<div className="bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3 text-yellow-800 text-sm">
				{t("noSession")}
			</div>
		);
	}

	const statusColor =
		session.status === "completed"
			? "bg-green-50 text-green-700 border-green-200"
			: session.status === "partial"
			? "bg-yellow-50 text-yellow-700 border-yellow-200"
			: session.status === "failed"
			? "bg-red-50 text-red-700 border-red-200"
			: "bg-blue-50 text-blue-700 border-blue-200";

	const statusLabel =
		session.status === "completed"
			? t("sessionCompleted")
			: session.status === "partial"
			? t("sessionPartial")
			: session.status === "failed"
			? t("sessionFailed")
			: t("sessionRunning");

	return (
		<div className="flex flex-wrap items-center gap-3 mb-6">
			<span className={`inline-flex items-center px-3 py-1 rounded-full border text-xs font-medium ${statusColor}`}>
				{statusLabel}
			</span>
			<span className="text-sm text-gray-600">
				{new Date(session.run_at).toLocaleString("ja-JP")}
			</span>
			<span className="text-sm text-gray-500">
				{totalCount}/{session.target_count} 件
			</span>
			<span className="text-sm text-gray-500">· {t("filterUncategorized")}: {uncategorizedCount}</span>
			<span className="text-sm text-gray-500">· {t("filterSourced")}: {sourcedCount}</span>
			{session.iterations > 0 && (
				<span className="text-xs text-gray-400">iterations: {session.iterations}</span>
			)}
		</div>
	);
}
```

- [ ] **Step 2: ProductCard.tsx 생성**

Write to `components/discovery/ProductCard.tsx`:

```tsx
import { useTranslations } from "next-intl";

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
};

export function ProductCard({ product }: { product: DiscoveredProductRow }) {
	const t = useTranslations("discovery");
	const score = product.tv_fit_score ?? 0;

	const scoreColor =
		score >= 80
			? "bg-green-100 text-green-800 border-green-200"
			: score >= 60
			? "bg-yellow-100 text-yellow-800 border-yellow-200"
			: "bg-gray-100 text-gray-600 border-gray-200";

	const trackLabel =
		product.track === "tv_proven" ? t("trackTvProven") : t("trackExploration");

	const broadcastBadge =
		product.broadcast_tag === "broadcast_confirmed"
			? { label: t("broadcastConfirmed"), color: "bg-red-50 text-red-700" }
			: product.broadcast_tag === "broadcast_likely"
			? { label: t("broadcastLikely"), color: "bg-orange-50 text-orange-700" }
			: null;

	return (
		<article className="flex gap-4 p-4 bg-white border border-gray-200 rounded-lg hover:shadow-sm transition-shadow">
			<div className="flex-shrink-0 w-28 h-28 bg-gray-100 rounded overflow-hidden">
				{product.thumbnail_url ? (
					<img
						src={product.thumbnail_url}
						alt={product.name}
						className="w-full h-full object-cover"
					/>
				) : (
					<div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">
						no image
					</div>
				)}
			</div>

			<div className="flex-1 min-w-0">
				<div className="flex items-start justify-between gap-2 mb-1">
					<h3 className="text-sm font-medium text-gray-900 line-clamp-2 flex-1">
						{product.name}
					</h3>
					<span
						className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-semibold ${scoreColor}`}
					>
						{score}
					</span>
				</div>

				<div className="flex flex-wrap items-center gap-2 text-xs text-gray-600 mb-1">
					<span className="font-medium text-gray-900">
						{product.price_jpy ? `¥${product.price_jpy.toLocaleString()}` : "¥?"}
					</span>
					{product.review_avg !== null && (
						<span>
							★{product.review_avg} ({product.review_count ?? 0})
						</span>
					)}
					{product.seller_name && <span className="truncate max-w-[200px]">{product.seller_name}</span>}
				</div>

				<div className="flex flex-wrap items-center gap-1 mb-2">
					<span className="inline-block px-2 py-0.5 rounded bg-gray-100 text-gray-700 text-[10px]">
						{trackLabel}
					</span>
					{broadcastBadge && (
						<span className={`inline-block px-2 py-0.5 rounded text-[10px] ${broadcastBadge.color}`}>
							{broadcastBadge.label}
						</span>
					)}
				</div>

				{product.tv_fit_reason && (
					<p className="text-xs text-gray-600 line-clamp-2 mb-2">{product.tv_fit_reason}</p>
				)}

				<a
					href={product.product_url}
					target="_blank"
					rel="noopener noreferrer"
					className="text-xs text-blue-600 hover:underline"
				>
					{t("goLive")} →
				</a>
			</div>
		</article>
	);
}
```

- [ ] **Step 3: DiscoveryFilters.tsx 생성**

Write to `components/discovery/DiscoveryFilters.tsx`:

```tsx
"use client";
import { useTranslations } from "next-intl";

export type StatusFilter = "all" | "uncategorized" | "sourced" | "interested" | "rejected";
export type SortKey = "score" | "price";

export function DiscoveryFilters({
	status,
	onStatusChange,
	sort,
	onSortChange,
}: {
	status: StatusFilter;
	onStatusChange: (next: StatusFilter) => void;
	sort: SortKey;
	onSortChange: (next: SortKey) => void;
}) {
	const t = useTranslations("discovery");

	const statusOptions: Array<{ value: StatusFilter; label: string }> = [
		{ value: "all", label: t("filterAll") },
		{ value: "uncategorized", label: t("filterUncategorized") },
		{ value: "sourced", label: t("filterSourced") },
		{ value: "interested", label: t("filterInterested") },
		{ value: "rejected", label: t("filterRejected") },
	];

	return (
		<div className="flex flex-wrap items-center gap-2 mb-4">
			<div className="flex gap-1">
				{statusOptions.map((opt) => (
					<button
						key={opt.value}
						onClick={() => onStatusChange(opt.value)}
						className={`px-3 py-1 text-xs rounded-full border transition-colors ${
							status === opt.value
								? "bg-blue-600 text-white border-blue-600"
								: "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
						}`}
					>
						{opt.label}
					</button>
				))}
			</div>

			<div className="ml-auto">
				<select
					value={sort}
					onChange={(e) => onSortChange(e.target.value as SortKey)}
					className="px-3 py-1 text-xs border border-gray-200 rounded bg-white"
				>
					<option value="score">{t("sortByScore")}</option>
					<option value="price">{t("sortByPrice")}</option>
				</select>
			</div>
		</div>
	);
}
```

- [ ] **Step 4: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add components/discovery/
git commit -m "feat(discovery): add UI components (Header, ProductCard, Filters)"
```

---

## Task 9: `/discovery` 페이지 (오늘 + 세션 상세)

**Files:**
- Create: `app/[locale]/discovery/page.tsx`
- Create: `app/[locale]/discovery/[sessionId]/page.tsx`

- [ ] **Step 1: `discovery/page.tsx` (오늘) 생성**

Write to `app/[locale]/discovery/page.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import Navbar from "@/components/Navbar";
import { DiscoveryHeader } from "@/components/discovery/DiscoveryHeader";
import { ProductCard, type DiscoveredProductRow } from "@/components/discovery/ProductCard";
import {
	DiscoveryFilters,
	type SortKey,
	type StatusFilter,
} from "@/components/discovery/DiscoveryFilters";

type Session = {
	id: string;
	run_at: string;
	completed_at: string | null;
	status: "running" | "completed" | "partial" | "failed";
	target_count: number;
	produced_count: number;
	iterations: number;
};

export default function DiscoveryPage() {
	const t = useTranslations("discovery");
	const [session, setSession] = useState<Session | null>(null);
	const [products, setProducts] = useState<DiscoveredProductRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [status, setStatus] = useState<StatusFilter>("all");
	const [sort, setSort] = useState<SortKey>("score");

	useEffect(() => {
		let cancelled = false;
		async function load() {
			setLoading(true);
			const res = await fetch("/api/discovery/today");
			const data = await res.json();
			if (!cancelled) {
				setSession(data.session);
				setProducts(data.products ?? []);
				setLoading(false);
			}
		}
		load();
		return () => {
			cancelled = true;
		};
	}, []);

	const filtered = useMemo(() => {
		let list = products;
		if (status === "uncategorized") list = list.filter((p) => !p.id || !("user_action" in p) || !(p as unknown as { user_action?: string }).user_action);
		else if (status !== "all")
			list = list.filter((p) => (p as unknown as { user_action?: string }).user_action === status);
		if (sort === "score") list = [...list].sort((a, b) => (b.tv_fit_score ?? 0) - (a.tv_fit_score ?? 0));
		else if (sort === "price") list = [...list].sort((a, b) => (b.price_jpy ?? 0) - (a.price_jpy ?? 0));
		return list;
	}, [products, status, sort]);

	const counts = useMemo(() => {
		const total = products.length;
		const uncategorized = products.filter(
			(p) => !(p as unknown as { user_action?: string }).user_action,
		).length;
		const sourced = products.filter(
			(p) => (p as unknown as { user_action?: string }).user_action === "sourced",
		).length;
		return { total, uncategorized, sourced };
	}, [products]);

	return (
		<div className="min-h-screen bg-gray-50">
			<Navbar />
			<main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
				<header className="mb-6">
					<h1 className="text-2xl font-bold text-gray-900 mb-1">{t("title")}</h1>
					<p className="text-sm text-gray-500">{t("subtitle")}</p>
				</header>

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

						<DiscoveryFilters
							status={status}
							onStatusChange={setStatus}
							sort={sort}
							onSortChange={setSort}
						/>

						<div className="space-y-3">
							{filtered.map((p) => (
								<ProductCard key={p.id} product={p} />
							))}
							{filtered.length === 0 && (
								<div className="py-12 text-center text-sm text-gray-400">
									(no products match the current filter)
								</div>
							)}
						</div>
					</>
				)}
			</main>
		</div>
	);
}
```

- [ ] **Step 2: `discovery/[sessionId]/page.tsx` 생성**

Write to `app/[locale]/discovery/[sessionId]/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import Navbar from "@/components/Navbar";
import { DiscoveryHeader } from "@/components/discovery/DiscoveryHeader";
import { ProductCard, type DiscoveredProductRow } from "@/components/discovery/ProductCard";

type Session = {
	id: string;
	run_at: string;
	completed_at: string | null;
	status: "running" | "completed" | "partial" | "failed";
	target_count: number;
	produced_count: number;
	iterations: number;
};

export default function SessionDetailPage() {
	const t = useTranslations("discovery");
	const params = useParams<{ sessionId: string }>();
	const sessionId = params?.sessionId;
	const [session, setSession] = useState<Session | null>(null);
	const [products, setProducts] = useState<DiscoveredProductRow[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if (!sessionId) return;
		let cancelled = false;
		async function load() {
			setLoading(true);
			const res = await fetch(`/api/discovery/sessions/${sessionId}`);
			const data = await res.json();
			if (!cancelled) {
				setSession(data.session);
				setProducts(data.products ?? []);
				setLoading(false);
			}
		}
		load();
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	const counts = {
		total: products.length,
		uncategorized: products.filter(
			(p) => !(p as unknown as { user_action?: string }).user_action,
		).length,
		sourced: products.filter(
			(p) => (p as unknown as { user_action?: string }).user_action === "sourced",
		).length,
	};

	return (
		<div className="min-h-screen bg-gray-50">
			<Navbar />
			<main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
				<header className="mb-6">
					<h1 className="text-2xl font-bold text-gray-900 mb-1">{t("title")}</h1>
					<p className="text-xs text-gray-500">session: {sessionId}</p>
				</header>

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

						<div className="space-y-3">
							{products.map((p) => (
								<ProductCard key={p.id} product={p} />
							))}
							{products.length === 0 && (
								<div className="py-12 text-center text-sm text-gray-400">
									(no products in this session)
								</div>
							)}
						</div>
					</>
				)}
			</main>
		</div>
	);
}
```

- [ ] **Step 3: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add app/[locale]/discovery/
git commit -m "feat(discovery): add /discovery page + session detail page"
```

---

## Task 10: 수동 cron 트리거 + end-to-end 검증

**Files:** (실행만, 코드 변경 없음)

**Depends on:** Tasks 1-9 완료.

- [ ] **Step 1: 환경변수 확인**

`.env.local` 에 다음이 있는지 확인 (Phase 1과 동일):
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY`
- `RAKUTEN_APPLICATION_ID` + `RAKUTEN_ACCESS_KEY`
- `BRAVE_SEARCH_API_KEY`

옵션: `CRON_SECRET` — 로컬 dev에서는 생략 가능 (코드가 secret 없으면 allow).

- [ ] **Step 2: Dev 서버 시작**

Run: `npm run dev`
Expected: `http://localhost:3000` 에서 구동.

- [ ] **Step 3: 수동 cron 트리거**

별도 터미널에서:
```bash
curl -X GET http://localhost:3000/api/cron/daily-discovery
```

Expected (60-180초 소요):
```json
{
  "ok": true,
  "sessionId": "...",
  "producedCount": 30,
  "iterations": 0,
  "poolSize": 200
}
```

- [ ] **Step 4: DB 검증**

Supabase Studio SQL Editor:
```sql
SELECT id, status, target_count, produced_count, iterations, run_at
FROM discovery_runs
ORDER BY run_at DESC
LIMIT 5;
```

Expected: 1개 새 row, status='completed' 또는 'partial', produced_count=30.

```sql
SELECT COUNT(*), track, broadcast_tag
FROM discovered_products
WHERE session_id = (SELECT id FROM discovery_runs ORDER BY run_at DESC LIMIT 1)
GROUP BY track, broadcast_tag;
```

Expected: 30개 합계. track별 분포 (tv_proven/exploration), broadcast_tag별 분포 (대부분 unknown 예상).

- [ ] **Step 5: UI 검증**

브라우저에서 `http://localhost:3000/ja/discovery` 접속.

확인사항:
- [ ] 상단 배너에 "完了" 또는 "部分完了" 표시
- [ ] 30개 카드 표시 (tv_fit_score 높은 순)
- [ ] 카드에 썸네일 (가능한 경우), 가격, 리뷰, 판매자 표시
- [ ] track 배지 (TV実績 / 探索)
- [ ] broadcast 배지 (broadcast_confirmed/likely 있는 경우)
- [ ] "商品ページへ" 링크 → Rakuten 상품 페이지 정상 이동
- [ ] 상단 필터 클릭 시 동작 (all/uncategorized 등)
- [ ] 정렬 드롭다운 동작 (score/price)

- [ ] **Step 6: 과거 세션 UI 확인**

브라우저에서 `http://localhost:3000/ja/discovery/<sessionId>` 접속 (sessionId는 Step 4 DB 쿼리 결과).

확인사항:
- [ ] 해당 세션의 데이터 표시
- [ ] 동일 카드 레이아웃
- [ ] 필터/정렬 없음 (히스토리 뷰라 단순 조회)

- [ ] **Step 7: 성능 관찰**

수동 cron 트리거의 총 실행 시간:
- 정상: 90-180초
- 최대 (iteration 3회): 230초
- 실패 위험: 300초 초과 시 Vercel timeout

만약 300초 근접하면:
- curate POOL_SAMPLE_LIMIT 낮추기 (150 → 100)
- broadcast tag 배치 크기 30 → 15×2로 분할 가능

- [ ] **Step 8: Phase 2 완료 선언**

모든 검증 통과 시:
```bash
git log --oneline main..HEAD  # Phase 1+2 전체 커밋 확인
```

다음 스텝: Phase 3 (Enrichment Agent) 계획 작성 요청.

---

## Self-Review

**Spec coverage:**
- §4.2 단계 6 (bounded agent iteration) → Task 3 ✓
- §4.2 단계 7 (broadcast check) → Task 2 ✓
- §4.2 단계 8 (save) → Task 1 ✓
- §5.1 daily-discovery cron → Tasks 4 ✓
- §5.2 today / sessions / sessions/[id] → Task 6 ✓
- §5.2 manual-trigger → Task 5 ✓
- §5.3 vercel.json → Tasks 4, 5 ✓
- §9 UI (header, card, filters, main page, session detail) → Tasks 7-9 ✓
- Phase 2 out-of-scope items (feedback buttons, enrichment, insights) 확인 ✓

**Placeholder scan:** 모든 task가 실제 코드/명령어 포함.

**Type consistency:**
- `Session` 타입을 컴포넌트에서 중복 정의 — 소규모 (동일 shape) 허용 가능. 향후 `lib/discovery/types.ts` 에 `DiscoveryRunRow` 로 통합 가능 (Phase 3 에서 고려).
- `DiscoveredProductRow` 는 `ProductCard.tsx` 에 정의, 페이지에서 import — 올바름.
- `StatusFilter`, `SortKey` 는 `DiscoveryFilters.tsx` 에 정의 + export — 올바름.
- API 응답 shape은 명시되지 않음 — `fetch` 결과를 `unknown as Shape` 로 단순 처리. Phase 3 에서 zod schema 추가 고려.

**Gaps:** 
- Task 9 메인 페이지의 `(p as unknown as { user_action?: string }).user_action` 캐스팅은 불편함 — `DiscoveredProductRow` 에 `user_action` 필드 추가가 깔끔. 다음 버전 튜닝.
- `thumbnail_url` 이 DB에 저장되지 않음 (Phase 1 curate 에서 수집 안 함). Phase 2 Task 1 save.ts 에서 null로 처리됨 — 카드에 "no image" 표시. Phase 3 enrichment 때 썸네일 보강 가능.
