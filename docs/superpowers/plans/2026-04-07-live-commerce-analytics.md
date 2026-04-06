# Live Commerce Analytics Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "ライブコマース" analytics tab that researches the Japanese live commerce market via Brave Search and generates strategic entry plans via a 6-skill Gemini pipeline with SSE streaming, following the MDStrategyPanel pattern.

**Architecture:** New tab in AnalyticsDashboard with dynamic import of LiveCommercePanel. Backend uses SSE streaming with 6 sequential Gemini skills (goal_analysis → market_research → platform_analysis → content_strategy → execution_plan → risk_analysis). Results persist to `live_commerce_strategies` Supabase table. Brave Search provides real-time market data injected into Gemini prompts.

**Tech Stack:** Next.js App Router, Google Generative AI (gemini-3-flash-preview), Brave Search API, Supabase, Recharts, shadcn/ui, Tailwind CSS

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `lib/live-commerce-strategy.ts` | Types, Gemini client, Brave Search, platform reference table, 6-skill pipeline orchestrator |
| Create | `app/api/analytics/live-commerce/route.ts` | SSE POST endpoint (generate) + GET endpoint (list history) |
| Create | `app/api/analytics/live-commerce/[id]/route.ts` | GET (load saved) + DELETE (remove) |
| Create | `components/analytics/LiveCommercePanel.tsx` | Main panel: input form, progress stepper, result sections, history |
| Create | `components/analytics/live-commerce/MarketOverviewSection.tsx` | Market size, growth, trends visualization |
| Create | `components/analytics/live-commerce/PlatformAnalysisSection.tsx` | Platform comparison cards with fit scores |
| Create | `components/analytics/live-commerce/ContentStrategySection.tsx` | Per-platform content plans with tabs |
| Create | `components/analytics/live-commerce/ExecutionPlanSection.tsx` | Timeline/roadmap visualization |
| Create | `components/analytics/live-commerce/RiskAnalysisSection.tsx` | Risk cards with severity/probability |
| Modify | `components/analytics/AnalyticsDashboard.tsx` | Add 4th tab + dynamic import |
| Modify | `vercel.json` | Add live-commerce route timeout (300s) |

---

### Task 1: Create Supabase Table

**Files:**
- Reference: `app/api/analytics/md-strategy/route.ts` (insert pattern)

- [ ] **Step 1: Create the `live_commerce_strategies` table in Supabase**

Run this SQL in the Supabase SQL editor (Dashboard → SQL Editor):

```sql
create table live_commerce_strategies (
  id uuid primary key default gen_random_uuid(),
  user_goal text,
  target_platforms text[],
  market_research jsonb,
  platform_analysis jsonb,
  content_strategy jsonb,
  execution_plan jsonb,
  risk_analysis jsonb,
  search_sources jsonb,
  created_at timestamptz default now()
);

alter table live_commerce_strategies enable row level security;
```

- [ ] **Step 2: Verify the table exists**

Run in SQL editor:
```sql
select column_name, data_type from information_schema.columns
where table_name = 'live_commerce_strategies' order by ordinal_position;
```

Expected: 10 columns (id, user_goal, target_platforms, market_research, platform_analysis, content_strategy, execution_plan, risk_analysis, search_sources, created_at).

- [ ] **Step 3: Commit (no code change — DB-only step, note in commit)**

```bash
git add -A
git commit -m "docs: note live_commerce_strategies table creation"
```

---

### Task 2: Backend — `lib/live-commerce-strategy.ts`

**Files:**
- Create: `lib/live-commerce-strategy.ts`
- Reference: `lib/md-strategy.ts` (callGemini, parseJSON, braveSearchStructured, orchestrator pattern)

- [ ] **Step 1: Create types and constants**

```typescript
// lib/live-commerce-strategy.ts
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------------------------------------------------------------------------
// Gemini client
// ---------------------------------------------------------------------------

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

async function callGemini(prompt: string): Promise<string> {
	const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
	const resultPromise = model.generateContent(prompt);
	const timeoutPromise = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error("Gemini timeout (90s)")), 90000),
	);
	const result = await Promise.race([resultPromise, timeoutPromise]);
	return result.response.text().trim();
}

function parseJSON<T>(raw: string): T {
	const match = raw.match(/\{[\s\S]*\}/);
	if (!match) throw new Error("Failed to parse JSON from Gemini response");
	return JSON.parse(match[0]) as T;
}

// ---------------------------------------------------------------------------
// Brave Search
// ---------------------------------------------------------------------------

export interface SearchSource {
	title: string;
	url: string;
	description: string;
	query: string;
}

const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY;

async function braveSearch(query: string): Promise<SearchSource[]> {
	if (!BRAVE_API_KEY) return [];
	try {
		const res = await fetch(
			`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
			{
				headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": BRAVE_API_KEY },
				signal: AbortSignal.timeout(4000),
			},
		);
		if (!res.ok) return [];
		const data = await res.json();
		return (data.web?.results ?? []).slice(0, 5).map((r: { title?: string; url?: string; description?: string }) => ({
			title: r.title ?? "",
			url: r.url ?? "",
			description: r.description ?? "",
			query,
		}));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Platform Reference Table
// ---------------------------------------------------------------------------

export const PLATFORM_REFERENCE = [
	{ name: "TikTok Live", commission: "2-8%", minFollowers: "1,000+", demographics: "10-30代", avgViewers: "100-10,000", entryDifficulty: "中" },
	{ name: "Instagram Live", commission: "5%", minFollowers: "制限なし", demographics: "20-40代女性", avgViewers: "50-5,000", entryDifficulty: "低" },
	{ name: "YouTube Live", commission: "0% (Super Chat 30%)", minFollowers: "50+", demographics: "全年齢", avgViewers: "50-50,000", entryDifficulty: "中" },
	{ name: "楽天ROOM LIVE", commission: "楽天手数料に含む", minFollowers: "制限なし", demographics: "30-50代", avgViewers: "50-2,000", entryDifficulty: "低" },
	{ name: "Yahoo!ショッピング LIVE", commission: "Yahoo!手数料に含む", minFollowers: "出店者のみ", demographics: "30-50代", avgViewers: "50-1,000", entryDifficulty: "中" },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LCSkillName =
	| "goal_analysis"
	| "market_research"
	| "platform_analysis"
	| "content_strategy"
	| "execution_plan"
	| "risk_analysis";

export const LC_SKILL_META: Record<LCSkillName, { label: string; labelJa: string }> = {
	goal_analysis: { label: "Goal Analysis", labelJa: "目標分析" },
	market_research: { label: "Market Research", labelJa: "市場調査" },
	platform_analysis: { label: "Platform Analysis", labelJa: "プラットフォーム分析" },
	content_strategy: { label: "Content Strategy", labelJa: "コンテンツ戦略" },
	execution_plan: { label: "Execution Plan", labelJa: "実行ロードマップ" },
	risk_analysis: { label: "Risk Analysis", labelJa: "リスク分析" },
};

export interface LCProgressEvent {
	skill: LCSkillName | "data_fetch";
	status: "running" | "complete" | "error";
	index: number;
	total: number;
	data?: unknown;
	error?: string;
}

export interface ParsedGoal {
	primary_objective: string;
	target_platforms: string[];
	budget_range?: string;
	timeline?: string;
	target_audience?: string;
}

export interface MarketResearchOutput {
	market_size: string;
	growth_rate: string;
	key_trends: Array<{ trend: string; description: string }>;
	major_players: Array<{ name: string; platform: string; description: string }>;
	consumer_behavior: string;
	market_outlook: string;
	sources_referenced: number[];
}

export interface PlatformAnalysisOutput {
	platforms: Array<{
		name: string;
		fit_score: number;
		user_base: string;
		commission_structure: string;
		strengths: string[];
		weaknesses: string[];
		success_cases: Array<{ brand: string; description: string; result: string }>;
		recommended_products: string[];
		entry_steps: string[];
	}>;
	comparison_summary: string;
	recommended_priority: string[];
}

export interface ContentStrategyOutput {
	platforms: Array<{
		name: string;
		broadcast_format: string;
		optimal_times: string[];
		frequency: string;
		host_style: string;
		content_ideas: Array<{ title: string; description: string; format: string }>;
		engagement_tactics: string[];
		sample_script_outline: string;
	}>;
	cross_platform_strategy: string;
}

export interface ExecutionPlanOutput {
	phases: Array<{
		phase: string;
		period: string;
		objectives: string[];
		actions: Array<{ action: string; owner: string; deadline: string }>;
		budget: string;
		kpis: Array<{ metric: string; target: string }>;
	}>;
	total_investment: string;
	staffing: Array<{ role: string; type: string; timing: string }>;
	tools_and_services: Array<{ name: string; purpose: string; cost: string }>;
}

export interface RiskAnalysisOutput {
	risks: Array<{
		category: string;
		description: string;
		severity: "high" | "medium" | "low";
		probability: "high" | "medium" | "low";
		mitigation: string;
	}>;
	contingency_plans: Array<{ scenario: string; response: string }>;
	success_factors: string[];
}

export interface FullLCStrategyResult {
	goal_analysis: ParsedGoal | null;
	market_research: MarketResearchOutput;
	platform_analysis: PlatformAnalysisOutput;
	content_strategy: ContentStrategyOutput;
	execution_plan: ExecutionPlanOutput;
	risk_analysis: RiskAnalysisOutput;
}
```

- [ ] **Step 2: Add data fetch and search functions**

Append to the same file:

```typescript
// ---------------------------------------------------------------------------
// Search Queries
// ---------------------------------------------------------------------------

const STATIC_QUERIES = [
	"日本 ライブコマース 市場規模 2025 2026",
	"ライブコマース プラットフォーム 比較 日本",
	"TikTok Live 日本 売上 成功事例",
	"Instagram ライブ販売 日本 戦略",
	"YouTube Live ショッピング 日本",
	"楽天ROOM LIVE 出店 手数料",
];

function buildDynamicQueries(goal: ParsedGoal): string[] {
	const queries: string[] = [];
	for (const platform of goal.target_platforms.slice(0, 2)) {
		queries.push(`${platform} ライブコマース 日本 攻略`);
	}
	return queries;
}

export interface LCContext {
	userGoal?: string;
	targetPlatforms?: string[];
	parsedGoal?: ParsedGoal;
	searchSources: SearchSource[];
	searchSummary: string;
}

export async function fetchLCContext(
	userGoal?: string,
	targetPlatforms?: string[],
): Promise<LCContext> {
	// Phase 1: Run all search queries in parallel
	const allQueries = [...STATIC_QUERIES];
	// We'll add dynamic queries after goal analysis if needed

	const searchResults = await Promise.all(allQueries.map((q) => braveSearch(q)));
	const allSources = searchResults.flat();

	// Build a text summary of search results for Gemini prompts
	const searchSummary = allSources
		.map((s, i) => `[${i + 1}] ${s.title}\n${s.description}\n(${s.url})`)
		.join("\n\n");

	return {
		userGoal,
		targetPlatforms,
		searchSources: allSources,
		searchSummary,
	};
}
```

- [ ] **Step 3: Add skill prompts and orchestrator**

Append to the same file:

```typescript
// ---------------------------------------------------------------------------
// Skill 0: Goal Analysis
// ---------------------------------------------------------------------------

async function runGoalAnalysis(userGoal: string): Promise<ParsedGoal> {
	const prompt = `あなたはライブコマース戦略コンサルタントです。以下のユーザー目標を構造化してください。

ユーザー入力: "${userGoal}"

以下のJSON形式で出力:
{
  "primary_objective": "<主な目的を1-2文で>",
  "target_platforms": ["<プラットフォーム名>"],
  "budget_range": "<予算範囲（言及がなければnull）>",
  "timeline": "<タイムライン（言及がなければnull）>",
  "target_audience": "<ターゲット層（言及がなければnull）>"
}

注意:
- target_platformsが明示されていない場合はTikTok Live, Instagram Live, YouTube Liveをデフォルトで含める
- 全てのテキストは日本語で出力`;

	const raw = await callGemini(prompt);
	return parseJSON<ParsedGoal>(raw);
}

// ---------------------------------------------------------------------------
// Skill pipeline definition
// ---------------------------------------------------------------------------

interface SkillDef {
	name: LCSkillName;
	buildPrompt: (ctx: LCContext, outputs: Record<string, unknown>) => string;
}

function formatPlatformRef(): string {
	return PLATFORM_REFERENCE.map((p) =>
		`- ${p.name}: 手数料${p.commission}, フォロワー条件${p.minFollowers}, 主な層${p.demographics}, 視聴者数${p.avgViewers}, 参入難易度${p.entryDifficulty}`
	).join("\n");
}

function goalSection(ctx: LCContext): string {
	if (!ctx.parsedGoal) return "";
	const g = ctx.parsedGoal;
	return `
=== ユーザー目標 ===
- 主な目的: ${g.primary_objective}
- 対象プラットフォーム: ${g.target_platforms.join(", ")}
${g.budget_range ? `- 予算: ${g.budget_range}` : ""}
${g.timeline ? `- タイムライン: ${g.timeline}` : ""}
${g.target_audience ? `- ターゲット層: ${g.target_audience}` : ""}
上記の目標を全ての分析で最優先に考慮してください。
`;
}

const SKILL_PIPELINE: SkillDef[] = [
	{
		name: "goal_analysis",
		buildPrompt: () => "", // handled separately
	},
	{
		name: "market_research",
		buildPrompt: (ctx) => `あなたは日本のライブコマース市場の専門アナリストです。
以下のウェブ検索結果に基づき、日本のライブコマース市場を分析してください。

=== ウェブ検索結果 ===
${ctx.searchSummary}

${goalSection(ctx)}

以下のJSON形式で出力:
{
  "market_size": "<日本のライブコマース市場規模>",
  "growth_rate": "<年間成長率>",
  "key_trends": [{"trend": "<トレンド名>", "description": "<説明>"}],
  "major_players": [{"name": "<企業/人物名>", "platform": "<プラットフォーム>", "description": "<概要>"}],
  "consumer_behavior": "<日本の消費者のライブコマースに対する行動特性>",
  "market_outlook": "<今後の市場見通し>",
  "sources_referenced": [<使用したソースの番号>]
}

注意:
- key_trendsは5-8個
- major_playersは5-10個
- 全てのテキストは日本語で出力
- ウェブ検索結果を根拠として活用し、sources_referencedで番号を記載`,
	},
	{
		name: "platform_analysis",
		buildPrompt: (ctx, outputs) => `あなたは日本のライブコマースプラットフォーム専門家です。
以下の情報に基づき、各プラットフォームの詳細分析を行ってください。

=== プラットフォーム基本情報 ===
${formatPlatformRef()}

=== 市場調査結果 ===
${JSON.stringify(outputs.market_research ?? {}, null, 2)}

=== ウェブ検索結果 ===
${ctx.searchSummary}

${goalSection(ctx)}

以下のJSON形式で出力:
{
  "platforms": [
    {
      "name": "<プラットフォーム名>",
      "fit_score": <0-100>,
      "user_base": "<ユーザー層の詳細>",
      "commission_structure": "<手数料体系の詳細>",
      "strengths": ["<強み1>", "<強み2>"],
      "weaknesses": ["<弱み1>", "<弱み2>"],
      "success_cases": [{"brand": "<ブランド名>", "description": "<取り組み内容>", "result": "<成果>"}],
      "recommended_products": ["<このプラットフォームに適した商品カテゴリ>"],
      "entry_steps": ["<参入ステップ1>", "<ステップ2>"]
    }
  ],
  "comparison_summary": "<プラットフォーム比較の総括>",
  "recommended_priority": ["<優先度順のプラットフォーム名>"]
}

注意:
- 5つのプラットフォーム全てを分析
- success_casesは各プラットフォーム1-3個
- 全てのテキストは日本語`,
	},
	{
		name: "content_strategy",
		buildPrompt: (ctx, outputs) => `あなたはライブコマースのコンテンツ戦略プランナーです。
以下の分析結果に基づき、プラットフォーム別のコンテンツ戦略を策定してください。

=== プラットフォーム分析結果 ===
${JSON.stringify(outputs.platform_analysis ?? {}, null, 2)}

${goalSection(ctx)}

以下のJSON形式で出力:
{
  "platforms": [
    {
      "name": "<プラットフォーム名>",
      "broadcast_format": "<推奨配信フォーマット>",
      "optimal_times": ["<最適配信時間帯>"],
      "frequency": "<推奨配信頻度>",
      "host_style": "<推奨ホストスタイル>",
      "content_ideas": [{"title": "<企画名>", "description": "<詳細>", "format": "<形式>"}],
      "engagement_tactics": ["<エンゲージメント施策>"],
      "sample_script_outline": "<サンプルスクリプトの流れ（300-500文字）>"
    }
  ],
  "cross_platform_strategy": "<クロスプラットフォーム連携戦略>"
}

注意:
- 推奨順上位3-5プラットフォームを対象
- content_ideasは各プラットフォーム3-5個
- engagement_tacticsは各プラットフォーム3-5個
- sample_script_outlineは実践的な内容
- 全てのテキストは日本語`,
	},
	{
		name: "execution_plan",
		buildPrompt: (ctx, outputs) => `あなたはライブコマース事業の実行計画策定の専門家です。
以下の全分析結果に基づき、具体的な実行ロードマップを策定してください。

=== 市場調査 ===
${JSON.stringify(outputs.market_research ?? {}, null, 2)}

=== プラットフォーム分析 ===
${JSON.stringify(outputs.platform_analysis ?? {}, null, 2)}

=== コンテンツ戦略 ===
${JSON.stringify(outputs.content_strategy ?? {}, null, 2)}

${goalSection(ctx)}

以下のJSON形式で出力:
{
  "phases": [
    {
      "phase": "<フェーズ名>",
      "period": "<期間>",
      "objectives": ["<目標>"],
      "actions": [{"action": "<アクション>", "owner": "<担当>", "deadline": "<期限>"}],
      "budget": "<予算>",
      "kpis": [{"metric": "<KPI名>", "target": "<目標値>"}]
    }
  ],
  "total_investment": "<初年度総投資額>",
  "staffing": [{"role": "<役割>", "type": "<正社員/業務委託/パート>", "timing": "<採用時期>"}],
  "tools_and_services": [{"name": "<ツール名>", "purpose": "<用途>", "cost": "<月額費用>"}]
}

注意:
- 3-4フェーズ（準備期、立ち上げ期、成長期、拡大期）
- actionsは各フェーズ3-5個
- kpisは各フェーズ2-4個
- 全てのテキストは日本語
- 具体的な数字を含める`,
	},
	{
		name: "risk_analysis",
		buildPrompt: (ctx, outputs) => `あなたはライブコマース事業のリスク管理専門家です。
以下の全分析結果に基づき、リスク分析と対策を策定してください。

=== 実行計画 ===
${JSON.stringify(outputs.execution_plan ?? {}, null, 2)}

=== プラットフォーム分析 ===
${JSON.stringify(outputs.platform_analysis ?? {}, null, 2)}

${goalSection(ctx)}

以下のJSON形式で出力:
{
  "risks": [
    {
      "category": "<リスクカテゴリ: 市場/運営/技術/法規制/財務/競合>",
      "description": "<リスク内容>",
      "severity": "<high/medium/low>",
      "probability": "<high/medium/low>",
      "mitigation": "<軽減策>"
    }
  ],
  "contingency_plans": [{"scenario": "<最悪のシナリオ>", "response": "<対応策>"}],
  "success_factors": ["<成功の重要要因>"]
}

注意:
- risksは8-12個
- contingency_plansは3-5個
- success_factorsは5-7個
- 全てのテキストは日本語`,
	},
];

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runLCOrchestrator(
	context: LCContext,
	onProgress: (event: LCProgressEvent) => void,
): Promise<FullLCStrategyResult> {
	const outputs: Record<string, unknown> = {};

	for (let i = 0; i < SKILL_PIPELINE.length; i++) {
		const skill = SKILL_PIPELINE[i];
		onProgress({ skill: skill.name, status: "running", index: i, total: SKILL_PIPELINE.length });

		try {
			if (skill.name === "goal_analysis") {
				if (context.userGoal) {
					const parsedGoal = await runGoalAnalysis(context.userGoal);
					context.parsedGoal = parsedGoal;
					outputs.goal_analysis = parsedGoal;

					// Run dynamic queries based on parsed goal
					const dynamicQueries = buildDynamicQueries(parsedGoal);
					if (dynamicQueries.length > 0) {
						const dynamicResults = await Promise.all(dynamicQueries.map((q) => braveSearch(q)));
						const newSources = dynamicResults.flat();
						context.searchSources.push(...newSources);
						context.searchSummary += "\n\n" + newSources
							.map((s, idx) => `[${context.searchSources.length - newSources.length + idx + 1}] ${s.title}\n${s.description}\n(${s.url})`)
							.join("\n\n");
					}

					onProgress({ skill: skill.name, status: "complete", index: i, total: SKILL_PIPELINE.length, data: parsedGoal });
				} else {
					// Default goal when none provided
					const defaultGoal: ParsedGoal = {
						primary_objective: "日本市場でのライブコマース事業参入の全体戦略策定",
						target_platforms: context.targetPlatforms ?? ["TikTok Live", "Instagram Live", "YouTube Live"],
					};
					context.parsedGoal = defaultGoal;
					outputs.goal_analysis = defaultGoal;
					onProgress({ skill: skill.name, status: "complete", index: i, total: SKILL_PIPELINE.length, data: defaultGoal });
				}
				continue;
			}

			const prompt = skill.buildPrompt(context, outputs);
			const raw = await callGemini(prompt);
			const parsed = parseJSON(raw);
			outputs[skill.name] = parsed;
			onProgress({ skill: skill.name, status: "complete", index: i, total: SKILL_PIPELINE.length, data: parsed });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			onProgress({ skill: skill.name, status: "error", index: i, total: SKILL_PIPELINE.length, error: message });
			outputs[skill.name] = {};
		}
	}

	return outputs as unknown as FullLCStrategyResult;
}
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add lib/live-commerce-strategy.ts
git commit -m "feat(live-commerce): add skill pipeline, types, and orchestrator"
```

---

### Task 3: Backend — API Routes

**Files:**
- Create: `app/api/analytics/live-commerce/route.ts`
- Create: `app/api/analytics/live-commerce/[id]/route.ts`
- Modify: `vercel.json`
- Reference: `app/api/analytics/md-strategy/route.ts`, `app/api/analytics/md-strategy/[id]/route.ts`

- [ ] **Step 1: Create the SSE + list endpoint**

```typescript
// app/api/analytics/live-commerce/route.ts
import { NextRequest } from "next/server";
import { fetchLCContext, runLCOrchestrator } from "@/lib/live-commerce-strategy";
import { getServiceClient } from "@/lib/supabase";
import type { LCProgressEvent } from "@/lib/live-commerce-strategy";

export const maxDuration = 300;

// GET: List saved strategies
export async function GET() {
	const supabase = getServiceClient();
	const { data, error } = await supabase
		.from("live_commerce_strategies")
		.select("id, user_goal, target_platforms, created_at")
		.order("created_at", { ascending: false })
		.limit(20);

	if (error) {
		return Response.json({ error: error.message }, { status: 500 });
	}
	return Response.json({ strategies: data ?? [] });
}

// POST: Generate new strategy via SSE
export async function POST(request: NextRequest) {
	const body = await request.json().catch(() => ({}));
	const userGoal: string = body.userGoal || "";
	const targetPlatforms: string[] | undefined = body.targetPlatforms;

	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			};

			const heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(`: heartbeat\n\n`));
				} catch {
					clearInterval(heartbeat);
				}
			}, 10000);

			try {
				// Phase 1: Data fetch (Brave Search)
				send("progress", { skill: "data_fetch", status: "running", index: -1, total: 6 });
				const context = await fetchLCContext(userGoal || undefined, targetPlatforms);
				send("progress", { skill: "data_fetch", status: "complete", index: -1, total: 6 });

				// Phase 2: Skill pipeline
				const result = await runLCOrchestrator(context, (event: LCProgressEvent) => {
					if (event.status === "complete" && event.data) {
						send("skill_result", { skill: event.skill, index: event.index, total: event.total, data: event.data });
					} else if (event.status === "error") {
						send("skill_error", { skill: event.skill, index: event.index, total: event.total, error: event.error });
					} else {
						send("progress", event);
					}
				});

				// Phase 3: Save to Supabase
				let strategyId: string | null = null;
				try {
					const supabase = getServiceClient();
					const { data: inserted, error: insertError } = await supabase
						.from("live_commerce_strategies")
						.insert({
							user_goal: userGoal || null,
							target_platforms: targetPlatforms ?? context.parsedGoal?.target_platforms ?? null,
							market_research: result.market_research as unknown as Record<string, unknown>,
							platform_analysis: result.platform_analysis as unknown as Record<string, unknown>,
							content_strategy: result.content_strategy as unknown as Record<string, unknown>,
							execution_plan: result.execution_plan as unknown as Record<string, unknown>,
							risk_analysis: result.risk_analysis as unknown as Record<string, unknown>,
							search_sources: context.searchSources as unknown as Record<string, unknown>[],
						})
						.select("id")
						.single();

					if (insertError) {
						console.error("[live-commerce] Save failed:", insertError.message);
					} else {
						strategyId = inserted?.id ?? null;
					}
				} catch (saveErr) {
					console.error("[live-commerce] Save error:", saveErr);
				}

				send("complete", { generatedAt: new Date().toISOString(), strategyId });
			} catch (err) {
				send("error", { message: err instanceof Error ? err.message : String(err) });
			} finally {
				clearInterval(heartbeat);
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}
```

- [ ] **Step 2: Create the load/delete endpoint**

```typescript
// app/api/analytics/live-commerce/[id]/route.ts
import { NextRequest } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const supabase = getServiceClient();

	const { data, error } = await supabase
		.from("live_commerce_strategies")
		.select("*")
		.eq("id", id)
		.single();

	if (error || !data) {
		return Response.json({ error: error?.message ?? "Not found" }, { status: 404 });
	}
	return Response.json(data);
}

export async function DELETE(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const supabase = getServiceClient();

	const { error } = await supabase
		.from("live_commerce_strategies")
		.delete()
		.eq("id", id);

	if (error) {
		return Response.json({ error: error.message }, { status: 500 });
	}
	return Response.json({ ok: true });
}
```

- [ ] **Step 3: Add timeout to vercel.json**

Add to the `functions` object in `vercel.json`:

```json
"app/api/analytics/live-commerce/route.ts": {
  "maxDuration": 300
}
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add app/api/analytics/live-commerce/route.ts app/api/analytics/live-commerce/\[id\]/route.ts vercel.json
git commit -m "feat(live-commerce): add SSE API routes and vercel timeout config"
```

---

### Task 4: UI — Result Section Components

**Files:**
- Create: `components/analytics/live-commerce/MarketOverviewSection.tsx`
- Create: `components/analytics/live-commerce/PlatformAnalysisSection.tsx`
- Create: `components/analytics/live-commerce/ContentStrategySection.tsx`
- Create: `components/analytics/live-commerce/ExecutionPlanSection.tsx`
- Create: `components/analytics/live-commerce/RiskAnalysisSection.tsx`
- Reference: `components/analytics/md-strategy/ChannelStrategySection.tsx`, `components/analytics/md-strategy/RiskContingencySection.tsx`

- [ ] **Step 1: Create MarketOverviewSection**

```typescript
// components/analytics/live-commerce/MarketOverviewSection.tsx
'use client';

import { Card, CardContent } from '@/components/ui/card';
import { TrendingUp, Users, Globe, Lightbulb } from 'lucide-react';
import type { MarketResearchOutput } from '@/lib/live-commerce-strategy';

interface Props {
	data: MarketResearchOutput;
}

export default function MarketOverviewSection({ data }: Props) {
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<Globe size={18} className="text-emerald-600" />
				<h3 className="text-lg font-bold text-gray-900">市場概況</h3>
			</div>

			{/* Key stats */}
			<div className="grid grid-cols-2 gap-3">
				<Card className="border-emerald-200 bg-emerald-50/30">
					<CardContent className="p-3 text-center">
						<div className="text-[10px] text-gray-500 uppercase font-semibold">市場規模</div>
						<div className="text-lg font-bold text-emerald-700 mt-1">{data.market_size}</div>
					</CardContent>
				</Card>
				<Card className="border-emerald-200 bg-emerald-50/30">
					<CardContent className="p-3 text-center">
						<div className="text-[10px] text-gray-500 uppercase font-semibold">成長率</div>
						<div className="text-lg font-bold text-emerald-700 mt-1">{data.growth_rate}</div>
					</CardContent>
				</Card>
			</div>

			{/* Consumer behavior */}
			<Card className="border-gray-200">
				<CardContent className="p-4">
					<div className="flex items-center gap-1.5 mb-2">
						<Users size={14} className="text-blue-600" />
						<span className="text-xs font-semibold text-gray-600">消費者行動</span>
					</div>
					<p className="text-sm text-gray-700 leading-relaxed">{data.consumer_behavior}</p>
				</CardContent>
			</Card>

			{/* Key trends */}
			<Card className="border-gray-200">
				<CardContent className="p-4">
					<div className="flex items-center gap-1.5 mb-3">
						<TrendingUp size={14} className="text-orange-600" />
						<span className="text-xs font-semibold text-gray-600">主要トレンド</span>
					</div>
					<div className="space-y-2">
						{(data.key_trends ?? []).map((t, i) => (
							<div key={i} className="flex items-start gap-2">
								<span className="bg-orange-100 text-orange-700 rounded-full w-5 h-5 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">{i + 1}</span>
								<div>
									<span className="text-sm font-medium text-gray-800">{t.trend}</span>
									<p className="text-xs text-gray-500 mt-0.5">{t.description}</p>
								</div>
							</div>
						))}
					</div>
				</CardContent>
			</Card>

			{/* Major players */}
			<Card className="border-gray-200">
				<CardContent className="p-4">
					<div className="flex items-center gap-1.5 mb-3">
						<Lightbulb size={14} className="text-purple-600" />
						<span className="text-xs font-semibold text-gray-600">主要プレイヤー</span>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-2">
						{(data.major_players ?? []).map((p, i) => (
							<div key={i} className="bg-gray-50 rounded-lg p-2.5 border border-gray-100">
								<div className="flex items-center gap-2 mb-1">
									<span className="text-sm font-medium text-gray-800">{p.name}</span>
									<span className="text-[9px] px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded">{p.platform}</span>
								</div>
								<p className="text-xs text-gray-500">{p.description}</p>
							</div>
						))}
					</div>
				</CardContent>
			</Card>

			{/* Market outlook */}
			<div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
				<span className="text-xs font-semibold text-emerald-700">市場見通し</span>
				<p className="text-sm text-gray-700 mt-1 leading-relaxed">{data.market_outlook}</p>
			</div>
		</div>
	);
}
```

- [ ] **Step 2: Create PlatformAnalysisSection**

```typescript
// components/analytics/live-commerce/PlatformAnalysisSection.tsx
'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Monitor, ChevronDown, ChevronUp, Star } from 'lucide-react';
import type { PlatformAnalysisOutput } from '@/lib/live-commerce-strategy';

interface Props {
	data: PlatformAnalysisOutput;
}

function scoreColor(score: number): string {
	if (score >= 80) return 'text-green-700 bg-green-50 border-green-200';
	if (score >= 60) return 'text-blue-700 bg-blue-50 border-blue-200';
	if (score >= 40) return 'text-yellow-700 bg-yellow-50 border-yellow-200';
	return 'text-red-700 bg-red-50 border-red-200';
}

export default function PlatformAnalysisSection({ data }: Props) {
	const [expanded, setExpanded] = useState<string | null>(null);

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<Monitor size={18} className="text-blue-600" />
				<h3 className="text-lg font-bold text-gray-900">プラットフォーム分析</h3>
			</div>

			{/* Priority order */}
			{(data.recommended_priority ?? []).length > 0 && (
				<div className="flex items-center gap-2 flex-wrap">
					<span className="text-xs font-semibold text-gray-500">推奨優先度:</span>
					{data.recommended_priority.map((name, i) => (
						<span key={name} className="flex items-center gap-1 text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full border border-blue-200">
							<Star size={10} className={i === 0 ? 'fill-blue-600' : ''} />
							{name}
						</span>
					))}
				</div>
			)}

			{/* Platform cards */}
			<div className="space-y-3">
				{(data.platforms ?? []).map((platform) => {
					const isExpanded = expanded === platform.name;
					return (
						<Card key={platform.name} className="border-gray-200">
							<button
								type="button"
								onClick={() => setExpanded(isExpanded ? null : platform.name)}
								className="w-full text-left"
							>
								<CardContent className="p-4">
									<div className="flex items-center justify-between">
										<div className="flex items-center gap-3">
											<span className={`text-sm font-bold px-2.5 py-1 rounded-lg border ${scoreColor(platform.fit_score)}`}>
												{platform.fit_score}
											</span>
											<div>
												<span className="text-sm font-semibold text-gray-900">{platform.name}</span>
												<p className="text-xs text-gray-500">{platform.user_base}</p>
											</div>
										</div>
										{isExpanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
									</div>

									{isExpanded && (
										<div className="mt-4 space-y-3 border-t border-gray-100 pt-3">
											<div className="text-xs text-gray-500">
												<span className="font-semibold">手数料:</span> {platform.commission_structure}
											</div>

											<div className="grid grid-cols-2 gap-3">
												<div>
													<span className="text-[10px] font-semibold text-green-600 uppercase">強み</span>
													<ul className="mt-1 space-y-0.5">
														{(platform.strengths ?? []).map((s, i) => (
															<li key={i} className="text-xs text-gray-600 flex items-start gap-1">
																<span className="text-green-500 mt-0.5">+</span>{s}
															</li>
														))}
													</ul>
												</div>
												<div>
													<span className="text-[10px] font-semibold text-red-600 uppercase">弱み</span>
													<ul className="mt-1 space-y-0.5">
														{(platform.weaknesses ?? []).map((w, i) => (
															<li key={i} className="text-xs text-gray-600 flex items-start gap-1">
																<span className="text-red-500 mt-0.5">-</span>{w}
															</li>
														))}
													</ul>
												</div>
											</div>

											{(platform.success_cases ?? []).length > 0 && (
												<div>
													<span className="text-[10px] font-semibold text-purple-600 uppercase">成功事例</span>
													<div className="mt-1 space-y-1.5">
														{platform.success_cases.map((c, i) => (
															<div key={i} className="bg-purple-50/50 rounded-lg p-2 border border-purple-100">
																<span className="text-xs font-medium text-gray-800">{c.brand}</span>
																<p className="text-[11px] text-gray-500">{c.description}</p>
																<p className="text-[11px] text-purple-700 font-medium mt-0.5">{c.result}</p>
															</div>
														))}
													</div>
												</div>
											)}

											{(platform.entry_steps ?? []).length > 0 && (
												<div>
													<span className="text-[10px] font-semibold text-blue-600 uppercase">参入ステップ</span>
													<ol className="mt-1 space-y-0.5">
														{platform.entry_steps.map((step, i) => (
															<li key={i} className="text-xs text-gray-600 flex items-start gap-1.5">
																<span className="bg-blue-100 text-blue-700 rounded-full w-4 h-4 flex items-center justify-center text-[9px] shrink-0 mt-0.5">{i + 1}</span>
																{step}
															</li>
														))}
													</ol>
												</div>
											)}
										</div>
									)}
								</CardContent>
							</button>
						</Card>
					);
				})}
			</div>

			{/* Comparison summary */}
			{data.comparison_summary && (
				<div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
					<span className="text-xs font-semibold text-blue-700">比較総括</span>
					<p className="text-sm text-gray-700 mt-1 leading-relaxed">{data.comparison_summary}</p>
				</div>
			)}
		</div>
	);
}
```

- [ ] **Step 3: Create ContentStrategySection**

```typescript
// components/analytics/live-commerce/ContentStrategySection.tsx
'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Video, Clock, Mic, Zap } from 'lucide-react';
import type { ContentStrategyOutput } from '@/lib/live-commerce-strategy';

interface Props {
	data: ContentStrategyOutput;
}

export default function ContentStrategySection({ data }: Props) {
	const platforms = data.platforms ?? [];
	const [activeTab, setActiveTab] = useState(platforms[0]?.name ?? '');

	const activePlatform = platforms.find((p) => p.name === activeTab);

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<Video size={18} className="text-pink-600" />
				<h3 className="text-lg font-bold text-gray-900">コンテンツ戦略</h3>
			</div>

			{/* Platform tabs */}
			{platforms.length > 0 && (
				<div className="flex gap-1 p-1 bg-gray-100 rounded-xl overflow-x-auto">
					{platforms.map((p) => (
						<button
							key={p.name}
							type="button"
							onClick={() => setActiveTab(p.name)}
							className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all whitespace-nowrap ${
								activeTab === p.name ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
							}`}
						>
							{p.name}
						</button>
					))}
				</div>
			)}

			{activePlatform && (
				<div className="space-y-3">
					{/* Format + timing + frequency */}
					<div className="grid grid-cols-3 gap-2">
						<Card className="border-gray-200">
							<CardContent className="p-3">
								<div className="flex items-center gap-1 mb-1">
									<Video size={12} className="text-pink-500" />
									<span className="text-[10px] font-semibold text-gray-500">配信形式</span>
								</div>
								<p className="text-xs text-gray-700">{activePlatform.broadcast_format}</p>
							</CardContent>
						</Card>
						<Card className="border-gray-200">
							<CardContent className="p-3">
								<div className="flex items-center gap-1 mb-1">
									<Clock size={12} className="text-blue-500" />
									<span className="text-[10px] font-semibold text-gray-500">最適時間帯</span>
								</div>
								<div className="space-y-0.5">
									{(activePlatform.optimal_times ?? []).map((t, i) => (
										<p key={i} className="text-xs text-gray-700">{t}</p>
									))}
								</div>
							</CardContent>
						</Card>
						<Card className="border-gray-200">
							<CardContent className="p-3">
								<div className="flex items-center gap-1 mb-1">
									<Mic size={12} className="text-purple-500" />
									<span className="text-[10px] font-semibold text-gray-500">配信頻度</span>
								</div>
								<p className="text-xs text-gray-700">{activePlatform.frequency}</p>
							</CardContent>
						</Card>
					</div>

					{/* Host style */}
					<div className="bg-pink-50 border border-pink-200 rounded-lg p-3">
						<span className="text-[10px] font-semibold text-pink-600 uppercase">推奨ホストスタイル</span>
						<p className="text-sm text-gray-700 mt-1">{activePlatform.host_style}</p>
					</div>

					{/* Content ideas */}
					<Card className="border-gray-200">
						<CardContent className="p-4">
							<div className="flex items-center gap-1.5 mb-3">
								<Zap size={14} className="text-yellow-600" />
								<span className="text-xs font-semibold text-gray-600">コンテンツ企画</span>
							</div>
							<div className="space-y-2">
								{(activePlatform.content_ideas ?? []).map((idea, i) => (
									<div key={i} className="bg-gray-50 rounded-lg p-2.5 border border-gray-100">
										<div className="flex items-center gap-2 mb-0.5">
											<span className="text-xs font-medium text-gray-800">{idea.title}</span>
											<span className="text-[9px] px-1.5 py-0.5 bg-yellow-50 text-yellow-700 rounded">{idea.format}</span>
										</div>
										<p className="text-[11px] text-gray-500">{idea.description}</p>
									</div>
								))}
							</div>
						</CardContent>
					</Card>

					{/* Engagement tactics */}
					<Card className="border-gray-200">
						<CardContent className="p-4">
							<span className="text-xs font-semibold text-gray-600">エンゲージメント施策</span>
							<ul className="mt-2 space-y-1">
								{(activePlatform.engagement_tactics ?? []).map((t, i) => (
									<li key={i} className="text-xs text-gray-600 flex items-start gap-1.5">
										<span className="text-pink-500 mt-0.5">&#x25CF;</span>{t}
									</li>
								))}
							</ul>
						</CardContent>
					</Card>

					{/* Script outline */}
					{activePlatform.sample_script_outline && (
						<Card className="border-gray-200">
							<CardContent className="p-4">
								<span className="text-xs font-semibold text-gray-600">サンプルスクリプト</span>
								<p className="text-sm text-gray-700 mt-2 whitespace-pre-line leading-relaxed bg-gray-50 rounded-lg p-3 border border-gray-100">
									{activePlatform.sample_script_outline}
								</p>
							</CardContent>
						</Card>
					)}
				</div>
			)}

			{/* Cross-platform strategy */}
			{data.cross_platform_strategy && (
				<div className="bg-pink-50 border border-pink-200 rounded-lg p-4">
					<span className="text-xs font-semibold text-pink-700">クロスプラットフォーム戦略</span>
					<p className="text-sm text-gray-700 mt-1 leading-relaxed">{data.cross_platform_strategy}</p>
				</div>
			)}
		</div>
	);
}
```

- [ ] **Step 4: Create ExecutionPlanSection**

```typescript
// components/analytics/live-commerce/ExecutionPlanSection.tsx
'use client';

import { Card, CardContent } from '@/components/ui/card';
import { CalendarDays, DollarSign, UserPlus, Wrench } from 'lucide-react';
import type { ExecutionPlanOutput } from '@/lib/live-commerce-strategy';

interface Props {
	data: ExecutionPlanOutput;
}

const PHASE_COLORS = [
	{ bg: 'bg-blue-50', border: 'border-blue-200', badge: 'bg-blue-600', text: 'text-blue-700' },
	{ bg: 'bg-green-50', border: 'border-green-200', badge: 'bg-green-600', text: 'text-green-700' },
	{ bg: 'bg-yellow-50', border: 'border-yellow-200', badge: 'bg-yellow-600', text: 'text-yellow-700' },
	{ bg: 'bg-purple-50', border: 'border-purple-200', badge: 'bg-purple-600', text: 'text-purple-700' },
];

export default function ExecutionPlanSection({ data }: Props) {
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<CalendarDays size={18} className="text-indigo-600" />
				<h3 className="text-lg font-bold text-gray-900">実行ロードマップ</h3>
			</div>

			{/* Total investment */}
			{data.total_investment && (
				<div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 flex items-center gap-2">
					<DollarSign size={16} className="text-indigo-600" />
					<span className="text-sm font-semibold text-indigo-700">初年度総投資: {data.total_investment}</span>
				</div>
			)}

			{/* Phases */}
			<div className="space-y-4">
				{(data.phases ?? []).map((phase, i) => {
					const color = PHASE_COLORS[i % PHASE_COLORS.length];
					return (
						<Card key={i} className={`${color.border} ${color.bg}/30`}>
							<CardContent className="p-4">
								<div className="flex items-center gap-2 mb-3">
									<span className={`${color.badge} text-white rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold`}>{i + 1}</span>
									<div>
										<span className="text-sm font-semibold text-gray-900">{phase.phase}</span>
										<span className="text-xs text-gray-500 ml-2">{phase.period}</span>
									</div>
									{phase.budget && (
										<span className="ml-auto text-xs font-mono text-gray-500">{phase.budget}</span>
									)}
								</div>

								{/* Objectives */}
								<div className="mb-3">
									<span className="text-[10px] font-semibold text-gray-500 uppercase">目標</span>
									<ul className="mt-1 space-y-0.5">
										{(phase.objectives ?? []).map((obj, j) => (
											<li key={j} className="text-xs text-gray-700 flex items-start gap-1">
												<span className={`${color.text} mt-0.5`}>&#x25B6;</span>{obj}
											</li>
										))}
									</ul>
								</div>

								{/* Actions */}
								<div className="mb-3">
									<span className="text-[10px] font-semibold text-gray-500 uppercase">アクション</span>
									<div className="mt-1 space-y-1">
										{(phase.actions ?? []).map((a, j) => (
											<div key={j} className="flex items-center gap-2 text-xs bg-white/60 rounded px-2 py-1 border border-gray-100">
												<span className="text-gray-700 flex-1">{a.action}</span>
												<span className="text-gray-400 shrink-0">{a.owner}</span>
												<span className="text-gray-400 shrink-0">{a.deadline}</span>
											</div>
										))}
									</div>
								</div>

								{/* KPIs */}
								{(phase.kpis ?? []).length > 0 && (
									<div>
										<span className="text-[10px] font-semibold text-gray-500 uppercase">KPI</span>
										<div className="mt-1 flex flex-wrap gap-2">
											{phase.kpis.map((kpi, j) => (
												<span key={j} className="text-[11px] px-2 py-0.5 bg-white rounded border border-gray-200">
													{kpi.metric}: <span className="font-medium">{kpi.target}</span>
												</span>
											))}
										</div>
									</div>
								)}
							</CardContent>
						</Card>
					);
				})}
			</div>

			{/* Staffing */}
			{(data.staffing ?? []).length > 0 && (
				<Card className="border-gray-200">
					<CardContent className="p-4">
						<div className="flex items-center gap-1.5 mb-2">
							<UserPlus size={14} className="text-indigo-600" />
							<span className="text-xs font-semibold text-gray-600">人員計画</span>
						</div>
						<div className="space-y-1">
							{data.staffing.map((s, i) => (
								<div key={i} className="flex items-center gap-3 text-xs bg-gray-50 rounded px-2 py-1.5 border border-gray-100">
									<span className="font-medium text-gray-800">{s.role}</span>
									<span className="text-gray-400">{s.type}</span>
									<span className="ml-auto text-gray-500">{s.timing}</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Tools */}
			{(data.tools_and_services ?? []).length > 0 && (
				<Card className="border-gray-200">
					<CardContent className="p-4">
						<div className="flex items-center gap-1.5 mb-2">
							<Wrench size={14} className="text-gray-600" />
							<span className="text-xs font-semibold text-gray-600">ツール・サービス</span>
						</div>
						<div className="space-y-1">
							{data.tools_and_services.map((t, i) => (
								<div key={i} className="flex items-center gap-3 text-xs bg-gray-50 rounded px-2 py-1.5 border border-gray-100">
									<span className="font-medium text-gray-800">{t.name}</span>
									<span className="text-gray-500 flex-1">{t.purpose}</span>
									<span className="font-mono text-gray-500 shrink-0">{t.cost}</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
```

- [ ] **Step 5: Create RiskAnalysisSection**

```typescript
// components/analytics/live-commerce/RiskAnalysisSection.tsx
'use client';

import { Card, CardContent } from '@/components/ui/card';
import { ShieldAlert, CheckCircle } from 'lucide-react';
import type { RiskAnalysisOutput } from '@/lib/live-commerce-strategy';

interface Props {
	data: RiskAnalysisOutput;
}

function severityBadge(level: string): string {
	switch (level) {
		case 'high': return 'bg-red-100 text-red-700 border-red-200';
		case 'medium': return 'bg-yellow-100 text-yellow-700 border-yellow-200';
		case 'low': return 'bg-green-100 text-green-700 border-green-200';
		default: return 'bg-gray-100 text-gray-600 border-gray-200';
	}
}

function levelLabel(level: string): string {
	switch (level) {
		case 'high': return '高';
		case 'medium': return '中';
		case 'low': return '低';
		default: return level;
	}
}

export default function RiskAnalysisSection({ data }: Props) {
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<ShieldAlert size={18} className="text-red-600" />
				<h3 className="text-lg font-bold text-gray-900">リスク分析</h3>
			</div>

			{/* Risk cards */}
			<div className="space-y-2">
				{(data.risks ?? []).map((risk, i) => (
					<Card key={i} className="border-gray-200">
						<CardContent className="p-3">
							<div className="flex items-start gap-3">
								<div className="flex flex-col gap-1 shrink-0">
									<span className={`text-[9px] px-1.5 py-0.5 rounded border font-medium ${severityBadge(risk.severity)}`}>
										深刻度: {levelLabel(risk.severity)}
									</span>
									<span className={`text-[9px] px-1.5 py-0.5 rounded border font-medium ${severityBadge(risk.probability)}`}>
										発生率: {levelLabel(risk.probability)}
									</span>
								</div>
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2 mb-0.5">
										<span className="text-[9px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded">{risk.category}</span>
									</div>
									<p className="text-xs text-gray-800 font-medium">{risk.description}</p>
									<p className="text-[11px] text-gray-500 mt-1">
										<span className="font-medium text-blue-600">対策:</span> {risk.mitigation}
									</p>
								</div>
							</div>
						</CardContent>
					</Card>
				))}
			</div>

			{/* Contingency plans */}
			{(data.contingency_plans ?? []).length > 0 && (
				<Card className="border-orange-200 bg-orange-50/20">
					<CardContent className="p-4">
						<span className="text-xs font-semibold text-orange-700">コンティンジェンシープラン</span>
						<div className="mt-2 space-y-2">
							{data.contingency_plans.map((cp, i) => (
								<div key={i} className="bg-white rounded-lg p-2.5 border border-orange-100">
									<p className="text-xs font-medium text-gray-800">シナリオ: {cp.scenario}</p>
									<p className="text-[11px] text-gray-500 mt-0.5">対応: {cp.response}</p>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Success factors */}
			{(data.success_factors ?? []).length > 0 && (
				<Card className="border-green-200 bg-green-50/20">
					<CardContent className="p-4">
						<div className="flex items-center gap-1.5 mb-2">
							<CheckCircle size={14} className="text-green-600" />
							<span className="text-xs font-semibold text-green-700">成功の重要要因</span>
						</div>
						<ul className="space-y-1">
							{data.success_factors.map((f, i) => (
								<li key={i} className="text-xs text-gray-700 flex items-start gap-1.5">
									<span className="text-green-500 mt-0.5">&#x2713;</span>{f}
								</li>
							))}
						</ul>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
```

- [ ] **Step 6: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add components/analytics/live-commerce/
git commit -m "feat(live-commerce): add 5 result section components"
```

---

### Task 5: UI — LiveCommercePanel + Dashboard Integration

**Files:**
- Create: `components/analytics/LiveCommercePanel.tsx`
- Modify: `components/analytics/AnalyticsDashboard.tsx`
- Reference: `components/analytics/MDStrategyPanel.tsx` (SSE client, view modes, history pattern)

- [ ] **Step 1: Create LiveCommercePanel**

```typescript
// components/analytics/LiveCommercePanel.tsx
'use client';

import { useState, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, Radio, AlertTriangle, ArrowLeft, ExternalLink } from 'lucide-react';
import { CheckCircle, Circle } from 'lucide-react';
import type {
	LCSkillName,
	ParsedGoal,
	MarketResearchOutput,
	PlatformAnalysisOutput,
	ContentStrategyOutput,
	ExecutionPlanOutput,
	RiskAnalysisOutput,
} from '@/lib/live-commerce-strategy';
import { LC_SKILL_META } from '@/lib/live-commerce-strategy';

import dynamic from 'next/dynamic';
const MarketOverviewSection = dynamic(() => import('./live-commerce/MarketOverviewSection'), { ssr: false });
const PlatformAnalysisSection = dynamic(() => import('./live-commerce/PlatformAnalysisSection'), { ssr: false });
const ContentStrategySection = dynamic(() => import('./live-commerce/ContentStrategySection'), { ssr: false });
const ExecutionPlanSection = dynamic(() => import('./live-commerce/ExecutionPlanSection'), { ssr: false });
const RiskAnalysisSection = dynamic(() => import('./live-commerce/RiskAnalysisSection'), { ssr: false });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SkillStatus = 'pending' | 'running' | 'complete' | 'error';

interface SkillResults {
	goal_analysis?: ParsedGoal | null;
	market_research?: MarketResearchOutput;
	platform_analysis?: PlatformAnalysisOutput;
	content_strategy?: ContentStrategyOutput;
	execution_plan?: ExecutionPlanOutput;
	risk_analysis?: RiskAnalysisOutput;
}

const INITIAL_STATUSES: Record<LCSkillName, SkillStatus> = {
	goal_analysis: 'pending',
	market_research: 'pending',
	platform_analysis: 'pending',
	content_strategy: 'pending',
	execution_plan: 'pending',
	risk_analysis: 'pending',
};

const LC_SKILL_ORDER: LCSkillName[] = [
	'goal_analysis', 'market_research', 'platform_analysis',
	'content_strategy', 'execution_plan', 'risk_analysis',
];

const PLATFORMS = ['TikTok Live', 'Instagram Live', 'YouTube Live', '楽天ROOM LIVE', 'Yahoo!ショッピング LIVE'];

// ---------------------------------------------------------------------------
// Progress component
// ---------------------------------------------------------------------------

function LCProgress({ skillStatuses, dataFetchStatus }: {
	skillStatuses: Record<LCSkillName, SkillStatus>;
	dataFetchStatus: 'pending' | 'running' | 'complete';
}) {
	return (
		<div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
			<h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">分析進捗</h4>
			<div className="flex items-center gap-3 mb-2 pb-2 border-b border-gray-100">
				<StatusIcon status={dataFetchStatus} />
				<span className={`text-sm ${dataFetchStatus === 'running' ? 'text-blue-700 font-medium' : 'text-gray-600'}`}>
					ウェブリサーチ
				</span>
			</div>
			<div className="space-y-1.5">
				{LC_SKILL_ORDER.map((skill, i) => {
					const status = skillStatuses[skill];
					const meta = LC_SKILL_META[skill];
					return (
						<div key={skill} className="flex items-center gap-3">
							<div className="relative flex items-center justify-center w-5">
								{i > 0 && (
									<div className={`absolute -top-2.5 w-px h-2.5 ${
										skillStatuses[LC_SKILL_ORDER[i - 1]] === 'complete' ? 'bg-green-300' : 'bg-gray-200'
									}`} />
								)}
								<StatusIcon status={status} />
							</div>
							<div className="flex items-center gap-2 flex-1 min-w-0">
								<span className={`text-sm truncate ${
									status === 'running' ? 'text-blue-700 font-medium' :
									status === 'complete' ? 'text-gray-700' :
									status === 'error' ? 'text-red-600' : 'text-gray-400'
								}`}>
									{meta.labelJa}
								</span>
								{status === 'running' && (
									<span className="text-[10px] text-blue-500 animate-pulse">分析中...</span>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function StatusIcon({ status }: { status: string }) {
	switch (status) {
		case 'complete': return <CheckCircle size={16} className="text-green-500 shrink-0" />;
		case 'running': return <Loader2 size={16} className="text-blue-600 animate-spin shrink-0" />;
		case 'error': return <AlertTriangle size={16} className="text-red-500 shrink-0" />;
		default: return <Circle size={16} className="text-gray-300 shrink-0" />;
	}
}

// ---------------------------------------------------------------------------
// Sources component
// ---------------------------------------------------------------------------

function SourcesCited({ sources }: { sources?: Array<{ title: string; url: string }> }) {
	if (!sources || sources.length === 0) return null;
	const unique = sources.filter((s, i, arr) => arr.findIndex((x) => x.url === s.url) === i).slice(0, 20);
	return (
		<div className="border-t border-gray-100 pt-3 mt-4">
			<span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">出典</span>
			<div className="mt-1 space-y-0.5">
				{unique.map((s, i) => (
					<a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
						className="flex items-center gap-1.5 text-[10px] text-blue-500 hover:text-blue-700 hover:underline truncate">
						<span className="text-gray-400 font-mono shrink-0">[{i + 1}]</span>
						<ExternalLink size={9} className="shrink-0" />
						<span className="truncate">{s.title || s.url}</span>
					</a>
				))}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// History component
// ---------------------------------------------------------------------------

type StrategySummary = {
	id: string;
	user_goal: string | null;
	target_platforms: string[] | null;
	created_at: string;
};

function LCHistory({ onView, refreshKey }: { onView: (id: string) => void; refreshKey: number }) {
	const [strategies, setStrategies] = useState<StrategySummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [deleting, setDeleting] = useState<string | null>(null);

	const fetchList = useCallback(async () => {
		setLoading(true);
		try {
			const res = await fetch('/api/analytics/live-commerce');
			const data = await res.json();
			setStrategies(data.strategies ?? []);
		} catch { /* silent */ } finally {
			setLoading(false);
		}
	}, []);

	// eslint-disable-next-line react-hooks/exhaustive-deps
	useState(() => { fetchList(); });
	// Re-fetch when refreshKey changes
	// Using a simple approach: track the key
	const [prevKey, setPrevKey] = useState(refreshKey);
	if (prevKey !== refreshKey) {
		setPrevKey(refreshKey);
		fetchList();
	}

	const handleDelete = async (id: string) => {
		if (!confirm('この戦略を削除しますか？')) return;
		setDeleting(id);
		try {
			const res = await fetch(`/api/analytics/live-commerce/${id}`, { method: 'DELETE' });
			if (res.ok) setStrategies((prev) => prev.filter((s) => s.id !== id));
		} catch { /* silent */ } finally {
			setDeleting(null);
		}
	};

	if (loading) {
		return <div className="flex items-center gap-2 py-4 text-sm text-gray-400"><Loader2 size={14} className="animate-spin" />履歴を読み込み中...</div>;
	}
	if (strategies.length === 0) return null;

	return (
		<Card className="border-gray-200">
			<CardContent className="p-4">
				<span className="text-sm font-semibold text-gray-700 flex items-center gap-1.5 mb-3">
					過去のライブコマース戦略
				</span>
				<div className="space-y-2">
					{strategies.map((s) => (
						<div key={s.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-100 hover:border-gray-200 transition-colors">
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2 mb-0.5">
									<span className="text-xs font-mono text-gray-500">
										{new Date(s.created_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
									</span>
									{(s.target_platforms ?? []).slice(0, 2).map((p) => (
										<span key={p} className="text-[9px] px-1.5 py-0.5 bg-pink-50 text-pink-700 rounded">{p}</span>
									))}
								</div>
								<p className="text-xs text-gray-600 truncate">{s.user_goal || '目標指定なし'}</p>
							</div>
							<div className="flex items-center gap-1.5 shrink-0">
								<button type="button" onClick={() => onView(s.id)}
									className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors">
									表示
								</button>
								<button type="button" onClick={() => handleDelete(s.id)} disabled={deleting === s.id}
									className="flex items-center gap-1 px-2 py-1.5 text-xs text-red-500 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50">
									{deleting === s.id ? <Loader2 size={12} className="animate-spin" /> : '削除'}
								</button>
							</div>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}

// ---------------------------------------------------------------------------
// Results view
// ---------------------------------------------------------------------------

function ResultsView({ results, sources, generatedAt, onBack }: {
	results: SkillResults;
	sources?: Array<{ title: string; url: string }>;
	generatedAt?: string | null;
	onBack: () => void;
}) {
	return (
		<>
			<button type="button" onClick={onBack} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors mb-2">
				<ArrowLeft size={14} />一覧に戻る
			</button>
			<div id="lc-strategy-content" className="space-y-8">
				{results.market_research && <MarketOverviewSection data={results.market_research} />}
				{results.platform_analysis && <PlatformAnalysisSection data={results.platform_analysis} />}
				{results.content_strategy && <ContentStrategySection data={results.content_strategy} />}
				{results.execution_plan && <ExecutionPlanSection data={results.execution_plan} />}
				{results.risk_analysis && <RiskAnalysisSection data={results.risk_analysis} />}
				<SourcesCited sources={sources} />
			</div>
			{generatedAt && (
				<p className="text-[10px] text-gray-400">生成: {new Date(generatedAt).toLocaleString('ja-JP')}</p>
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function LiveCommercePanel() {
	const [viewMode, setViewMode] = useState<'form' | 'generating' | 'saved'>('form');
	const [userGoal, setUserGoal] = useState('');
	const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);

	const [status, setStatus] = useState<'idle' | 'running' | 'complete' | 'error'>('idle');
	const [dataFetchStatus, setDataFetchStatus] = useState<'pending' | 'running' | 'complete'>('pending');
	const [skillStatuses, setSkillStatuses] = useState<Record<LCSkillName, SkillStatus>>({ ...INITIAL_STATUSES });
	const [skillResults, setSkillResults] = useState<SkillResults>({});
	const [searchSources, setSearchSources] = useState<Array<{ title: string; url: string }>>([]);
	const [error, setError] = useState<string | null>(null);
	const [generatedAt, setGeneratedAt] = useState<string | null>(null);

	const [savedResults, setSavedResults] = useState<SkillResults>({});
	const [savedSources, setSavedSources] = useState<Array<{ title: string; url: string }>>([]);
	const [savedAt, setSavedAt] = useState<string | null>(null);
	const [loadingStrategy, setLoadingStrategy] = useState(false);
	const [historyRefresh, setHistoryRefresh] = useState(0);

	const togglePlatform = (p: string) => {
		setSelectedPlatforms((prev) =>
			prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
		);
	};

	const handleGenerate = useCallback(async () => {
		setViewMode('generating');
		setStatus('running');
		setError(null);
		setSkillResults({});
		setSkillStatuses({ ...INITIAL_STATUSES });
		setDataFetchStatus('pending');
		setGeneratedAt(null);
		setSearchSources([]);

		try {
			const res = await fetch('/api/analytics/live-commerce', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					userGoal: userGoal || undefined,
					targetPlatforms: selectedPlatforms.length > 0 ? selectedPlatforms : undefined,
				}),
			});

			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${res.status}`);
			}

			const reader = res.body?.getReader();
			if (!reader) throw new Error('No response body');

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				let eventType = '';
				for (const line of lines) {
					if (line.startsWith('event: ')) {
						eventType = line.slice(7).trim();
					} else if (line.startsWith('data: ') && eventType) {
						try {
							const payload = JSON.parse(line.slice(6));
							switch (eventType) {
								case 'progress': {
									const skill = payload.skill as string;
									if (skill === 'data_fetch') {
										setDataFetchStatus(payload.status as 'running' | 'complete');
									} else {
										setSkillStatuses((prev) => ({ ...prev, [skill]: 'running' }));
									}
									break;
								}
								case 'skill_result': {
									const skill = payload.skill as LCSkillName;
									setSkillStatuses((prev) => ({ ...prev, [skill]: 'complete' }));
									setSkillResults((prev) => ({ ...prev, [skill]: payload.data }));
									break;
								}
								case 'skill_error': {
									const skill = payload.skill as LCSkillName;
									setSkillStatuses((prev) => ({ ...prev, [skill]: 'error' }));
									break;
								}
								case 'complete':
									setStatus('complete');
									setGeneratedAt(payload.generatedAt as string);
									setHistoryRefresh((n) => n + 1);
									break;
								case 'error':
									setError(payload.message as string);
									setStatus('error');
									break;
							}
						} catch { /* skip */ }
						eventType = '';
					}
				}
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStatus('error');
		}
	}, [userGoal, selectedPlatforms]);

	const handleViewSaved = async (id: string) => {
		setLoadingStrategy(true);
		setError(null);
		try {
			const res = await fetch(`/api/analytics/live-commerce/${id}`);
			if (!res.ok) throw new Error('Failed to load strategy');
			const data = await res.json();
			setSavedResults({
				goal_analysis: data.goal_analysis ?? undefined,
				market_research: data.market_research ?? undefined,
				platform_analysis: data.platform_analysis ?? undefined,
				content_strategy: data.content_strategy ?? undefined,
				execution_plan: data.execution_plan ?? undefined,
				risk_analysis: data.risk_analysis ?? undefined,
			});
			setSavedSources(data.search_sources ?? []);
			setSavedAt(data.created_at);
			setViewMode('saved');
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoadingStrategy(false);
		}
	};

	const handleBackToForm = () => {
		setViewMode('form');
		setStatus('idle');
		setSkillResults({});
		setSavedResults({});
		setSavedAt(null);
		setGeneratedAt(null);
	};

	const isRunning = status === 'running';
	const hasResults = !!(
		skillResults.market_research || skillResults.platform_analysis ||
		skillResults.content_strategy || skillResults.execution_plan || skillResults.risk_analysis
	);

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-2">
				<Radio size={18} className="text-pink-600" />
				<h3 className="text-lg font-semibold text-gray-900">ライブコマース戦略</h3>
				<span className="text-[10px] px-2 py-0.5 rounded-full bg-pink-100 text-pink-700 font-medium">6-Skill AI</span>
			</div>

			{/* === FORM VIEW === */}
			{viewMode === 'form' && (
				<>
					<Card className="border-gray-200">
						<CardContent className="p-4 space-y-3">
							<div>
								<label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
									ライブコマースの目標・方向性 (任意)
								</label>
								<textarea
									value={userGoal}
									onChange={(e) => setUserGoal(e.target.value)}
									placeholder="例: TikTok Liveを中心に月商1000万円を目指したい / Instagram Liveで美容商品の販売を始めたい"
									rows={3}
									className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-300 resize-none"
								/>
							</div>

							<div>
								<label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
									対象プラットフォーム (任意・複数選択可)
								</label>
								<div className="flex flex-wrap gap-2">
									{PLATFORMS.map((p) => (
										<button
											key={p}
											type="button"
											onClick={() => togglePlatform(p)}
											className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
												selectedPlatforms.includes(p)
													? 'bg-pink-50 border-pink-300 text-pink-700 font-medium'
													: 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
											}`}
										>
											{p}
										</button>
									))}
								</div>
							</div>

							<div className="flex items-center justify-between pt-1">
								<p className="text-[10px] text-gray-400">
									6つの専門スキル（目標分析→市場調査→プラットフォーム分析→コンテンツ戦略→実行計画→リスク分析）が順次分析します
								</p>
								<button
									type="button"
									onClick={handleGenerate}
									className="flex items-center gap-2 px-5 py-2 bg-pink-600 hover:bg-pink-700 text-white text-sm font-semibold rounded-lg transition-colors shrink-0"
								>
									<Radio size={14} />
									ライブコマース戦略を分析
								</button>
							</div>
						</CardContent>
					</Card>

					<LCHistory onView={handleViewSaved} refreshKey={historyRefresh} />

					{loadingStrategy && (
						<div className="flex items-center gap-2 py-4 text-sm text-gray-500">
							<Loader2 size={14} className="animate-spin" />戦略データを読み込み中...
						</div>
					)}
				</>
			)}

			{/* === GENERATING VIEW === */}
			{viewMode === 'generating' && (
				<>
					{error && (
						<div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
							<AlertTriangle size={14} />{error}
							<button type="button" onClick={handleBackToForm} className="ml-auto text-xs underline">戻る</button>
						</div>
					)}
					{isRunning && <LCProgress skillStatuses={skillStatuses} dataFetchStatus={dataFetchStatus} />}
					{hasResults && (
						<ResultsView results={skillResults} sources={searchSources} generatedAt={generatedAt} onBack={handleBackToForm} />
					)}
				</>
			)}

			{/* === SAVED VIEW === */}
			{viewMode === 'saved' && (
				<ResultsView results={savedResults} sources={savedSources} generatedAt={savedAt} onBack={handleBackToForm} />
			)}
		</div>
	);
}
```

- [ ] **Step 2: Modify AnalyticsDashboard to add 4th tab**

In `components/analytics/AnalyticsDashboard.tsx`:

1. Change the `Tab` type (line 15):
```typescript
type Tab = 'overview' | 'products' | 'expansion' | 'live-commerce';
```

2. Add dynamic import after the existing imports (after line 13):
```typescript
import dynamic from 'next/dynamic';
const LiveCommercePanel = dynamic(() => import('./LiveCommercePanel'), { ssr: false });
```

3. Add tab entry (after line 101, inside the tabs array):
```typescript
{ key: 'live-commerce', label: 'ライブコマース' },
```

4. Hide DateRangeFilter for live-commerce tab too (line 125):
```typescript
{activeTab !== 'expansion' && activeTab !== 'live-commerce' && (
```

5. Skip loading for live-commerce tab (line 144):
```typescript
{loading && activeTab !== 'expansion' && activeTab !== 'live-commerce' && (
```

6. Add live-commerce tab render (after line 196, after the expansion section):
```typescript
{/* Live Commerce tab */}
{activeTab === 'live-commerce' && <LiveCommercePanel />}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add components/analytics/LiveCommercePanel.tsx components/analytics/AnalyticsDashboard.tsx
git commit -m "feat(live-commerce): add LiveCommercePanel and integrate as 4th analytics tab"
```

---

### Task 6: End-to-End Verification

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Navigate to analytics**

Open `http://localhost:3000/ja/analytics` in browser.
Expected: 4 tabs visible — 概要, 商品分析, 拡大戦略, ライブコマース

- [ ] **Step 3: Test generation**

1. Click ライブコマース tab
2. Enter goal: "TikTok Liveで月商500万円を目指したい"
3. Select "TikTok Live" and "Instagram Live" platforms
4. Click 「ライブコマース戦略を分析」
5. Verify: Progress stepper shows 6 skills running sequentially
6. Verify: Each section renders as its skill completes
7. Verify: Sources cited appear at bottom

- [ ] **Step 4: Test history**

1. After generation completes, click 「一覧に戻る」
2. Verify: History section shows the generated strategy
3. Click 「表示」 on the history item
4. Verify: Full strategy loads and displays

- [ ] **Step 5: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Run lint**

Run: `npm run lint`
Expected: No errors (or only pre-existing warnings)

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat(live-commerce): complete live commerce analytics tab with 6-skill AI pipeline"
```
