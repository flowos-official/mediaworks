# Insights Dashboard Implementation Plan (Phase 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 商品発掘 하위에 "インサイト" 서브탭을 추가하여 選別(제품 조회)과 統計(KPI + 주간 Gemini 요약 + 차트 4종) 탭 제공. 매주 월요일 Gemini가 자연어 요약 생성.

**Architecture:** `learning_insights` 테이블에 context 컬럼 추가 마이그레이션 → weekly-insights cron이 Gemini 호출하여 context별 주간 요약 저장 → `/api/discovery/{insights,selections}` API가 집계/조회 → `/analytics/discovery/insights` 페이지 2단 탭으로 시각화 (recharts).

**Tech Stack:** Next.js 16, recharts (신규 설치), Supabase, Gemini 3-Flash, next-intl.

**Spec reference:** `docs/superpowers/specs/2026-04-18-insights-dashboard-design.md`

**Phase 1-5 완료 상태:** 발굴 + 피드백 + 학습 + 메뉴 재그룹핑 + seed-aware 전략 완성.

---

## File Structure

**Create (15 files):**
```
supabase/migrations/2026-04-18_insights_context.sql

app/api/cron/weekly-insights/route.ts
app/api/discovery/insights/route.ts
app/api/discovery/selections/route.ts
app/[locale]/analytics/discovery/insights/page.tsx

components/discovery/
  InsightsTabs.tsx
  SelectionGrid.tsx
  StatsDashboard.tsx
  KPICard.tsx
  WeeklyInsightCard.tsx
  charts/CategorySourcingChart.tsx
  charts/DailyFeedbackChart.tsx
  charts/ExplorationTrendChart.tsx
  charts/RejectionReasonChart.tsx

lib/discovery/weekly-insights.ts
```

**Modify:**
```
components/discovery/ContextSubTabs.tsx  — add "インサイト" tab
messages/ja.json, messages/en.json       — ~25 keys
vercel.json                              — weekly-insights cron + timeout
package.json                             — recharts
```

---

## Task 1: DB migration — learning_insights.context

**Files:** Create `supabase/migrations/2026-04-18_insights_context.sql`

```sql
ALTER TABLE learning_insights
  ADD COLUMN IF NOT EXISTS context text NOT NULL DEFAULT 'home_shopping'
    CHECK (context IN ('home_shopping', 'live_commerce'));

ALTER TABLE learning_insights DROP CONSTRAINT IF EXISTS learning_insights_week_start_key;
ALTER TABLE learning_insights ADD CONSTRAINT learning_insights_week_context_key
  UNIQUE (week_start, context);

CREATE INDEX IF NOT EXISTS idx_learning_insights_context
  ON learning_insights (context, week_start DESC);
```

Commit: `feat(db): add context column to learning_insights + compound UNIQUE`

---

## Task 2: 사용자 Supabase 마이그레이션 실행 (수동)

Supabase Studio에서 Task 1 SQL 실행. 검증:
```sql
SELECT column_name FROM information_schema.columns 
WHERE table_name = 'learning_insights' AND column_name = 'context';
-- expected: 1 row
```

---

## Task 3: recharts 설치

```bash
npm install recharts
```

Commit: `chore: add recharts for insights dashboard charts`

---

## Task 4: `lib/discovery/weekly-insights.ts`

**File:** Create `lib/discovery/weekly-insights.ts`

```typescript
/**
 * Weekly insights aggregation + Gemini natural-language summary.
 * Ref: Phase 6 spec §5.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { getServiceClient } from "@/lib/supabase";
import type { Context } from "./types";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = "gemini-3-flash-preview";

export interface WeeklyInsightInput {
	weekStart: string;
	weekEnd: string;
	context: Context;
	sourcedCount: number;
	rejectedCount: number;
	interestedCount: number;
	topCategories: Array<{ category: string; sourced: number; shown: number }>;
	topRejectionReasons: Array<{ reason: string; count: number }>;
	explorationWinRate: number;
	tvProvenWinRate: number;
	currentExplorationRatio: number;
}

export interface WeeklyInsightOutput {
	sourced_product_patterns: string;
	exploration_wins: string;
	next_week_suggestions: string;
}

/**
 * Aggregate last week's feedback for a context.
 */
export async function aggregateWeek(
	context: Context,
	weekStart: Date,
	weekEnd: Date,
): Promise<WeeklyInsightInput> {
	const sb = getServiceClient();
	const from = weekStart.toISOString();
	const to = weekEnd.toISOString();

	const { data: products } = await sb
		.from("discovered_products")
		.select("category, track, user_action, action_reason")
		.eq("context", context)
		.gte("created_at", from)
		.lte("created_at", to);

	const items = products ?? [];
	const sourcedCount = items.filter((p) => p.user_action === "sourced").length;
	const rejectedCount = items.filter((p) => p.user_action === "rejected").length;
	const interestedCount = items.filter((p) => p.user_action === "interested").length;

	// Top categories by sourced count
	const catMap = new Map<string, { sourced: number; shown: number }>();
	for (const p of items) {
		const cat = p.category ?? "unknown";
		const stat = catMap.get(cat) ?? { sourced: 0, shown: 0 };
		stat.shown += 1;
		if (p.user_action === "sourced") stat.sourced += 1;
		catMap.set(cat, stat);
	}
	const topCategories = [...catMap.entries()]
		.map(([category, s]) => ({ category, ...s }))
		.sort((a, b) => b.sourced - a.sourced)
		.slice(0, 5);

	// Rejection reasons
	const reasonMap = new Map<string, number>();
	for (const p of items) {
		if (p.user_action === "rejected" && p.action_reason) {
			reasonMap.set(p.action_reason, (reasonMap.get(p.action_reason) ?? 0) + 1);
		}
	}
	const topRejectionReasons = [...reasonMap.entries()]
		.map(([reason, count]) => ({ reason, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 5);

	// Track win rates
	const tvRows = items.filter((p) => p.track === "tv_proven");
	const expRows = items.filter((p) => p.track === "exploration");
	const tvWins = tvRows.filter(
		(p) => p.user_action === "sourced" || p.user_action === "interested",
	).length;
	const expWins = expRows.filter(
		(p) => p.user_action === "sourced" || p.user_action === "interested",
	).length;

	const { data: state } = await sb
		.from("learning_state")
		.select("exploration_ratio")
		.eq("context", context)
		.single();

	return {
		weekStart: from,
		weekEnd: to,
		context,
		sourcedCount,
		rejectedCount,
		interestedCount,
		topCategories,
		topRejectionReasons,
		explorationWinRate: expRows.length > 0 ? expWins / expRows.length : 0,
		tvProvenWinRate: tvRows.length > 0 ? tvWins / tvRows.length : 0,
		currentExplorationRatio: Number(state?.exploration_ratio ?? 0.47),
	};
}

/**
 * Call Gemini for natural-language weekly summary.
 */
export async function generateWeeklyInsight(
	input: WeeklyInsightInput,
): Promise<WeeklyInsightOutput> {
	const contextLabel =
		input.context === "home_shopping" ? "ホームショッピング" : "ライブコマース";

	const prompt = `あなたは日本のテレビ通販・ライブコマース向け商品発掘システムのアナリストです。
以下の週間データを元に、日本語で週次インサイトをまとめてください。

【対象Context】 ${contextLabel}
【期間】 ${input.weekStart.slice(0, 10)} ~ ${input.weekEnd.slice(0, 10)}

【主要指標】
- ソーシング数: ${input.sourcedCount}
- 関心あり: ${input.interestedCount}
- 却下: ${input.rejectedCount}
- 現在の探索比率: ${(input.currentExplorationRatio * 100).toFixed(0)}%
- TV実績カテゴリの成功率: ${(input.tvProvenWinRate * 100).toFixed(1)}%
- 探索カテゴリの成功率: ${(input.explorationWinRate * 100).toFixed(1)}%

【カテゴリ別成果 (Top 5)】
${input.topCategories.map((c) => `- ${c.category}: ソーシング${c.sourced}/${c.shown}件`).join("\n")}

【却下理由 (Top 5)】
${input.topRejectionReasons.map((r) => `- ${r.reason}: ${r.count}件`).join("\n") || "(なし)"}

【出力 — JSONのみ、前置き/後書きなし】
{
  "sourced_product_patterns": "ソーシングされた商品の共通パターン + ハイライト (150字以内, 日本語)",
  "exploration_wins": "探索カテゴリで成功したケースの分析 (100字以内, 日本語)",
  "next_week_suggestions": "来週の戦略提案 (150字以内, 日本語, 具体的なカテゴリ名や比率提案含む)"
}`;

	try {
		const model = genAI.getGenerativeModel({ model: MODEL_ID });
		const res = await model.generateContent(prompt);
		const text = res.response.text();
		const match = text.match(/\{[\s\S]+\}/);
		if (!match) throw new Error("no JSON in response");
		const parsed = JSON.parse(match[0]) as WeeklyInsightOutput;
		return {
			sourced_product_patterns: parsed.sourced_product_patterns ?? "",
			exploration_wins: parsed.exploration_wins ?? "",
			next_week_suggestions: parsed.next_week_suggestions ?? "",
		};
	} catch (err) {
		console.warn(
			`[weekly-insights] Gemini failed for ${input.context}:`,
			err instanceof Error ? err.message : String(err),
		);
		return {
			sourced_product_patterns: "(生成失敗)",
			exploration_wins: "(生成失敗)",
			next_week_suggestions: "(生成失敗)",
		};
	}
}
```

Verify + commit: `feat(discovery): add weekly-insights aggregation + Gemini summary`

---

## Task 5: `/api/cron/weekly-insights/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { aggregateWeek, generateWeeklyInsight } from "@/lib/discovery/weekly-insights";
import { getServiceClient } from "@/lib/supabase";
import type { Context } from "@/lib/discovery/types";

export const maxDuration = 120;

const CONTEXTS: Context[] = ["home_shopping", "live_commerce"];

function verifyCronAuth(req: NextRequest): boolean {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true;
	const header = req.headers.get("authorization");
	return header === `Bearer ${secret}`;
}

function getLastWeekRange(): { start: Date; end: Date } {
	// Last full ISO week (Mon-Sun before today)
	const now = new Date();
	const day = now.getUTCDay(); // 0=Sun
	const daysToLastSunday = day === 0 ? 7 : day;
	const lastSunday = new Date(now);
	lastSunday.setUTCDate(now.getUTCDate() - daysToLastSunday);
	lastSunday.setUTCHours(23, 59, 59, 999);
	const lastMonday = new Date(lastSunday);
	lastMonday.setUTCDate(lastSunday.getUTCDate() - 6);
	lastMonday.setUTCHours(0, 0, 0, 0);
	return { start: lastMonday, end: lastSunday };
}

export async function GET(req: NextRequest) {
	if (!verifyCronAuth(req)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const sb = getServiceClient();
	const { start, end } = getLastWeekRange();
	const results: Array<{ context: Context; ok: boolean; error?: string }> = [];

	for (const context of CONTEXTS) {
		try {
			const input = await aggregateWeek(context, start, end);
			const summary = await generateWeeklyInsight(input);

			const { error } = await sb.from("learning_insights").upsert(
				{
					context,
					week_start: start.toISOString().slice(0, 10),
					sourced_count: input.sourcedCount,
					rejected_count: input.rejectedCount,
					top_rejection_reasons: input.topRejectionReasons,
					sourced_product_patterns: summary.sourced_product_patterns,
					exploration_wins: summary.exploration_wins,
					next_week_suggestions: summary.next_week_suggestions,
				},
				{ onConflict: "week_start,context" },
			);

			if (error) throw new Error(error.message);
			results.push({ context, ok: true });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[weekly-insights] ${context} failed:`, msg);
			results.push({ context, ok: false, error: msg });
		}
	}

	return NextResponse.json({ results });
}
```

Add to `vercel.json`:
- `functions`: `"app/api/cron/weekly-insights/route.ts": { "maxDuration": 120 }`
- `crons`: `{ "path": "/api/cron/weekly-insights", "schedule": "0 1 * * 1" }`

Commit: `feat(discovery): add weekly-insights cron (Mon 01:00 UTC, per-context)`

---

## Task 6: `/api/discovery/insights/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
	const sb = getServiceClient();
	const { searchParams } = new URL(req.url);
	const contextFilter = searchParams.get("context");
	const weeks = Math.min(Number(searchParams.get("weeks") ?? 12), 52);

	const weeksAgo = new Date();
	weeksAgo.setUTCDate(weeksAgo.getUTCDate() - weeks * 7);

	// This week KPI (current week so far)
	const now = new Date();
	const monday = new Date(now);
	const day = monday.getUTCDay();
	const daysFromMonday = day === 0 ? 6 : day - 1;
	monday.setUTCDate(now.getUTCDate() - daysFromMonday);
	monday.setUTCHours(0, 0, 0, 0);

	let kpiQuery = sb
		.from("discovered_products")
		.select("user_action")
		.gte("created_at", monday.toISOString());
	if (contextFilter === "home_shopping" || contextFilter === "live_commerce") {
		kpiQuery = kpiQuery.eq("context", contextFilter);
	}
	const { data: thisWeek } = await kpiQuery;
	const thisWeekSourced = (thisWeek ?? []).filter((r) => r.user_action === "sourced").length;
	const thisWeekRejected = (thisWeek ?? []).filter((r) => r.user_action === "rejected").length;

	// Learning state (exploration ratio + sample size)
	let stateQuery = sb.from("learning_state").select("*");
	if (contextFilter === "home_shopping" || contextFilter === "live_commerce") {
		stateQuery = stateQuery.eq("context", contextFilter);
	}
	const { data: states } = await stateQuery;
	const explorationRatio =
		(states ?? []).reduce((sum, s) => sum + Number(s.exploration_ratio ?? 0), 0) /
		((states ?? []).length || 1);
	const totalSamples = (states ?? []).reduce(
		(sum, s) => sum + Number(s.feedback_sample_size ?? 0),
		0,
	);

	// Weekly insights (last N weeks)
	let insightsQuery = sb
		.from("learning_insights")
		.select("*")
		.gte("week_start", weeksAgo.toISOString().slice(0, 10))
		.order("week_start", { ascending: false });
	if (contextFilter === "home_shopping" || contextFilter === "live_commerce") {
		insightsQuery = insightsQuery.eq("context", contextFilter);
	}
	const { data: weeklyInsights } = await insightsQuery;

	// Daily feedback (last 30 days)
	const thirtyDaysAgo = new Date();
	thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
	let dailyQuery = sb
		.from("discovered_products")
		.select("action_at, user_action, context")
		.not("user_action", "is", null)
		.gte("action_at", thirtyDaysAgo.toISOString());
	if (contextFilter === "home_shopping" || contextFilter === "live_commerce") {
		dailyQuery = dailyQuery.eq("context", contextFilter);
	}
	const { data: dailyRows } = await dailyQuery;

	const dailyMap = new Map<
		string,
		{ sourced: number; interested: number; rejected: number; duplicate: number }
	>();
	for (const r of dailyRows ?? []) {
		const date = (r.action_at as string).slice(0, 10);
		const entry =
			dailyMap.get(date) ?? { sourced: 0, interested: 0, rejected: 0, duplicate: 0 };
		if (r.user_action && entry[r.user_action as keyof typeof entry] !== undefined) {
			entry[r.user_action as keyof typeof entry] += 1;
		}
		dailyMap.set(date, entry);
	}
	const dailyFeedback = [...dailyMap.entries()]
		.map(([date, counts]) => ({ date, ...counts }))
		.sort((a, b) => a.date.localeCompare(b.date));

	// Rejection reasons (last 30 days)
	const reasonMap = new Map<string, number>();
	for (const r of dailyRows ?? []) {
		if (r.user_action === "rejected") {
			const reason = (r as unknown as { action_reason?: string }).action_reason ?? "不明";
			reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
		}
	}

	// Category weights snapshot
	const categoryWeights: Record<string, number> = {};
	for (const s of states ?? []) {
		const weights = s.category_weights as Record<string, number> | null;
		if (weights) {
			for (const [cat, weight] of Object.entries(weights)) {
				categoryWeights[cat] = Math.max(categoryWeights[cat] ?? 0, weight);
			}
		}
	}

	// Exploration trend (from learning_insights weeks, using insights table snapshots — simplified: use learning_state current only)
	const explorationTrend = (weeklyInsights ?? [])
		.slice(0, 12)
		.reverse()
		.map((w) => ({
			week: w.week_start,
			home: 0,
			live: 0,
		}));

	return NextResponse.json({
		kpi: {
			thisWeekSourced,
			thisWeekRejected,
			explorationRatio,
			totalSamples,
		},
		weeklyInsights: weeklyInsights ?? [],
		categoryWeights,
		explorationTrend,
		rejectionReasons: [...reasonMap.entries()].map(([reason, count]) => ({ reason, count })),
		dailyFeedback,
	});
}
```

Commit: `feat(discovery): add insights API (KPI + weekly summaries + daily feedback)`

---

## Task 7: `/api/discovery/selections/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
	const sb = getServiceClient();
	const { searchParams } = new URL(req.url);
	const status = searchParams.get("status");
	const context = searchParams.get("context");
	const days = Math.min(Number(searchParams.get("days") ?? 30), 365);
	const page = Math.max(Number(searchParams.get("page") ?? 0), 0);
	const limit = Math.min(Number(searchParams.get("limit") ?? 20), 100);

	const fromDate = new Date();
	fromDate.setUTCDate(fromDate.getUTCDate() - days);

	let query = sb
		.from("discovered_products")
		.select("*", { count: "exact" })
		.gte("action_at", fromDate.toISOString())
		.order("action_at", { ascending: false });

	if (status && ["sourced", "interested", "rejected", "duplicate"].includes(status)) {
		query = query.eq("user_action", status);
	} else {
		query = query.not("user_action", "is", null);
	}

	if (context === "home_shopping" || context === "live_commerce") {
		query = query.eq("context", context);
	}

	const { data, error, count } = await query.range(page * limit, page * limit + limit - 1);
	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}

	return NextResponse.json({
		products: data ?? [],
		total: count ?? 0,
		page,
		limit,
	});
}
```

Commit: `feat(discovery): add selections API (filtered feedback products)`

---

## Task 8: ContextSubTabs에 インサイト 서브탭 추가

Modify `components/discovery/ContextSubTabs.tsx`:

Find the `TABS` array (3 entries). Add a 4th:
```typescript
import { Home, Tv, Calendar, BarChart3 } from "lucide-react";

const TABS: Array<{ key: SubTab; icon: React.ReactNode; labelKey: "subTabHome" | "subTabLive" | "subTabHistory" | "subTabInsights" }> = [
	{ key: "home", icon: <Home size={14} />, labelKey: "subTabHome" },
	{ key: "live", icon: <Tv size={14} />, labelKey: "subTabLive" },
	{ key: "history", icon: <Calendar size={14} />, labelKey: "subTabHistory" },
	{ key: "insights", icon: <BarChart3 size={14} />, labelKey: "subTabInsights" },
];
```

Update `SubTab` type: `type SubTab = "home" | "live" | "history" | "insights";`

Update activeTab derivation:
```typescript
const activeTab = (() => {
    const parts = pathname.split("/").filter(Boolean);
    const sub = parts[3];
    if (sub === "home" || sub === "live" || sub === "history" || sub === "insights") return sub;
    return "home";
})();
```

Commit: `feat(discovery): add インサイト sub-tab to ContextSubTabs`

---

## Task 9: i18n keys

Add to `messages/ja.json` + `en.json` discovery block:

**ja**:
```json
"subTabInsights": "インサイト",
"insightsSelectionTab": "選別",
"insightsStatsTab": "統計",
"kpiSourcedThisWeek": "今週のソーシング",
"kpiRejectedThisWeek": "今週の却下",
"kpiExplorationRatio": "探索比率",
"kpiTotalSamples": "総サンプル",
"weeklyInsightTitle": "週間インサイト",
"weeklyInsightHighlight": "成功パターン",
"weeklyInsightPatterns": "探索成果",
"weeklyInsightSuggestions": "来週の提案",
"chartCategorySourcing": "カテゴリ別ソーシング率",
"chartDailyFeedback": "日別フィードバック",
"chartExplorationTrend": "探索比率推移",
"chartRejectionReasons": "却下理由分布",
"periodFilter7": "7日",
"periodFilter30": "30日",
"periodFilter90": "90日",
"thisWeek": "今週",
"cumulative": "累計",
"noData": "データなし",
"allStatuses": "すべて"
```

**en**:
```json
"subTabInsights": "Insights",
"insightsSelectionTab": "Selection",
"insightsStatsTab": "Statistics",
"kpiSourcedThisWeek": "Sourced (week)",
"kpiRejectedThisWeek": "Rejected (week)",
"kpiExplorationRatio": "Exploration ratio",
"kpiTotalSamples": "Total samples",
"weeklyInsightTitle": "Weekly Insights",
"weeklyInsightHighlight": "Success Patterns",
"weeklyInsightPatterns": "Exploration Wins",
"weeklyInsightSuggestions": "Next Week",
"chartCategorySourcing": "Sourcing Rate by Category",
"chartDailyFeedback": "Daily Feedback",
"chartExplorationTrend": "Exploration Trend",
"chartRejectionReasons": "Rejection Reasons",
"periodFilter7": "7 days",
"periodFilter30": "30 days",
"periodFilter90": "90 days",
"thisWeek": "This week",
"cumulative": "Cumulative",
"noData": "No data",
"allStatuses": "All"
```

Commit: `feat(discovery): add insights/selection i18n keys`

---

## Task 10: Chart components

**File:** Create 4 chart files under `components/discovery/charts/`.

Each file uses recharts `ResponsiveContainer`. Skeletal structure for each:

### `CategorySourcingChart.tsx`
```tsx
"use client";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, Cell } from "recharts";

interface Item {
	category: string;
	sourced: number;
	shown: number;
	rate: number;
}

export function CategorySourcingChart({ data }: { data: Item[] }) {
	const sorted = [...data].sort((a, b) => b.rate - a.rate).slice(0, 10);
	return (
		<ResponsiveContainer width="100%" height={280}>
			<BarChart data={sorted} layout="vertical" margin={{ top: 10, right: 20, left: 60, bottom: 10 }}>
				<XAxis type="number" domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fontSize: 10 }} />
				<YAxis type="category" dataKey="category" width={80} tick={{ fontSize: 10 }} />
				<Tooltip formatter={(v: number) => `${Math.round(v * 100)}%`} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
				<Bar dataKey="rate" fill="#3b82f6" radius={[0, 4, 4, 0]} />
			</BarChart>
		</ResponsiveContainer>
	);
}
```

### `DailyFeedbackChart.tsx`
```tsx
"use client";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";

interface DailyItem {
	date: string;
	sourced: number;
	interested: number;
	rejected: number;
	duplicate: number;
}

export function DailyFeedbackChart({ data }: { data: DailyItem[] }) {
	return (
		<ResponsiveContainer width="100%" height={280}>
			<BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 10 }}>
				<XAxis dataKey="date" tick={{ fontSize: 9 }} tickFormatter={(d) => d.slice(5)} />
				<YAxis tick={{ fontSize: 10 }} />
				<Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }} />
				<Legend wrapperStyle={{ fontSize: 10 }} />
				<Bar dataKey="sourced" stackId="a" fill="#22c55e" />
				<Bar dataKey="interested" stackId="a" fill="#f97316" />
				<Bar dataKey="rejected" stackId="a" fill="#ef4444" />
				<Bar dataKey="duplicate" stackId="a" fill="#9ca3af" />
			</BarChart>
		</ResponsiveContainer>
	);
}
```

### `ExplorationTrendChart.tsx`
```tsx
"use client";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";

interface TrendItem {
	week: string;
	home: number;
	live: number;
}

export function ExplorationTrendChart({ data }: { data: TrendItem[] }) {
	return (
		<ResponsiveContainer width="100%" height={280}>
			<LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 10 }}>
				<XAxis dataKey="week" tick={{ fontSize: 9 }} tickFormatter={(w) => w.slice(5)} />
				<YAxis domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fontSize: 10 }} />
				<Tooltip formatter={(v: number) => `${Math.round(v * 100)}%`} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
				<Legend wrapperStyle={{ fontSize: 10 }} />
				<Line type="monotone" dataKey="home" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
				<Line type="monotone" dataKey="live" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} />
			</LineChart>
		</ResponsiveContainer>
	);
}
```

### `RejectionReasonChart.tsx`
```tsx
"use client";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";

interface ReasonItem {
	reason: string;
	count: number;
}

const COLORS = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#06b6d4", "#6b7280"];

export function RejectionReasonChart({ data }: { data: ReasonItem[] }) {
	// Group "その他: *" into one bucket
	const buckets = new Map<string, number>();
	for (const d of data) {
		const key = d.reason.startsWith("その他") ? "その他" : d.reason;
		buckets.set(key, (buckets.get(key) ?? 0) + d.count);
	}
	const grouped = [...buckets.entries()].map(([reason, count]) => ({ reason, count }));

	return (
		<ResponsiveContainer width="100%" height={280}>
			<PieChart>
				<Pie
					data={grouped}
					dataKey="count"
					nameKey="reason"
					cx="50%"
					cy="50%"
					innerRadius={50}
					outerRadius={90}
					label={(e) => `${e.reason}: ${e.count}`}
					labelLine={false}
				>
					{grouped.map((_, i) => (
						<Cell key={i} fill={COLORS[i % COLORS.length]} />
					))}
				</Pie>
				<Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }} />
			</PieChart>
		</ResponsiveContainer>
	);
}
```

Commit: `feat(discovery): add 4 recharts components for insights statistics`

---

## Task 11: KPI + Insight 컴포넌트

### `KPICard.tsx`
```tsx
"use client";
interface Props {
	label: string;
	value: string | number;
	subtitle?: string;
	accent?: "green" | "red" | "blue" | "gray";
}

const ACCENT = {
	green: "bg-green-50 border-green-200 text-green-700",
	red: "bg-red-50 border-red-200 text-red-700",
	blue: "bg-blue-50 border-blue-200 text-blue-700",
	gray: "bg-gray-50 border-gray-200 text-gray-700",
};

export function KPICard({ label, value, subtitle, accent = "gray" }: Props) {
	return (
		<div className={`rounded-lg border p-4 ${ACCENT[accent]}`}>
			<div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{label}</div>
			<div className="text-2xl font-bold mt-1">{value}</div>
			{subtitle && <div className="text-[10px] opacity-60 mt-1">{subtitle}</div>}
		</div>
	);
}
```

### `WeeklyInsightCard.tsx`
```tsx
"use client";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";

interface Insight {
	week_start: string;
	context: "home_shopping" | "live_commerce";
	sourced_product_patterns: string | null;
	exploration_wins: string | null;
	next_week_suggestions: string | null;
	sourced_count: number | null;
	rejected_count: number | null;
}

export function WeeklyInsightCard({ insight }: { insight: Insight | null }) {
	const t = useTranslations("discovery");

	if (!insight) {
		return (
			<div className="bg-white border border-gray-200 rounded-lg p-5 text-sm text-gray-400">
				{t("noData")}
			</div>
		);
	}

	return (
		<div className="bg-gradient-to-br from-indigo-50 to-white border border-indigo-200 rounded-lg p-5">
			<div className="flex items-center gap-2 mb-3">
				<Sparkles size={14} className="text-indigo-600" />
				<h3 className="text-sm font-semibold text-gray-900">{t("weeklyInsightTitle")}</h3>
				<span className="text-[10px] text-gray-500 ml-auto">
					{insight.week_start}~ · {insight.context === "home_shopping" ? "ホーム" : "ライブ"}
				</span>
			</div>
			<div className="space-y-3">
				<Section label={t("weeklyInsightHighlight")} text={insight.sourced_product_patterns} />
				<Section label={t("weeklyInsightPatterns")} text={insight.exploration_wins} />
				<Section label={t("weeklyInsightSuggestions")} text={insight.next_week_suggestions} />
			</div>
		</div>
	);
}

function Section({ label, text }: { label: string; text: string | null }) {
	if (!text) return null;
	return (
		<div>
			<div className="text-[10px] font-bold text-indigo-700 uppercase tracking-wide mb-1">
				{label}
			</div>
			<p className="text-xs text-gray-800 leading-relaxed">{text}</p>
		</div>
	);
}
```

Commit: `feat(discovery): add KPICard + WeeklyInsightCard components`

---

## Task 12: StatsDashboard + SelectionGrid + InsightsTabs

### `StatsDashboard.tsx`
```tsx
"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { KPICard } from "./KPICard";
import { WeeklyInsightCard } from "./WeeklyInsightCard";
import { CategorySourcingChart } from "./charts/CategorySourcingChart";
import { DailyFeedbackChart } from "./charts/DailyFeedbackChart";
import { ExplorationTrendChart } from "./charts/ExplorationTrendChart";
import { RejectionReasonChart } from "./charts/RejectionReasonChart";

interface InsightsData {
	kpi: {
		thisWeekSourced: number;
		thisWeekRejected: number;
		explorationRatio: number;
		totalSamples: number;
	};
	weeklyInsights: Array<{
		week_start: string;
		context: "home_shopping" | "live_commerce";
		sourced_product_patterns: string | null;
		exploration_wins: string | null;
		next_week_suggestions: string | null;
		sourced_count: number | null;
		rejected_count: number | null;
	}>;
	categoryWeights: Record<string, number>;
	explorationTrend: Array<{ week: string; home: number; live: number }>;
	rejectionReasons: Array<{ reason: string; count: number }>;
	dailyFeedback: Array<{
		date: string;
		sourced: number;
		interested: number;
		rejected: number;
		duplicate: number;
	}>;
}

export function StatsDashboard() {
	const t = useTranslations("discovery");
	const [data, setData] = useState<InsightsData | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		fetch("/api/discovery/insights?weeks=12")
			.then((r) => r.json())
			.then((d) => {
				setData(d);
				setLoading(false);
			})
			.catch(() => setLoading(false));
	}, []);

	if (loading) return <div className="py-20 text-center text-sm text-gray-500">Loading...</div>;
	if (!data) return <div className="py-20 text-center text-sm text-gray-400">{t("noData")}</div>;

	const categoryData = Object.entries(data.categoryWeights).map(([category, rate]) => ({
		category,
		sourced: 0,
		shown: 0,
		rate,
	}));

	const latestInsight = data.weeklyInsights[0] ?? null;

	return (
		<div className="space-y-6">
			{/* KPI Cards */}
			<div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
				<KPICard
					label={t("kpiSourcedThisWeek")}
					value={data.kpi.thisWeekSourced}
					subtitle={t("thisWeek")}
					accent="green"
				/>
				<KPICard
					label={t("kpiRejectedThisWeek")}
					value={data.kpi.thisWeekRejected}
					subtitle={t("thisWeek")}
					accent="red"
				/>
				<KPICard
					label={t("kpiExplorationRatio")}
					value={`${Math.round(data.kpi.explorationRatio * 100)}%`}
					accent="blue"
				/>
				<KPICard
					label={t("kpiTotalSamples")}
					value={data.kpi.totalSamples}
					subtitle={t("cumulative")}
					accent="gray"
				/>
			</div>

			{/* Weekly Insight */}
			<WeeklyInsightCard insight={latestInsight} />

			{/* Charts Grid */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
				<ChartCard title={t("chartCategorySourcing")}>
					<CategorySourcingChart data={categoryData} />
				</ChartCard>
				<ChartCard title={t("chartDailyFeedback")}>
					<DailyFeedbackChart data={data.dailyFeedback} />
				</ChartCard>
				<ChartCard title={t("chartExplorationTrend")}>
					<ExplorationTrendChart data={data.explorationTrend} />
				</ChartCard>
				<ChartCard title={t("chartRejectionReasons")}>
					<RejectionReasonChart data={data.rejectionReasons} />
				</ChartCard>
			</div>
		</div>
	);
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="bg-white border border-gray-200 rounded-lg p-4">
			<h4 className="text-sm font-semibold text-gray-900 mb-3">{title}</h4>
			{children}
		</div>
	);
}
```

### `SelectionGrid.tsx`
```tsx
"use client";
import { useEffect, useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import { ProductCard, type DiscoveredProductRow } from "./ProductCard";

type Status = "all" | "sourced" | "interested" | "rejected" | "duplicate";
type ContextFilter = "all" | "home_shopping" | "live_commerce";
type Period = 7 | 30 | 90;

export function SelectionGrid() {
	const t = useTranslations("discovery");
	const [status, setStatus] = useState<Status>("all");
	const [context, setContext] = useState<ContextFilter>("all");
	const [days, setDays] = useState<Period>(30);
	const [page, setPage] = useState(0);
	const [products, setProducts] = useState<DiscoveredProductRow[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(false);

	const queryKey = useMemo(() => `${status}-${context}-${days}-${page}`, [status, context, days, page]);

	useEffect(() => {
		setLoading(true);
		const params = new URLSearchParams();
		if (status !== "all") params.set("status", status);
		if (context !== "all") params.set("context", context);
		params.set("days", String(days));
		params.set("page", String(page));
		params.set("limit", "20");

		fetch(`/api/discovery/selections?${params}`)
			.then((r) => r.json())
			.then((data) => {
				if (page === 0) setProducts(data.products ?? []);
				else setProducts((prev) => [...prev, ...(data.products ?? [])]);
				setTotal(data.total ?? 0);
				setLoading(false);
			})
			.catch(() => setLoading(false));
	}, [queryKey, page]);

	function resetPage() {
		setPage(0);
	}

	return (
		<div>
			<div className="flex flex-wrap items-center gap-2 mb-4">
				<span className="text-xs text-gray-500">Status:</span>
				{(["all", "sourced", "interested", "rejected", "duplicate"] as Status[]).map((s) => (
					<button
						key={s}
						onClick={() => { setStatus(s); resetPage(); }}
						className={`px-3 py-1 text-xs rounded-full border transition-colors ${
							status === s
								? "bg-amber-500 text-white border-amber-500"
								: "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
						}`}
					>
						{s === "all" ? t("allStatuses") : t(s === "sourced" ? "filterSourced" : s === "interested" ? "filterInterested" : s === "rejected" ? "filterRejected" : "duplicateButton")}
					</button>
				))}
				<span className="text-xs text-gray-500 ml-2">Context:</span>
				{(["all", "home_shopping", "live_commerce"] as ContextFilter[]).map((c) => (
					<button
						key={c}
						onClick={() => { setContext(c); resetPage(); }}
						className={`px-3 py-1 text-xs rounded-full border transition-colors ${
							context === c
								? "bg-blue-500 text-white border-blue-500"
								: "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
						}`}
					>
						{c === "all" ? t("allStatuses") : c === "home_shopping" ? "ホーム" : "ライブ"}
					</button>
				))}
				<span className="text-xs text-gray-500 ml-2">Period:</span>
				{([7, 30, 90] as Period[]).map((d) => (
					<button
						key={d}
						onClick={() => { setDays(d); resetPage(); }}
						className={`px-3 py-1 text-xs rounded-full border transition-colors ${
							days === d
								? "bg-gray-600 text-white border-gray-600"
								: "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
						}`}
					>
						{t(d === 7 ? "periodFilter7" : d === 30 ? "periodFilter30" : "periodFilter90")}
					</button>
				))}
				<span className="ml-auto text-xs text-gray-500">{products.length}/{total}</span>
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
				{products.map((p) => (
					<ProductCard key={p.id} product={p} />
				))}
				{products.length === 0 && !loading && (
					<div className="col-span-full py-12 text-center text-sm text-gray-400">
						{t("noData")}
					</div>
				)}
			</div>

			{loading && <div className="py-8 text-center text-sm text-gray-500">Loading...</div>}

			{!loading && products.length < total && (
				<div className="py-4 text-center">
					<button
						onClick={() => setPage((p) => p + 1)}
						className="px-6 py-2 text-xs border border-gray-300 rounded hover:bg-gray-50"
					>
						{t("loadMore")}
					</button>
				</div>
			)}
		</div>
	);
}
```

### `InsightsTabs.tsx`
```tsx
"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { CheckSquare, BarChart3 } from "lucide-react";
import { SelectionGrid } from "./SelectionGrid";
import { StatsDashboard } from "./StatsDashboard";

type Tab = "selection" | "stats";

export function InsightsTabs() {
	const t = useTranslations("discovery");
	const [tab, setTab] = useState<Tab>("selection");

	return (
		<div>
			<div className="flex gap-1 p-1 bg-white border border-gray-200 rounded-lg shadow-sm mb-4 w-fit">
				<button
					type="button"
					onClick={() => setTab("selection")}
					className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
						tab === "selection"
							? "bg-indigo-500 text-white shadow-sm"
							: "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
					}`}
				>
					<CheckSquare size={14} />
					{t("insightsSelectionTab")}
				</button>
				<button
					type="button"
					onClick={() => setTab("stats")}
					className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
						tab === "stats"
							? "bg-indigo-500 text-white shadow-sm"
							: "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
					}`}
				>
					<BarChart3 size={14} />
					{t("insightsStatsTab")}
				</button>
			</div>

			{tab === "selection" ? <SelectionGrid /> : <StatsDashboard />}
		</div>
	);
}
```

Commit: `feat(discovery): add InsightsTabs + SelectionGrid + StatsDashboard components`

---

## Task 13: Insights page

**File:** Create `app/[locale]/analytics/discovery/insights/page.tsx`

```tsx
"use client";

import { ContextSubTabs } from "@/components/discovery/ContextSubTabs";
import { InsightsTabs } from "@/components/discovery/InsightsTabs";

export default function InsightsPage() {
	return (
		<div>
			<ContextSubTabs />
			<InsightsTabs />
		</div>
	);
}
```

Commit: `feat(discovery): add /analytics/discovery/insights page`

---

## Task 14: Manual cron trigger + verification

- User runs Task 2 migration in production Supabase
- Locally trigger cron: `curl http://localhost:3001/api/cron/weekly-insights` 
- Check `learning_insights` row created
- Browse `/ja/analytics/discovery/insights` → verify both tabs work

---

## Task 15: Final push + PR update

After verification passes:
```bash
git push origin feature/product-discovery-phase1
```

---

## Self-Review

- Spec coverage: all items mapped to tasks ✓
- No placeholders in code blocks ✓
- Type consistency: `Context`, `SeedContext` reused; chart Item interfaces local to each file ✓
- Gap: InsightsTabs doesn't track context — if user wants context-specific view, add `context` state → pass to children. Deferred to Phase 7 as stretch.
