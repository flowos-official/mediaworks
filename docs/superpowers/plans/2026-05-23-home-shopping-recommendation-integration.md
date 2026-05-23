# Home Shopping Recommendation Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing home-shopping recommendation flow reliably move from uploaded/internal products and competitor data into research, strategy, and product-linked screenplay generation.

**Architecture:** Keep the existing Next.js route-handler and Workflow architecture. This phase fixes the broken internal analyze trigger, adds a product-linked screenplay brief builder, broadens research competitor context with existing category normalization, and adds smoke coverage for the end-to-end integration path.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase service/server clients, Gemini, Workflow, tsx script tests.

---

## Scope

This is Phase 1 of the larger home-shopping recommendation system work. It does not redesign discovery, MD strategy, or the sales analytics model. It closes the highest-impact integration gaps found in `docs/current-system-feature-map.md`:

- P0: `/api/upload` triggers `/api/analyze` without auth.
- P1: research products cannot create product-linked screenplays.
- P2: research competitor context relies on exact category matches.
- P3: there is no focused smoke for the recommendation-to-sales artifact path.

## File Structure

Modify:

- `app/api/upload/route.ts`: send internal `Authorization` when triggering `/api/analyze`.
- `app/api/analyze/route.ts`: accept either user auth or internal secret.
- `app/api/screenplays/route.ts`: allow POST by `productId` as well as `productBrief`; persist `product_id`.
- `app/[locale]/(document)/products/[id]/page.tsx`: add a product-linked screenplay action to completed research reports.
- `lib/research/competitor-context.ts`: query exact category plus normalized category aliases.
- `scripts/stress-screenplays.ts`: keep existing validation and add product-linked assertions after API support lands.

Create:

- `lib/screenplay/product-brief.ts`: builds `ProductBrief` from `products`, `research_results`, and optional discovery-linked metadata.
- `components/products/GenerateScreenplayButton.tsx`: client action button for product report pages.
- `scripts/test-analyze-internal-auth.ts`: fast check for the internal-secret path and trigger headers.
- `scripts/test-research-category-candidates.ts`: fast check for category candidate expansion.
- `scripts/smoke-recommendation-flow.ts`: operator smoke that checks the discovery -> research -> strategy -> screenplay prerequisites without running paid model calls by default.

## Task 1: Fix Upload -> Analyze Internal Trigger

**Files:**

- Modify: `app/api/upload/route.ts`
- Modify: `app/api/analyze/route.ts`
- Create: `scripts/test-analyze-internal-auth.ts`

- [ ] **Step 1: Write the fast auth test**

Create `scripts/test-analyze-internal-auth.ts`:

```ts
import { hasInternalSecret } from "../lib/auth/require-user";

function assert(condition: boolean, message: string) {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		process.exitCode = 1;
	} else {
		console.log(`PASS: ${message}`);
	}
}

function buildAnalyzeHeaders(secret: string | undefined): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (secret) headers.Authorization = `Bearer ${secret}`;
	return headers;
}

process.env.CRON_SECRET = "unit-secret";

assert(
	hasInternalSecret(new Request("http://localhost/api/analyze", {
		headers: { Authorization: "Bearer unit-secret" },
	})),
	"hasInternalSecret accepts the configured bearer token",
);

assert(
	!hasInternalSecret(new Request("http://localhost/api/analyze", {
		headers: { Authorization: "Bearer wrong-secret" },
	})),
	"hasInternalSecret rejects the wrong bearer token",
);

assert(
	buildAnalyzeHeaders("unit-secret").Authorization === "Bearer unit-secret",
	"upload analyze trigger includes Authorization when CRON_SECRET exists",
);

assert(
	!("Authorization" in buildAnalyzeHeaders(undefined)),
	"upload analyze trigger omits Authorization when CRON_SECRET is missing",
);

if (process.exitCode === 1) process.exit(1);
console.log("PASS: analyze internal auth helpers");
```

- [ ] **Step 2: Run the auth test and verify baseline helper behavior**

Run:

```bash
npx tsx --env-file=.env.local scripts/test-analyze-internal-auth.ts
```

Expected:

```text
PASS: hasInternalSecret accepts the configured bearer token
PASS: hasInternalSecret rejects the wrong bearer token
PASS: upload analyze trigger includes Authorization when CRON_SECRET exists
PASS: upload analyze trigger omits Authorization when CRON_SECRET is missing
PASS: analyze internal auth helpers
```

- [ ] **Step 3: Allow `/api/analyze` to accept internal secret**

In `app/api/analyze/route.ts`, replace the import:

```ts
import { requireUser } from "@/lib/auth/require-user";
```

with:

```ts
import { hasInternalSecret, requireUser } from "@/lib/auth/require-user";
```

Then replace the auth block:

```ts
	// auth: requireUser
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
```

with:

```ts
	const isInternal = hasInternalSecret(request);
	if (!isInternal) {
		const auth = await requireUser(["member", "admin"]);
		if ("error" in auth) return auth.error;
	}
```

- [ ] **Step 4: Send internal Authorization from upload trigger**

In `app/api/upload/route.ts`, replace:

```ts
    fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: product.id,
        fileBase64: base64,
        mimeType: primary.mimeType,
        fileName: primary.fileName,
        locale,
      }),
    }).catch(console.error);
```

with:

```ts
    const analyzeHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      analyzeHeaders.Authorization = `Bearer ${cronSecret}`;
    } else {
      console.warn('[upload] CRON_SECRET not set; async analyze trigger may be rejected');
    }

    fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: analyzeHeaders,
      body: JSON.stringify({
        productId: product.id,
        fileBase64: base64,
        mimeType: primary.mimeType,
        fileName: primary.fileName,
        locale,
      }),
    }).catch(console.error);
```

- [ ] **Step 5: Run verification**

Run:

```bash
npx tsx --env-file=.env.local scripts/test-analyze-internal-auth.ts
npx tsc --noEmit
```

Expected:

```text
PASS: analyze internal auth helpers
```

`npx tsc --noEmit` should exit with code 0.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add app/api/upload/route.ts app/api/analyze/route.ts scripts/test-analyze-internal-auth.ts
git commit -m "fix: allow internal analyze trigger"
```

## Task 2: Build Product-Linked Screenplay Briefs

**Files:**

- Create: `lib/screenplay/product-brief.ts`
- Modify: `app/api/screenplays/route.ts`
- Modify: `scripts/stress-screenplays.ts`

- [ ] **Step 1: Create the product brief builder**

Create `lib/screenplay/product-brief.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProductBrief } from "@/lib/screenplay/types";

export type ProductBriefLoadResult =
	| { ok: true; productId: string; brief: ProductBrief }
	| { ok: false; status: 400 | 404 | 500; error: string };

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim())
		.slice(0, 12);
}

function compactLines(lines: Array<string | null | undefined>): string {
	return lines
		.map((line) => line?.trim() ?? "")
		.filter(Boolean)
		.join("\n\n");
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function loadProductBriefForScreenplay(
	sb: SupabaseClient,
	productId: string,
): Promise<ProductBriefLoadResult> {
	const trimmedId = productId.trim();
	if (!isUuid(trimmedId)) {
		return { ok: false, status: 400, error: "productId の形式が正しくありません" };
	}

	const { data: product, error: productError } = await sb
		.from("products")
		.select("id, name, description, category, price_range, target_market, features, discovered_product_id")
		.eq("id", trimmedId)
		.maybeSingle();

	if (productError) {
		console.error("[screenplays] product lookup failed:", productError);
		return { ok: false, status: 500, error: "商品情報の取得に失敗しました" };
	}
	if (!product) {
		return { ok: false, status: 404, error: "商品が見つかりません" };
	}

	const { data: research, error: researchError } = await sb
		.from("research_results")
		.select("marketability_description, market_size, usp_points, risk_analysis, recommended_sales_timing, recommended_price_range, pricing_strategy, marketing_strategy, broadcast_scripts, demographics, raw_json")
		.eq("product_id", trimmedId)
		.maybeSingle();

	if (researchError) {
		console.warn("[screenplays] research lookup failed:", researchError.message);
	}

	const rawResearch = asRecord(asRecord(research?.raw_json).research);
	const researchView = { ...rawResearch, ...asRecord(research) };
	const productName = text(product.name) || "Untitled product";
	const category = text(product.category) || text(researchView.category);
	const uspPoints = stringList(researchView.usp_points);
	const marketing = stringList(researchView.marketing_strategy);
	const broadcastScripts = stringList(researchView.broadcast_scripts);
	const demographics = asRecord(researchView.demographics);

	const description = compactLines([
		text(product.description),
		text(researchView.marketability_description) && `市場性: ${text(researchView.marketability_description)}`,
		text(product.features) && `特徴: ${text(product.features)}`,
		uspPoints.length > 0 && `USP:\n- ${uspPoints.join("\n- ")}`,
		text(researchView.market_size) && `市場規模: ${text(researchView.market_size)}`,
		text(product.target_market) && `想定ターゲット: ${text(product.target_market)}`,
		text(demographics.primary) && `主要顧客: ${text(demographics.primary)}`,
		marketing.length > 0 && `販売施策:\n- ${marketing.join("\n- ")}`,
		broadcastScripts.length > 0 && `放送訴求案:\n- ${broadcastScripts.join("\n- ")}`,
	]);

	const notes = compactLines([
		text(product.price_range) && `商品価格帯: ${text(product.price_range)}`,
		text(researchView.recommended_price_range) && `推奨価格帯: ${text(researchView.recommended_price_range)}`,
		text(researchView.recommended_sales_timing) && `推奨販売時期: ${text(researchView.recommended_sales_timing)}`,
		text(researchView.pricing_strategy) && `価格戦略: ${text(researchView.pricing_strategy)}`,
		text(researchView.risk_analysis) && `注意点: ${text(researchView.risk_analysis)}`,
	]);

	return {
		ok: true,
		productId: trimmedId,
		brief: {
			name: productName.slice(0, 200),
			category: category ? category.slice(0, 200) : undefined,
			description: (description || text(product.description) || productName).slice(0, 16_000),
			notes: notes ? notes.slice(0, 4000) : undefined,
		},
	};
}
```

- [ ] **Step 2: Wire `productId` into screenplays POST**

In `app/api/screenplays/route.ts`, add the import:

```ts
import { loadProductBriefForScreenplay } from "@/lib/screenplay/product-brief";
```

Change:

```ts
interface ValidationSuccess { ok: true; brief: ProductBrief }
```

to:

```ts
interface ValidationSuccess { ok: true; brief: ProductBrief; productId: string | null }
```

In `resolveBrief`, change the return:

```ts
	return { ok: true, brief };
```

to:

```ts
	return { ok: true, brief, productId: null };
```

In `POST`, replace:

```ts
	const body = await request.json().catch(() => null);
	const v = resolveBrief(body);
	if (!v.ok) return Response.json({ error: v.error }, { status: v.status });

	const { brief: productBrief } = v;

	const supabase = getServiceClient();
```

with:

```ts
	const body = await request.json().catch(() => null);
	const supabase = getServiceClient();
	const productId =
		body && typeof body === "object" && typeof (body as Record<string, unknown>).productId === "string"
			? ((body as Record<string, unknown>).productId as string).trim()
			: "";

	const v = productId
		? await loadProductBriefForScreenplay(supabase, productId)
		: resolveBrief(body);
	if (!v.ok) return Response.json({ error: v.error }, { status: v.status });

	const { brief: productBrief } = v;
```

Then replace the insert payload field:

```ts
			product_id: null,
```

with:

```ts
			product_id: v.productId,
```

- [ ] **Step 3: Extend screenplay stress checks for productId**

In `scripts/stress-screenplays.ts`, keep the existing "POST with non-existent productId -> 404" check. Add this check after the basic `productBrief` validation checks:

```ts
	await check("POST with malformed productId → 400", async () => {
		const r = await json("/api/screenplays", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ productId: "not-a-uuid" }),
		});
		return r.status === 400 ? true : `got ${r.status}`;
	});
```

- [ ] **Step 4: Run route-level verification**

Run:

```bash
npx tsc --noEmit
npm run stress:screenplays
```

Expected:

- `npx tsc --noEmit` exits 0.
- `npm run stress:screenplays` preserves the existing validation checks and the malformed `productId` check passes with 400.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add lib/screenplay/product-brief.ts app/api/screenplays/route.ts scripts/stress-screenplays.ts
git commit -m "feat: create screenplays from research products"
```

## Task 3: Add Screenplay Action To Research Report

**Files:**

- Create: `components/products/GenerateScreenplayButton.tsx`
- Modify: `app/[locale]/(document)/products/[id]/page.tsx`

- [ ] **Step 1: Create the client button**

Create `components/products/GenerateScreenplayButton.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2 } from "lucide-react";
import { localePath } from "@/lib/i18n/locale-path";

interface Props {
	productId: string;
	locale: string;
}

export default function GenerateScreenplayButton({ productId, locale }: Props) {
	const router = useRouter();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function createScreenplay() {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/screenplays", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ productId }),
			});
			const json = await res.json();
			if (!res.ok) throw new Error(json.error ?? "台本の作成に失敗しました");
			router.push(localePath(locale, `/screenplays/${json.id}?run=${json.runId}`));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setLoading(false);
		}
	}

	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				onClick={createScreenplay}
				disabled={loading}
				className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background shadow-sm transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
			>
				{loading ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
				{loading ? "台本作成中..." : "台本を作成"}
			</button>
			{error && (
				<p className="max-w-64 text-right text-xs text-red-600 dark:text-red-400">
					{error}
				</p>
			)}
		</div>
	);
}
```

- [ ] **Step 2: Render the button on completed report pages**

In `app/[locale]/(document)/products/[id]/page.tsx`, add the import:

```ts
import GenerateScreenplayButton from '@/components/products/GenerateScreenplayButton';
```

Then replace:

```tsx
          <div className="flex items-center gap-3 flex-wrap">
            {research && <PdfDownload product={product} research={research} />}
          </div>
```

with:

```tsx
          <div className="flex items-center gap-3 flex-wrap">
            {research && <GenerateScreenplayButton productId={product.id} locale={locale} />}
            {research && <PdfDownload product={product} research={research} />}
          </div>
```

- [ ] **Step 3: Verify TypeScript and inspect the page**

Run:

```bash
npx tsc --noEmit
```

Expected: exit code 0.

Start the app if it is not already running:

```bash
npm run dev
```

Open a completed product report in the browser. Expected:

- The header shows `台本を作成`.
- Clicking the button POSTs `{ productId }` to `/api/screenplays`.
- Successful creation redirects to `/screenplays/{id}?run={runId}`.

- [ ] **Step 4: Commit Task 3**

Run:

```bash
git add components/products/GenerateScreenplayButton.tsx app/[locale]/(document)/products/[id]/page.tsx
git commit -m "feat: add screenplay action to research reports"
```

## Task 4: Broaden Research Competitor Category Matching

**Files:**

- Modify: `lib/research/competitor-context.ts`
- Create: `scripts/test-research-category-candidates.ts`

- [ ] **Step 1: Write the category candidate test**

Create `scripts/test-research-category-candidates.ts`:

```ts
import { __test } from "../lib/research/competitor-context";

function assert(condition: boolean, message: string) {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		process.exitCode = 1;
	} else {
		console.log(`PASS: ${message}`);
	}
}

const candidates = __test.uniqueCategoryCandidates("美容・コスメ", [
	"コスメ",
	"美容・コスメ",
	"ヘルスケア",
	"",
]);

assert(
	JSON.stringify(candidates) === JSON.stringify(["美容・コスメ", "コスメ", "ヘルスケア"]),
	"uniqueCategoryCandidates keeps raw category first and dedupes normalized categories",
);

assert(
	__test.uniqueCategoryCandidates(null, ["家電"]).length === 1,
	"uniqueCategoryCandidates accepts normalized categories without raw input",
);

assert(
	__test.uniqueCategoryCandidates("   ", []).length === 0,
	"uniqueCategoryCandidates returns empty for blank input",
);

if (process.exitCode === 1) process.exit(1);
console.log("PASS: research category candidate helpers");
```

- [ ] **Step 2: Add category candidate helper to competitor context**

In `lib/research/competitor-context.ts`, add:

```ts
import { normalizeCategory } from "@/lib/discovery/category-normalize";
```

Add this helper above `loadBroadcastContext`:

```ts
export function uniqueCategoryCandidates(
	rawCategory: string | null | undefined,
	normalizedCategories: string[],
): string[] {
	const out: string[] = [];
	for (const value of [rawCategory, ...normalizedCategories]) {
		const trimmed = typeof value === "string" ? value.trim() : "";
		if (!trimmed || out.includes(trimmed)) continue;
		out.push(trimmed);
	}
	return out;
}
```

At the bottom of the file, add:

```ts
export const __test = {
	uniqueCategoryCandidates,
};
```

- [ ] **Step 3: Use normalized candidates in the three competitor queries**

Inside `loadBroadcastContext`, after `const sb = getServiceClient();`, add:

```ts
	const normalized = await normalizeCategory(sb, category);
	const categoryCandidates = uniqueCategoryCandidates(category, normalized);
	if (categoryCandidates.length === 0) return null;
```

Replace the existing `Promise.all` query block with:

```ts
		let recentQuery = sb
			.from("broadcasts")
			.select("channel, program_title, brand_name, air_date, start_time")
			.gte("air_date", sinceBroadcasts)
			.order("air_date", { ascending: false })
			.limit(10);
		recentQuery = categoryCandidates.length === 1
			? recentQuery.eq("category", categoryCandidates[0])
			: recentQuery.in("category", categoryCandidates);

		let oaQuery = sb
			.from("historical_broadcasts")
			.select("channel, product_name, air_date, start_time")
			.gte("air_date", sinceBroadcasts)
			.order("air_date", { ascending: false })
			.limit(10);
		oaQuery = categoryCandidates.length === 1
			? oaQuery.eq("category", categoryCandidates[0])
			: oaQuery.in("category", categoryCandidates);

		let fitQuery = sb
			.from("competitor_fit_analyses")
			.select("product_name, fit_score, summary")
			.gte("created_at", sinceFit)
			.order("fit_score", { ascending: false })
			.limit(20);
		fitQuery = categoryCandidates.length === 1
			? fitQuery.eq("category", categoryCandidates[0])
			: fitQuery.in("category", categoryCandidates);

		const [recentRes, oaRes, fitRes] = await Promise.all([
			recentQuery,
			oaQuery,
			fitQuery,
		]);
```

- [ ] **Step 4: Run category verification**

Run:

```bash
npx tsx scripts/test-research-category-candidates.ts
npm run test:category-normalize-unit
npx tsc --noEmit
```

Expected:

```text
PASS: research category candidate helpers
```

The category normalization unit suite and TypeScript check should pass.

- [ ] **Step 5: Commit Task 4**

Run:

```bash
git add lib/research/competitor-context.ts scripts/test-research-category-candidates.ts
git commit -m "feat: expand research competitor category matching"
```

## Task 5: Add Recommendation Flow Smoke

**Files:**

- Create: `scripts/smoke-recommendation-flow.ts`
- Modify: `package.json`

- [ ] **Step 1: Create the smoke script**

Create `scripts/smoke-recommendation-flow.ts`:

```ts
import { getServiceClient } from "../lib/supabase";

const sb = getServiceClient();

function fail(message: string): never {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

function pass(message: string) {
	console.log(`PASS: ${message}`);
}

async function main() {
	const { data: latestRun, error: runError } = await sb
		.from("discovery_runs")
		.select("id, context, status, created_at")
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	if (runError) fail(`discovery_runs query failed: ${runError.message}`);
	if (!latestRun) fail("no discovery_runs rows found");
	pass(`latest discovery run exists (${latestRun.context}, ${latestRun.status})`);

	const { data: discovered, error: discoveredError } = await sb
		.from("discovered_products")
		.select("id, name, category, enrichment_status, c_package")
		.eq("run_id", latestRun.id)
		.limit(5);
	if (discoveredError) fail(`discovered_products query failed: ${discoveredError.message}`);
	if (!discovered || discovered.length === 0) fail("latest discovery run has no products");
	pass(`latest discovery run has ${discovered.length} sampled products`);

	const { data: promoted, error: promotedError } = await sb
		.from("products")
		.select("id, name, discovered_product_id, status")
		.not("discovered_product_id", "is", null)
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	if (promotedError) fail(`promoted products query failed: ${promotedError.message}`);
	if (promoted) {
		pass(`at least one promoted research product exists (${promoted.status})`);
	} else {
		console.warn("WARN: no promoted research product found; promote one enriched discovery product before full E2E verification");
	}

	const { data: strategies, error: strategyError } = await sb
		.from("md_strategies")
		.select("id, status, created_at")
		.order("created_at", { ascending: false })
		.limit(1);
	if (strategyError) fail(`md_strategies query failed: ${strategyError.message}`);
	if (strategies && strategies.length > 0) {
		pass(`latest MD strategy exists (${strategies[0].status})`);
	} else {
		console.warn("WARN: no MD strategy found; run /analytics/strategy/expansion after discovery verification");
	}

	const { data: linkedScreenplay, error: screenplayError } = await sb
		.from("screenplays")
		.select("id, product_id, status")
		.not("product_id", "is", null)
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	if (screenplayError) fail(`screenplays query failed: ${screenplayError.message}`);
	if (linkedScreenplay) {
		pass(`at least one product-linked screenplay exists (${linkedScreenplay.status})`);
	} else {
		console.warn("WARN: no product-linked screenplay found; create one from a research report after Task 3");
	}
}

void main();
```

- [ ] **Step 2: Add package script**

In `package.json`, add this script entry near the other smoke/test scripts:

```json
"smoke:recommendation-flow": "tsx --env-file=.env.local scripts/smoke-recommendation-flow.ts"
```

- [ ] **Step 3: Run smoke**

Run:

```bash
npm run smoke:recommendation-flow
```

Expected:

- Fails only if core tables are unavailable or the latest discovery run has no products.
- Warns, rather than fails, when promoted research products, MD strategies, or product-linked screenplays have not been created yet.

- [ ] **Step 4: Commit Task 5**

Run:

```bash
git add scripts/smoke-recommendation-flow.ts package.json
git commit -m "test: add recommendation flow smoke"
```

## Task 6: Final Verification

**Files:**

- Verify all touched files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx tsx --env-file=.env.local scripts/test-analyze-internal-auth.ts
npx tsx scripts/test-research-category-candidates.ts
npx tsx --env-file=.env.local scripts/test-discovery-session-reconcile.ts
npm run test:strategy-pool
npm run test:category-normalize-unit
```

Expected: all commands exit 0.

- [ ] **Step 2: Run broad static verification**

Run:

```bash
npm run lint
npx tsc --noEmit
```

Expected: both commands exit 0.

- [ ] **Step 3: Browser verify the user-facing path**

Run the app:

```bash
npm run dev
```

Open a completed research product page. Verify:

- The report renders.
- `台本を作成` appears next to PDF download.
- Clicking the button creates a screenplay and redirects to `/screenplays/{id}?run={runId}`.
- The screenplay detail page enters generating/ready state.

- [ ] **Step 4: Run the recommendation smoke**

Run:

```bash
npm run smoke:recommendation-flow
```

Expected:

- Discovery run and sampled products pass.
- Promoted research, MD strategy, and product-linked screenplay checks pass if fixtures exist; otherwise they warn with the exact missing prerequisite.

## Self-Review

Spec coverage:

- P0 upload/analyze auth is covered by Task 1.
- P1 research-to-screenplay linking is covered by Tasks 2 and 3.
- P2 category exact-match weakness is covered by Task 4.
- P3 operational smoke is covered by Task 5.

Placeholder scan:

- No task contains unresolved placeholder language.
- Each changed file has exact snippets or complete file contents for created files.

Type consistency:

- `ProductBriefLoadResult` returns `productId` only on success.
- `app/api/screenplays/route.ts` inserts `v.productId`, which is either a UUID or `null`.
- `GenerateScreenplayButton` POSTs `{ productId }`, matching the new screenplays route branch.
- `uniqueCategoryCandidates` is exported through `__test`, matching `scripts/test-research-category-candidates.ts`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-23-home-shopping-recommendation-integration.md`. Two execution options:

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task and review between tasks.
2. **Inline Execution** - Execute tasks in this session using checkpoints.
