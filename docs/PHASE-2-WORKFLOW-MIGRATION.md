# Phase 2: Vercel Workflow Migration

> Documented for next session. Phase 1 (parallelize discovery + Gemini streaming) is already shipped.

## Why
Phase 1 reduced wall-clock by ~60s by overlapping `discoverNewProducts` with `goal_analysis`, but the MD pipeline still runs **7 sequential Gemini calls** inside a single Vercel Function. The 300s `maxDuration` ceiling is structural — only durable workflows (per-step function invocations) eliminate the timeout risk.

## Architecture

- Dependencies: `npm install workflow @workflow/next`
- `next.config.ts` wrapped with `withWorkflow`
- New directory `lib/workflows/`:
  - `md-strategy.workflow.ts` — `mdStrategyWorkflow(input)` `"use workflow"`, each skill is a `"use step"` function
  - `live-commerce.workflow.ts` — same pattern
  - `discovery.steps.ts` — shared steps (`fetchContextStep`, `discoverNewProductsStep`)

### Skeleton
```ts
// lib/workflows/md-strategy.workflow.ts
"use workflow";
import { getWritable } from "workflow";

async function fetchContextStep(input: MDInput) {
  "use step";
  return await fetchStrategyContext(input.userGoal, input.recommend);
}

async function runProductSelectionStep(ctx: StrategyContext) {
  "use step";
  // buildProductSelectionPrompt + callGemini + splice discovered products
  return parsed;
}
// ... one step per skill

export async function mdStrategyWorkflow(input: MDInput) {
  "use workflow";
  const progress = getWritable<ProgressEvent>({ namespace: "progress" });

  const ctx = await fetchContextStep(input);
  await emitProgress(progress, { skill: "data_fetch", status: "complete" });

  const goal = await runGoalAnalysisStep(ctx);
  const ps = await runProductSelectionStep(ctx);
  await emitProgress(progress, { skill: "product_selection", status: "complete", data: ps });

  const cs = await runChannelStrategyStep(ctx, { ps });
  // ... all skills

  const strategyId = await saveStrategyStep({ ps, cs, ... });
  return { strategyId, generatedAt: new Date().toISOString() };
}
```

## API Routes
- `POST /api/analytics/md-strategy` → `start(mdStrategyWorkflow, [input])`, returns `{ runId }` immediately
- New `GET /api/analytics/md-strategy/run/[runId]/stream` → `getRun(runId).getReadable({ namespace: "progress" })` returned as Response body
- Same for `live-commerce`
- Old SSE routes kept in parallel for A/B comparison until stable

## Frontend (`MDStrategyPanel.tsx`, `LiveCommercePanel.tsx`)
```ts
const startRes = await fetch('/api/analytics/md-strategy', { method: 'POST', body: ... });
const { runId } = await startRes.json();

const streamRes = await fetch(`/api/analytics/md-strategy/run/${runId}/stream`);
const reader = streamRes.body!.getReader();
// reuse existing handleSSEEvent logic — just adapt wire format
```
Progress UX (option a) stays identical: per-skill `{ skill, status, data }` events drive the progressive `SkillResultsView`.

## Effort
- Deps + next.config: 10 min
- workflow files (MD): 1.5 h
- workflow files (LC): 1 h
- API routes: 30 min
- Frontend reader: 1 h
- Rediscover route → short workflow (optional): 30 min
- Test/debug: 1–2 h
- **Total: 5–6 h**

## Pre-flight
1. Workflow DevKit local dev requires `npx workflow dev` or vite plugin — see `node_modules/workflow/docs/getting-started/next.mdx`
2. Verify `gemini-3-flash-preview` streaming works inside `"use step"` functions
3. Verify Supabase service-role save works inside steps
4. Check whether `getReadable` wire format is NDJSON or framed (drives frontend reader changes)
5. `/rediscover` routes are short — workflow-ifying is optional

## Risk Mitigation
- Keep SSE routes during migration; A/B compare; remove only when stable
- Or feature-flag the workflow path
- No DB schema change (`md_strategies`, `live_commerce_strategies` reused as-is)

## Critical Files
- `lib/md-strategy.ts`, `lib/live-commerce-strategy.ts` (extracted into steps)
- `app/api/analytics/md-strategy/route.ts`, `app/api/analytics/live-commerce/route.ts`
- New `app/api/analytics/{md-strategy,live-commerce}/run/[runId]/stream/route.ts`
- `components/analytics/MDStrategyPanel.tsx`, `components/analytics/LiveCommercePanel.tsx`
