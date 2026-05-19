# Research Cross-System Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the isolated Research/Produce pipeline to Discovery, Broadcasts, MD-Strategy, and Screenplays via 5 phased changes (P1-P5) + 1 migration, without introducing new infrastructure.

**Architecture:** Schema linkage (`products.discovered_product_id` FK) plus user-driven promotion buttons + read-side context injection. Reuses existing internal-secret server-to-server pattern, Vercel Workflow DevKit, and `viewer/member/admin` auth. Five sequential phases each ship as their own PR.

**Tech Stack:** Next.js 16 App Router · Supabase (Postgres + RLS) · Vercel Workflow DevKit · Google Gemini · TypeScript · No test framework configured — verification by `npx tsc --noEmit` + manual smoke tests + ad-hoc `scripts/check-*.ts` style scripts.

**Spec:** `docs/superpowers/specs/2026-05-20-research-cross-system-integration-design.md`

---

## File Structure

**Create:**
- `supabase/migrations/2026-05-20_research_discovery_link.sql` — schema linkage
- `lib/research/competitor-context.ts` — broadcasts context loader for synthesize prompt (P2)
- `lib/strategy/research-seed.ts` — `queryResearchPool` for MD-Strategy (P4)
- `app/api/discovery/[productId]/promote-to-research/route.ts` — promotion endpoint (P1+P5)
- `scripts/check-research-broadcast-context.ts` — smoke verifier for P2

**Modify:**
- `lib/gemini.ts` — extend `synthesizeResearch` signature (P2)
- `app/api/analyze/synthesize/route.ts` — call broadcast context loader (P2)
- `components/discovery/IntegrationActions.tsx` — add "リサーチ実施" button (P1)
- `app/[locale]/(document)/products/[id]/page.tsx` — add "台本生成" button (P3)
- `app/api/screenplays/route.ts` — enrich brief from `research_results` (P3)
- `lib/strategy/source-attribution.ts` — extend `AttributablePoolItem.pool_source` union (P4)
- `lib/md-strategy.ts` — merge research pool + extend sourceTag (P4)

---

## Phase A: Schema Migration

### Task A1: Write & apply migration

**Files:**
- Create: `supabase/migrations/2026-05-20_research_discovery_link.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- 2026-05-20_research_discovery_link.sql
-- Links Research-pipeline products back to their Discovery origin.

ALTER TABLE products
  ADD COLUMN discovered_product_id uuid NULL
  REFERENCES discovered_products(id) ON DELETE SET NULL;

CREATE INDEX idx_products_discovered_product_id
  ON products (discovered_product_id)
  WHERE discovered_product_id IS NOT NULL;

ALTER TABLE products
  ADD COLUMN ingest_source text NOT NULL DEFAULT 'file_upload'
  CHECK (ingest_source IN ('file_upload', 'discovery_promotion', 'manual_url'));
```

- [ ] **Step 2: Apply the migration**

Run via the project's standard migration path (Supabase CLI `supabase db push` or the dashboard SQL editor — the user should pick whichever they normally use). Verify with:

```sql
\d products
```

Expected: two new columns `discovered_product_id uuid` and `ingest_source text` with default `'file_upload'`. The index `idx_products_discovered_product_id` exists.

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: passes (no type changes yet, but verifies baseline).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-05-20_research_discovery_link.sql
git commit -m "feat(research): add discovered_product_id FK + ingest_source to products"
```

---

## Phase B: P2 — Broadcast-Context Injection in Synthesize

### Task B1: Create the broadcast context loader

**Files:**
- Create: `lib/research/competitor-context.ts`

- [ ] **Step 1: Write the loader module**

```typescript
// lib/research/competitor-context.ts
import { getServiceClient } from "@/lib/supabase";

export interface RecentAiring {
	channel: string;
	program_title: string | null;
	brand_name: string | null;
	air_date: string;
	start_time: string | null;
}

export interface OperatorFitSample {
	product_name: string;
	fit_score: number;
	summary: string | null;
}

export interface BroadcastContext {
	recentAirings: RecentAiring[];   // QVC + ShopCh, last 60d
	oaAirings: RecentAiring[];        // historical_broadcasts, last 60d
	operatorFit: {
		avg: number | null;
		count: number;
		top3: OperatorFitSample[];
	};
}

const LOOKBACK_DAYS = 60;
const FIT_LOOKBACK_DAYS = 90;

function isoDaysAgo(days: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString().slice(0, 10);
}

/**
 * Loads competitor airing + operator fit context for a category.
 * Returns null if category is null/empty (no meaningful query). All errors
 * are swallowed (logged) — the report still generates without this context.
 */
export async function loadBroadcastContext(
	category: string | null | undefined,
): Promise<BroadcastContext | null> {
	if (!category || category.trim().length === 0) return null;

	const sb = getServiceClient();
	const sinceBroadcasts = isoDaysAgo(LOOKBACK_DAYS);
	const sinceFit = isoDaysAgo(FIT_LOOKBACK_DAYS);

	try {
		const [recentRes, oaRes, fitRes] = await Promise.all([
			sb
				.from("broadcasts")
				.select("channel, program_title, brand_name, air_date, start_time")
				.eq("category", category)
				.gte("air_date", sinceBroadcasts)
				.order("air_date", { ascending: false })
				.limit(10),
			sb
				.from("historical_broadcasts")
				.select("channel, product_name, air_date, start_time")
				.eq("category", category)
				.gte("air_date", sinceBroadcasts)
				.order("air_date", { ascending: false })
				.limit(10),
			sb
				.from("competitor_fit_analyses")
				.select("product_name, fit_score, summary")
				.eq("category", category)
				.gte("created_at", sinceFit)
				.order("fit_score", { ascending: false })
				.limit(20),
		]);

		const recentAirings: RecentAiring[] = (recentRes.data ?? []).map((r) => ({
			channel: r.channel,
			program_title: r.program_title,
			brand_name: r.brand_name,
			air_date: r.air_date,
			start_time: r.start_time,
		}));

		const oaAirings: RecentAiring[] = (oaRes.data ?? []).map((r) => ({
			channel: r.channel,
			program_title: r.product_name,  // historical_broadcasts uses product_name as program label
			brand_name: null,
			air_date: r.air_date,
			start_time: r.start_time,
		}));

		const fitRows = fitRes.data ?? [];
		const avg =
			fitRows.length > 0
				? Math.round(
						fitRows.reduce((s, r) => s + (r.fit_score ?? 0), 0) / fitRows.length,
					)
				: null;
		const top3: OperatorFitSample[] = fitRows.slice(0, 3).map((r) => ({
			product_name: r.product_name ?? "",
			fit_score: r.fit_score ?? 0,
			summary: r.summary,
		}));

		return {
			recentAirings,
			oaAirings,
			operatorFit: { avg, count: fitRows.length, top3 },
		};
	} catch (err) {
		console.warn("[competitor-context] query failed:", err);
		return null;
	}
}

/**
 * Renders the BroadcastContext as a prompt section to inject into Gemini.
 * Returns empty string if context is null/empty — caller can concat unconditionally.
 */
export function formatBroadcastContextPrompt(ctx: BroadcastContext | null): string {
	if (!ctx) return "";
	const totalAirings = ctx.recentAirings.length + ctx.oaAirings.length;
	if (totalAirings === 0 && ctx.operatorFit.count === 0) return "";

	const brandLine =
		ctx.recentAirings.length > 0
			? Array.from(
					new Set(ctx.recentAirings.map((a) => a.brand_name).filter(Boolean)),
				)
					.slice(0, 5)
					.join(", ") || "(brand未取得)"
			: "(放送なし)";

	const programLine = ctx.recentAirings
		.slice(0, 5)
		.map((a) => `${a.channel}: ${a.program_title ?? "(no title)"}`)
		.join(" / ");

	const fitLine =
		ctx.operatorFit.avg !== null
			? `平均適合度 ${ctx.operatorFit.avg}/100 (n=${ctx.operatorFit.count}, 直近90日)`
			: "運営者評価データなし";

	const fitSamples = ctx.operatorFit.top3
		.map((s) => `- ${s.product_name} (${s.fit_score}点): ${s.summary ?? ""}`)
		.join("\n");

	return `
## 実測 経쟁사データ (社内DB 由来)
直近${LOOKBACK_DAYS}日のQVC + ShopCh + OA 7局における同カテゴリ放送:
- 総スロット数: QVC/ShopCh ${ctx.recentAirings.length}件 + OA ${ctx.oaAirings.length}件
- 上位ブランド: ${brandLine}
- 代表番組: ${programLine}

運営者キュレーション (competitor_fit_analyses):
${fitLine}
${fitSamples}

以下の Competitor / Seasonality セクションでは、上記の実測データを優先して引用し、Web検索結果は補助としてのみ使用すること。
`;
}
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit (intermediate)**

```bash
git add lib/research/competitor-context.ts
git commit -m "feat(research): add broadcast context loader for synthesize prompt"
```

### Task B2: Extend `synthesizeResearch` to accept broadcast context

**Files:**
- Modify: `lib/gemini.ts` (lines 175-198)

- [ ] **Step 1: Update the function signature and prompt**

Replace `lib/gemini.ts:175-198` (current `synthesizeResearch` opening) with:

```typescript
export async function synthesizeResearch(
	productInfo: ProductInfo,
	searchResults: Record<string, string>,
	broadcastContextPrompt?: string,
): Promise<ResearchOutput> {
	const modelName = "gemini-3-flash-preview";
	const model = genAI.getGenerativeModel({
		model: modelName,
		generationConfig: { maxOutputTokens: 16384 },
	});

	const prompt = `You are a home shopping marketing research analyst specializing in Japan market expansion. Based on the product information and web search results, generate a comprehensive research report.

IMPORTANT: ALL text fields in the JSON response MUST be written in Japanese (日本語). This includes marketability_description, demographics fields, influencer match_reason, content_ideas titles and descriptions, competitor key_difference, broadcast_scripts, recommended_price_range descriptions, and any other text. Only product names, URLs, and numeric values may remain in their original language.

Product Information:
${JSON.stringify(productInfo, null, 2)}

Web Search Results:
${Object.entries(searchResults)
			.map(([key, val]) => `## ${key}\n${val}`)
			.join("\n\n")}
${broadcastContextPrompt ?? ""}

${buildChannelReferencePrompt()}
```

(The rest of the prompt from `=== TV通販チャネル適合度 評価基準 ===` onward is unchanged.)

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: PASS. The third parameter is optional, so existing call sites still compile.

- [ ] **Step 3: Commit**

```bash
git add lib/gemini.ts
git commit -m "feat(research): extend synthesizeResearch with optional broadcast context"
```

### Task B3: Wire the loader into the synthesize route

**Files:**
- Modify: `app/api/analyze/synthesize/route.ts` (lines 51-60)

- [ ] **Step 1: Add the import and call**

At the top of `app/api/analyze/synthesize/route.ts`, add this import (next to existing imports):

```typescript
import {
	loadBroadcastContext,
	formatBroadcastContextPrompt,
} from "@/lib/research/competitor-context";
```

Then replace the body of the `try { ... }` block starting at line 51 (the section running `runProductResearch` and `synthesizeResearch`) with:

```typescript
		// Step 1: Run web research with Brave (includes Japan queries)
		console.log(`[${productId}] Running web research (incl. Japan market)...`);
		const searchResults = await runProductResearch(
			productInfo.name,
			productInfo.category,
		);

		// Step 1.5: Load broadcast context from internal DB (P2)
		console.log(`[${productId}] Loading broadcast context for category: ${productInfo.category}`);
		const broadcastContext = await loadBroadcastContext(productInfo.category);
		const broadcastContextPrompt = formatBroadcastContextPrompt(broadcastContext);

		// Step 2: Synthesize research with Gemini Pro
		console.log(`[${productId}] Synthesizing research with gemini-3-flash-preview...`);
		const research = await synthesizeResearch(
			productInfo,
			searchResults,
			broadcastContextPrompt,
		);
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit (intermediate, before smoke test)**

```bash
git add app/api/analyze/synthesize/route.ts
git commit -m "feat(research): inject broadcast context into Gemini synthesize prompt"
```

### Task B4: Smoke verify the broadcast context loader

**Files:**
- Create: `scripts/check-research-broadcast-context.ts`

- [ ] **Step 1: Write the verifier script**

```typescript
// scripts/check-research-broadcast-context.ts
// Run: tsx scripts/check-research-broadcast-context.ts <category>
// Verifies that loadBroadcastContext returns real data from current DB.

import {
	loadBroadcastContext,
	formatBroadcastContextPrompt,
} from "../lib/research/competitor-context";

const category = process.argv[2];
if (!category) {
	console.error("Usage: tsx scripts/check-research-broadcast-context.ts <category>");
	process.exit(1);
}

async function main() {
	console.log(`Loading broadcast context for category: ${category}`);
	const ctx = await loadBroadcastContext(category);
	if (!ctx) {
		console.log("→ returned null (empty category)");
		return;
	}
	console.log(`Recent QVC+ShopCh: ${ctx.recentAirings.length}`);
	console.log(`OA: ${ctx.oaAirings.length}`);
	console.log(`competitor_fit_analyses: avg=${ctx.operatorFit.avg}, count=${ctx.operatorFit.count}`);
	console.log("\n--- Formatted prompt section ---");
	console.log(formatBroadcastContextPrompt(ctx));
}

main().catch((err) => {
	console.error("FAILED:", err);
	process.exit(1);
});
```

- [ ] **Step 2: Run it against a known-populated category**

Pick a category present in `broadcasts.category` (e.g. `美容` or whatever is currently active in the DB). Run:

```bash
npx tsx scripts/check-research-broadcast-context.ts "美容"
```

Expected: prints non-zero counts for at least one of QVC/ShopCh/OA airings, prints a non-empty formatted prompt section. If all three are zero, try a different category — the script is fine, the DB just doesn't have data for that category yet.

- [ ] **Step 3: Manual report smoke test (optional but recommended)**

Upload a product file via the UI for a product in a category that has broadcasts. After ~3-5min, open the report at `/[locale]/products/[id]` and inspect the Competitor or Seasonality sections. Verify that brand names or program titles from `broadcasts.brand_name` appear in the AI-generated text. If the report still hallucinates brand names not in your DB, check that `productInfo.category` is being populated correctly.

- [ ] **Step 4: Commit the script**

```bash
git add scripts/check-research-broadcast-context.ts
git commit -m "test(research): add broadcast-context smoke verifier"
```

---

## Phase C: P1 + P5 — Discovery → Research Promotion (combined PR)

### Task C1: Create the promotion API route

**Files:**
- Create: `app/api/discovery/[productId]/promote-to-research/route.ts`

**Prerequisite:** Phase A migration applied.

- [ ] **Step 1: Write the route**

```typescript
// app/api/discovery/[productId]/promote-to-research/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 60;

interface CPackage {
	manufacturer?: string;
	wholesale_estimate?: { jpy?: number | null; notes?: string | null };
	moq_hint?: string | null;
	tv_script_draft?: {
		hook?: string;
		demo?: string;
		close?: string;
	};
	sns_trend?: { summary?: string };
}

function buildDescriptionFromCPackage(
	cp: CPackage | null,
	fallback: string | null,
): string {
	if (!cp) return fallback ?? "";
	const parts: string[] = [];
	if (cp.tv_script_draft?.hook) parts.push(cp.tv_script_draft.hook);
	if (cp.sns_trend?.summary) parts.push(cp.sns_trend.summary);
	if (cp.manufacturer) parts.push(`製造元: ${cp.manufacturer}`);
	return parts.join("\n\n").trim() || fallback || "";
}

function buildFeaturesFromCPackage(cp: CPackage | null): string[] {
	if (!cp) return [];
	const features: string[] = [];
	if (cp.manufacturer) features.push(`製造元: ${cp.manufacturer}`);
	if (cp.moq_hint) features.push(`MOQ: ${cp.moq_hint}`);
	if (cp.wholesale_estimate?.jpy) {
		features.push(`卸値推定: ¥${cp.wholesale_estimate.jpy.toLocaleString()}`);
	}
	if (cp.tv_script_draft?.demo) features.push(`デモ要点: ${cp.tv_script_draft.demo}`);
	return features;
}

function formatPriceRange(priceJpy: number | null): string | null {
	if (!priceJpy || priceJpy <= 0) return null;
	return `¥${priceJpy.toLocaleString()}`;
}

export async function POST(
	_request: NextRequest,
	{ params }: { params: Promise<{ productId: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { productId: dpId } = await params;
	if (!dpId) {
		return NextResponse.json({ error: "productId required" }, { status: 400 });
	}

	const sb = getServiceClient();

	// 1. Load the discovered product.
	const { data: dp, error: dpErr } = await sb
		.from("discovered_products")
		.select(
			"id, name, category, price_jpy, thumbnail_url, tv_fit_reason, c_package, enrichment_status",
		)
		.eq("id", dpId)
		.maybeSingle();

	if (dpErr) {
		console.error("[promote-to-research] load failed", dpErr);
		return NextResponse.json({ error: "load failed" }, { status: 500 });
	}
	if (!dp) {
		return NextResponse.json({ error: "discovered product not found" }, { status: 404 });
	}
	if (dp.enrichment_status !== "completed") {
		return NextResponse.json(
			{ error: "c_package not ready, run enrichment first" },
			{ status: 409 },
		);
	}

	// 2. Idempotency: if already promoted, return existing.
	const { data: existing } = await sb
		.from("products")
		.select("id")
		.eq("discovered_product_id", dpId)
		.maybeSingle();

	if (existing) {
		return NextResponse.json({
			productId: existing.id,
			alreadyPromoted: true,
		});
	}

	// 3. Insert products row.
	const cp = (dp.c_package as CPackage | null) ?? null;
	const insertPayload = {
		name: dp.name,
		description: buildDescriptionFromCPackage(cp, dp.tv_fit_reason),
		category: dp.category,
		features: buildFeaturesFromCPackage(cp),
		price_range: formatPriceRange(dp.price_jpy),
		target_market: null as string | null,
		status: "extracted" as const,
		ingest_source: "discovery_promotion" as const,
		discovered_product_id: dpId,
	};

	const { data: inserted, error: insErr } = await sb
		.from("products")
		.insert(insertPayload)
		.select("id")
		.single();

	if (insErr || !inserted) {
		console.error("[promote-to-research] insert failed", insErr);
		return NextResponse.json({ error: "promotion failed" }, { status: 500 });
	}
	const newProductId = inserted.id as string;

	// 4. Activate the dormant deep_dive learning signal (P5).
	const { error: fbErr } = await sb.from("product_feedback").insert({
		discovered_product_id: dpId,
		action: "deep_dive",
		reason: "promoted_to_research",
	});
	if (fbErr) {
		console.warn("[promote-to-research] deep_dive feedback insert failed", fbErr);
	}

	// 5. Fire-and-forget synthesize.
	const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
	fetch(`${baseUrl}/api/analyze/synthesize`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}`,
		},
		body: JSON.stringify({ productId: newProductId }),
	}).catch((err) => {
		console.error(`[promote-to-research:${newProductId}] synthesize trigger failed`, err);
	});

	return NextResponse.json({
		productId: newProductId,
		alreadyPromoted: false,
	});
}
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit (intermediate)**

```bash
git add app/api/discovery/[productId]/promote-to-research/route.ts
git commit -m "feat(discovery): add promote-to-research API route + deep_dive feedback"
```

### Task C2: Add the "リサーチ実施" button to IntegrationActions

**Files:**
- Modify: `components/discovery/IntegrationActions.tsx`

- [ ] **Step 1: Extend the component**

Replace the body of `IntegrationActions` (return statement and helper state) by adding a second button below the existing one. Full replacement of lines 30-89:

```tsx
	const t = useTranslations("discovery");
	const { locale } = useParams<{ locale: string }>();
	const router = useRouter();
	const [gateOpen, setGateOpen] = useState(false);
	const [promoting, setPromoting] = useState(false);
	const [promoteError, setPromoteError] = useState<string | null>(null);

	const targetPath =
		context === "live_commerce"
			? localePath(locale, "/analytics/strategy/live")
			: localePath(locale, "/analytics/strategy/expansion");

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

	const needGate = !hasCPackage && enrichmentStatus !== "completed";
	const canPromote = enrichmentStatus === "completed";

	function handleClick() {
		if (needGate) {
			setGateOpen(true);
		} else {
			router.push(href);
		}
	}

	async function handlePromote() {
		if (!canPromote || promoting) return;
		setPromoting(true);
		setPromoteError(null);
		try {
			const res = await fetch(`/api/discovery/${productId}/promote-to-research`, {
				method: "POST",
			});
			const json = await res.json();
			if (!res.ok) {
				setPromoteError(json.error ?? "promotion failed");
				return;
			}
			router.push(localePath(locale, `/products/${json.productId}`));
		} catch (err) {
			setPromoteError(err instanceof Error ? err.message : "unexpected error");
		} finally {
			setPromoting(false);
		}
	}

	return (
		<>
			<button
				type="button"
				onClick={handleClick}
				className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-800 text-xs font-semibold rounded-lg transition-colors"
			>
				{icon}
				{label}
			</button>
			<button
				type="button"
				onClick={handlePromote}
				disabled={!canPromote || promoting}
				className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 mt-2 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-800 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{promoting ? "リサーチ作成中…" : "リサーチ実施"}
			</button>
			{promoteError ? (
				<p className="mt-1 text-xs text-red-600">{promoteError}</p>
			) : null}
			<SeedEnrichGateModal
				open={gateOpen}
				onClose={() => setGateOpen(false)}
				productId={productId}
				onDone={() => {
					setGateOpen(false);
					router.push(href);
				}}
				onSkip={() => {
					setGateOpen(false);
					router.push(href);
				}}
			/>
		</>
	);
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Manual smoke test**

1. `npm run dev`
2. Open `/[locale]/analytics/discovery/home`.
3. Find a candidate card whose enrichment is completed.
4. Click "リサーチ実施". Expected: button shows "リサーチ作成中…", then redirects to `/[locale]/products/[newId]`.
5. The new product page should show status `analyzing` initially, then `completed` after ~3-5min.
6. In Supabase: verify `products.discovered_product_id = dpId` and `products.ingest_source = 'discovery_promotion'`.
7. In Supabase: verify a new row in `product_feedback` with `action='deep_dive'` and `reason='promoted_to_research'`.
8. Click "リサーチ実施" again on the same discovery card. Expected: same product page opens (idempotent — `alreadyPromoted: true`).

- [ ] **Step 4: Commit**

```bash
git add components/discovery/IntegrationActions.tsx
git commit -m "feat(discovery): add 'リサーチ実施' promotion button to candidate cards"
```

---

## Phase D: P3 — Research → Screenplay Button

### Task D1: Enrich screenplay brief from research_results

**Files:**
- Modify: `app/api/screenplays/route.ts` (around line 79-85)

- [ ] **Step 1: Add research enrichment after briefFromProduct**

Locate the `resolveBrief` function in `app/api/screenplays/route.ts`. After the line:

```typescript
const brief = briefFromProduct(product as ProductRow);
```

(currently at line 79) and before the customization override block, insert this enrichment:

```typescript
		// P3 enrichment: pull research_results if present
		const { data: research } = await supabase
			.from("research_results")
			.select("broadcast_scripts, demographics")
			.eq("product_id", product.id)
			.maybeSingle();

		if (research) {
			const sec60 = (research.broadcast_scripts as { sec60?: string } | null)?.sec60;
			if (sec60 && typeof sec60 === "string" && sec60.trim()) {
				brief.notes = brief.notes
					? `${brief.notes}\n\n--- AIリサーチ 60秒台本案 ---\n${sec60}`
					: sec60;
			}
			const demo = research.demographics as { target_audience?: string } | null;
			if (demo?.target_audience && typeof demo.target_audience === "string") {
				brief.customization = brief.customization ?? {};
				if (!brief.customization.targetAudience) {
					brief.customization.targetAudience = demo.target_audience;
				}
			}
		}
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit (intermediate)**

```bash
git add app/api/screenplays/route.ts
git commit -m "feat(screenplays): enrich brief with research_results when present"
```

### Task D2: Add "台本生成" button to product detail page

**Files:**
- Modify: `app/[locale]/(document)/products/[id]/page.tsx`

- [ ] **Step 1: Create a small client component for the button**

Create new file `components/report/GenerateScreenplayButton.tsx`:

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Clapperboard } from "lucide-react";
import { localePath } from "@/lib/i18n/locale-path";

interface Props {
	productId: string;
	locale: string;
}

export default function GenerateScreenplayButton({ productId, locale }: Props) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleClick() {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/screenplays", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ productId }),
			});
			const json = await res.json();
			if (!res.ok || !json.id) {
				setError(json.error ?? "台本生成に失敗しました");
				return;
			}
			router.push(localePath(locale, `/screenplays/${json.id}`));
		} catch (err) {
			setError(err instanceof Error ? err.message : "unexpected error");
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<button
				type="button"
				onClick={handleClick}
				disabled={busy}
				className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
			>
				<Clapperboard size={14} />
				{busy ? "台本作成中…" : "この商品で台本を生成"}
			</button>
			{error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
		</>
	);
}
```

- [ ] **Step 2: Add the button to the product detail page**

In `app/[locale]/(document)/products/[id]/page.tsx`, add the import near the other component imports:

```typescript
import GenerateScreenplayButton from "@/components/report/GenerateScreenplayButton";
```

Then locate the header `<div className="flex items-center justify-between mb-8 flex-wrap gap-4">` block (around lines 50-76). The right-side currently contains only `<PdfDownload />`. Replace the right-side conditional block with:

```tsx
        <div className="flex items-center gap-3 flex-wrap">
          {research && <GenerateScreenplayButton productId={product.id} locale={locale} />}
          {research && <PdfDownload product={product} research={research} />}
        </div>
```

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Manual smoke test**

1. `npm run dev`
2. Open any completed product report at `/[locale]/products/[id]`.
3. Verify a purple "この商品で台本を生成" button appears next to the PDF download button.
4. Click it. Expected: button shows "台本作成中…", redirects to `/[locale]/screenplays/[newId]`.
5. The screenplay should reference content from the research report — open the generated markdown and verify it includes phrasing similar to `research.broadcast_scripts.sec60` (which was injected via `brief.notes`).

- [ ] **Step 5: Commit**

```bash
git add components/report/GenerateScreenplayButton.tsx app/[locale]/(document)/products/[id]/page.tsx
git commit -m "feat(research): add 'generate screenplay from research' button"
```

---

## Phase E: P4 — MD-Strategy `pool_source: 'research'`

### Task E1: Extend the type unions

**Files:**
- Modify: `lib/strategy/source-attribution.ts` (lines 29-56)
- Modify: `lib/md-strategy.ts` (lines 440, 524)

- [ ] **Step 1: Extend `AttributablePoolItem` in source-attribution.ts**

In `lib/strategy/source-attribution.ts`, replace the type definitions at lines 29-56 with:

```typescript
export interface AttributablePoolItem {
	name: string;
	source_url: string;
	pool_source: "discovery_pool" | "fresh_search" | "research";
	discovered_product_id?: string;
}

export interface AttributableGeminiItem {
	name: string;
	source_url: string;
}

export interface AttributionStats {
	url: number;
	itemCode: number;
	nameFallback: number;
	unmatched: number;
}

export interface AttributionResult<T extends AttributableGeminiItem> {
	enriched: Array<
		T & {
			pool_source: "discovery_pool" | "fresh_search" | "research";
			discovered_product_id?: string;
		}
	>;
	stats: AttributionStats;
}
```

- [ ] **Step 2: Extend the unions in md-strategy.ts**

In `lib/md-strategy.ts`, change line 440:

```typescript
		pool_source?: "discovery_pool" | "fresh_search" | "seed" | "research";
```

and line 524:

```typescript
	pool_source: "discovery_pool" | "fresh_search" | "research";
```

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: PASS. Any downstream switches on `pool_source` may now have unhandled cases — the next task fills the prompt rendering branch.

- [ ] **Step 4: Commit (intermediate)**

```bash
git add lib/strategy/source-attribution.ts lib/md-strategy.ts
git commit -m "refactor(strategy): widen pool_source union to include 'research'"
```

### Task E2: Create the research pool query helper

**Files:**
- Create: `lib/strategy/research-seed.ts`

- [ ] **Step 1: Write the helper module**

```typescript
// lib/strategy/research-seed.ts
import { getServiceClient } from "@/lib/supabase";
import { mapUiCategoryToSalesCategories } from "@/lib/strategy/category-mapping";

export interface ResearchPoolItem {
	name: string;
	price?: number;
	source: "research";
	source_url: string;
	snippet: string;
	keyword: string;
	reviewCount?: number;
	reviewAverage?: number;
	pool_source: "research";
	discovered_product_id?: string;     // populated if the research product was promoted from Discovery
	tv_fit_score?: number;               // synthetic: research_results.japan_export_fit_score
	tv_fit_reason?: string;
	tv_channel_source?: string | null;
	c_package?: Record<string, unknown> | null;
}

export interface ResearchPoolInput {
	context: "home_shopping" | "live_commerce";
	uiCategory?: string;
	priceRange?: { min: number; max: number };
	limit: number;
}

const FAIL_OPEN_THRESHOLD = 5;
const DEFAULT_LOOKBACK_DAYS = 60;

function isoDaysAgo(days: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString();
}

interface ProductWithResearch {
	id: string;
	name: string;
	category: string | null;
	description: string | null;
	discovered_product_id: string | null;
	created_at: string;
	research_results: Array<{
		japan_export_fit_score: number | null;
		marketability_description: string | null;
		demographics: unknown;
	}> | null;
}

/**
 * Loads candidate products from the Research pipeline (completed reports
 * with japan_export_fit_score >= 60) as a fourth pool_source for
 * MD-Strategy. Returns at most `input.limit` items.
 *
 * Filters mirror queryDiscoveredPool's fail-open behavior on category and
 * price filters so the pool stays usable even when intent is narrow.
 */
export async function queryResearchPool(
	input: ResearchPoolInput,
): Promise<ResearchPoolItem[]> {
	const lookbackDays = Number(process.env.STRATEGY_POOL_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS);
	const sinceIso = isoDaysAgo(lookbackDays);
	const sb = getServiceClient();

	// Over-fetch to give filters room.
	const fetchLimit = Math.min(200, Math.max(input.limit * 5, 20));

	const { data, error } = await sb
		.from("products")
		.select(
			`id, name, category, description, discovered_product_id, created_at,
			 research_results!inner(japan_export_fit_score, marketability_description, demographics)`,
		)
		.eq("status", "completed")
		.gte("created_at", sinceIso)
		.order("created_at", { ascending: false })
		.limit(fetchLimit);

	if (error) {
		console.warn("[research-seed] query failed:", error.message);
		return [];
	}

	const rows = (data ?? []) as ProductWithResearch[];

	// Filter: japan_export_fit_score >= 60 (strict — no fail-open here).
	const scored = rows
		.map((r) => {
			const rr = Array.isArray(r.research_results) ? r.research_results[0] : null;
			return { row: r, research: rr };
		})
		.filter(
			(x) => x.research?.japan_export_fit_score != null && x.research.japan_export_fit_score >= 60,
		);

	// Category filter with fail-open.
	let afterCategory = scored;
	if (input.uiCategory && scored.length >= FAIL_OPEN_THRESHOLD) {
		const targets = mapUiCategoryToSalesCategories(input.uiCategory);
		const uiTokens = input.uiCategory.split("・").map((s) => s.trim()).filter(Boolean);
		const matchTerms = Array.from(
			new Set([...targets, input.uiCategory, ...uiTokens].filter((s) => s.length > 0)),
		);
		const filtered = scored.filter((x) =>
			matchTerms.some((term) =>
				(x.row.category ?? "").toLowerCase().includes(term.toLowerCase()),
			),
		);
		if (filtered.length >= FAIL_OPEN_THRESHOLD) {
			afterCategory = filtered;
		}
	}

	// Map to ResearchPoolItem.
	const items: ResearchPoolItem[] = afterCategory.slice(0, input.limit).map((x) => ({
		name: x.row.name,
		source: "research" as const,
		source_url: `/products/${x.row.id}`,
		snippet: (x.research?.marketability_description ?? x.row.description ?? "").slice(0, 280),
		keyword: x.row.category ?? "",
		pool_source: "research" as const,
		discovered_product_id: x.row.discovered_product_id ?? undefined,
		tv_fit_score: x.research?.japan_export_fit_score ?? undefined,
		tv_fit_reason: x.research?.marketability_description ?? undefined,
		tv_channel_source: null,
		c_package: null,
	}));

	return items;
}
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit (intermediate)**

```bash
git add lib/strategy/research-seed.ts
git commit -m "feat(strategy): add queryResearchPool helper for research-sourced candidates"
```

### Task E3: Integrate research pool into discoverNewProducts + extend prompt sourceTag

**Files:**
- Modify: `lib/md-strategy.ts` (around line 579-606 for pool merge, line 824-827 for sourceTag)

- [ ] **Step 1: Add the import and integration**

In `lib/md-strategy.ts`, add this import near the other strategy imports (look for existing `import { queryDiscoveredPool }` or similar):

```typescript
import { queryResearchPool } from "@/lib/strategy/research-seed";
```

- [ ] **Step 2: Merge research pool after the discovery pool query**

In `discoverNewProducts`, after the existing `queryDiscoveredPool` call (around `lib/md-strategy.ts:579-606`), find where `cappedPool` is built. After the discovery pool is mapped to `DiscoveryPoolItem[]`, insert:

```typescript
		// P4: fetch research-sourced candidates (cap at 20% of TARGET)
		const researchCap = Math.floor(TARGET * 0.2);
		const researchItems =
			researchCap > 0
				? await queryResearchPool({
						context: input.context,
						uiCategory: input.uiCategory,
						priceRange: input.priceRange,
						limit: researchCap,
					})
				: [];

		// Merge into pool. Order: discovery_pool first (existing), then research, then fresh later.
		const researchMapped: DiscoveryPoolItem[] = researchItems.map((r) => ({
			name: r.name,
			price: r.price,
			source: "web",            // research source presents as a web-like card
			source_url: r.source_url,
			snippet: r.snippet,
			keyword: r.keyword,
			pool_source: "research" as const,
			discovered_product_id: r.discovered_product_id,
			tv_fit_score: r.tv_fit_score,
			tv_fit_reason: r.tv_fit_reason,
			tv_channel_source: r.tv_channel_source,
			c_package: r.c_package,
		}));
```

Then where `cappedPool` is assembled (immediately after the existing pool mapping), append: `cappedPool.push(...researchMapped);` — exact line depends on the local variable name; use the closest `cappedPool.push(...)` site as the model, or splice in immediately after pool items are added and before fresh-search fill.

**Note:** The exact line to splice depends on the surrounding flow; the implementer should read `lib/md-strategy.ts:560-700` and place the merge between the pool query and the `fillNeeded > 0` fresh-search branch.

- [ ] **Step 3: Extend the sourceTag rendering at line 824-827**

Replace the `sourceTag` ternary at lines 824-827 with:

```typescript
				const sourceTag =
					p.pool_source === "discovery_pool"
						? `🟣[発掘プール TVフィット:${p.tv_fit_score ?? "?"}${p.tv_channel_source ? ` 放送実績:${p.tv_channel_source}` : ""}]`
						: p.pool_source === "research"
							? `🟡[リサーチ 日本適合:${p.tv_fit_score ?? "?"}]`
							: `🟢[新検索 ${p.source}]`;
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Manual smoke test**

1. Ensure you have at least one product with `status='completed'` and `research_results.japan_export_fit_score >= 60` in the DB. If not, complete a Research report manually first (or use a category that has one).
2. `npm run dev`
3. Open the MD-Strategy panel, run a strategy with a category that matches the completed research product.
4. Inspect the generated strategy output (either the Gemini prompt log or the saved `md_strategies.discovered_new_products` JSON).
5. Verify at least one candidate has `pool_source: 'research'` and the prompt rendering shows the 🟡 [リサーチ ...] tag.

- [ ] **Step 6: Commit**

```bash
git add lib/md-strategy.ts
git commit -m "feat(strategy): merge research pool as 4th candidate source in MD-Strategy"
```

---

## Self-Review Notes (Plan Author)

Reviewed against the spec at `docs/superpowers/specs/2026-05-20-research-cross-system-integration-design.md`:

- **Spec coverage:**
  - G1 (synthesize reads broadcasts) → Task B1-B4 ✓
  - G2 (one-click Discovery → Research) → Task C1-C2 ✓
  - G3 (Research → Screenplay) → Task D1-D2 ✓
  - G4 (MD-Strategy 4th pool_source) → Task E1-E3 ✓
  - G5 (activate deep_dive) → Inside Task C1, step 4 ✓
  - Migration (§6.1) → Task A1 ✓
- **Placeholder scan:** Task E3 Step 2 has a known indeterminacy: "the exact line to splice depends on the surrounding flow" because `lib/md-strategy.ts` is 1300+ lines and the implementer should pick the natural splice point. This is intentional rather than hand-waving — the rule is "after pool query, before fresh fill".
- **Type consistency:** `pool_source: 'discovery_pool' | 'fresh_search' | 'research'` is consistent across `source-attribution.ts`, `md-strategy.ts:524`, and the new `research-seed.ts`. The orphan `'seed'` value (mentioned in spec Q3) is deliberately left untouched on line 440 of `md-strategy.ts` since it's already deferred.
- **Out-of-scope:** OOS-1 (auth bug), OOS-2 (whitelist divergence), OOS-3 (raw_json normalization), OOS-4 (deprecate fuzzy match), OOS-5 (retry synthesis) all explicitly NOT included.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-20-research-cross-system-integration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
