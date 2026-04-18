# Product Discovery Phase 3 — Enrichment (C Package) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자가 발굴된 제품 카드에서 "深掘り(깊이 파기)" 버튼을 클릭하면, 60초 이내 비동기적으로 제조사 정보 / 도매가 추정 / MOQ 힌트 / TV 방송 스크립트 / SNS 트렌드 신호를 포함한 C 패키지를 생성하고 UI에 표시한다.

**Architecture:** Gemini tool-calling 에이전트가 6개 도구를 자율적으로 사용하여 sourcing intelligence를 수집. 비동기 패턴: POST 즉시 202 반환 → `waitUntil()` 백그라운드 worker → 클라이언트 2초 폴링.

**Tech Stack:** Next.js 15 App Router (Fluid Compute `waitUntil`), TypeScript, Supabase jsonb, Google Gemini 3-Flash (function calling), Tailwind CSS 4.

**Spec reference:** `docs/superpowers/specs/2026-04-18-product-discovery-redesign-design.md` §5 (Stage 2 Enrichment Agent).

**Phase 1+2 완료 상태:** 30개 제품/일 자동 발굴 + `/analytics/発掘` UI 완성. PR #7 open. 본 Phase 3는 동일 브랜치 `feature/product-discovery-phase1`에 누적 커밋.

**Out of scope for Phase 3:**
- 피드백 버튼 4종 (Phase 4)
- 학습 cron (daily-learning, weekly-insights) (Phase 4/5)
- Insights 대시보드 (Phase 5)
- B2B 플랫폼 교차 검증 (NETSEA 등) — 스펙상 Phase 2 이후 검토

---

## File Structure

**Create:**
```
lib/discovery/
  enrich-agent.ts                   -- Gemini tool-calling agent loop (main entry)
  wholesale-rules.ts                -- baseline + MediaWorks margin blending
  tools/
    rakuten-page.ts                 -- fetch+parse Rakuten shop page (seller info)
    extract-manufacturer.ts         -- extract manufacturer from item HTML (Gemini)
    fetch-meta.ts                   -- fetch URL, extract title/desc/contacts
    tv-script.ts                    -- separate Gemini call for TV script draft

app/api/discovery/enrich/[productId]/
  route.ts                          -- POST (202 queue) + GET (poll)
  worker/route.ts                   -- internal worker (executes agent)

components/discovery/
  EnrichmentProgress.tsx            -- spinner + polling status
  CPackageDrawer.tsx                -- C package display (collapsed section in card)
```

**Modify:**
```
lib/discovery/types.ts              -- add CPackage types
components/discovery/ProductCard.tsx     -- add 深掘り button + progress + drawer
app/[locale]/analytics/discovery/page.tsx -- track polling state per card
vercel.json                         -- worker function timeout 60s
messages/ja.json, messages/en.json  -- enrichment.* keys
```

---

## Task 1: `lib/discovery/types.ts` — C 패키지 타입 추가

**Files:**
- Modify: `lib/discovery/types.ts`

- [ ] **Step 1: 파일 끝에 C 패키지 타입 블록 추가**

Open `lib/discovery/types.ts`. Append at the end (after `DEFAULT_LEARNING_STATE`):

```typescript
export type Confidence = "high" | "medium" | "low";

export interface ManufacturerInfo {
	name: string | null;
	is_seller_same_as_manufacturer: boolean;
	official_site: string | null;
	address: string | null;
	contact_hints: string[];
	confidence: Confidence;
}

export interface WholesaleEstimate {
	retail_jpy: number;
	estimated_cost_jpy: number | null;
	estimated_margin_rate: number | null;
	method: "baseline" | "blended" | "mediaworks_adjusted";
	sample_size: number;
	confidence: Confidence;
}

export interface SnsTrend {
	signal_strength: "high" | "medium" | "low" | "none";
	sources: string[];
}

export interface CPackage {
	manufacturer: ManufacturerInfo;
	wholesale_estimate: WholesaleEstimate;
	moq_hint: string | null;
	tv_script_draft: string;
	sns_trend: SnsTrend;
	enriched_at: string;
	tool_calls_used: number;
	partial: boolean;
	error?: string;
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/discovery/types.ts
git commit -m "feat(discovery): add C package types for enrichment"
```

---

## Task 2: `lib/discovery/wholesale-rules.ts` — 도매가 추정 룰

**Files:**
- Create: `lib/discovery/wholesale-rules.ts`

- [ ] **Step 1: 파일 생성**

Write to `lib/discovery/wholesale-rules.ts`:

```typescript
/**
 * Wholesale estimation — blends Japan home-shopping industry baseline
 * margin rates with MediaWorks' own historical data from product_summaries.
 * Ref: spec §5.4.
 *
 * Formula: wholesale = retail × (1 - blended_margin_rate)
 *   blended = 0.6 × baseline + 0.4 × mediaworks (if mediaworks sample ≥ 3)
 *   else: blended = baseline
 */

import { getServiceClient } from "@/lib/supabase";
import type { Confidence, WholesaleEstimate } from "./types";

// Industry baseline margin rates (gross margin) — Japan home shopping averages.
// Keys use broad category prefixes matching product_summaries.category patterns.
const BASELINE_MARGINS: Record<string, number> = {
	美容: 0.55,
	化粧品: 0.55,
	キッチン: 0.45,
	家電: 0.35,
	医療機器: 0.5,
	健康: 0.5,
	防災: 0.4,
	寝具: 0.45,
	アパレル: 0.5,
	ゴルフ: 0.4,
	食品: 0.3,
	宝飾: 0.55,
	雑貨: 0.45,
};

const DEFAULT_BASELINE_MARGIN = 0.42;

function matchBaselineCategory(category: string | null | undefined): number {
	if (!category) return DEFAULT_BASELINE_MARGIN;
	for (const [prefix, margin] of Object.entries(BASELINE_MARGINS)) {
		if (category.includes(prefix)) return margin;
	}
	return DEFAULT_BASELINE_MARGIN;
}

interface MediaWorksStats {
	median: number;
	sampleSize: number;
}

/**
 * Aggregate median margin_rate from product_summaries for a category.
 * Uses fuzzy match (category includes prefix).
 */
async function loadMediaWorksStats(category: string | null | undefined): Promise<MediaWorksStats> {
	if (!category) return { median: 0, sampleSize: 0 };
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("product_summaries")
		.select("margin_rate, category")
		.not("margin_rate", "is", null)
		.limit(2000);
	if (error || !data) return { median: 0, sampleSize: 0 };

	const matched = (data as Array<{ margin_rate: number; category: string | null }>)
		.filter((r) => r.category && r.category.includes(category.slice(0, 4)))
		.map((r) => r.margin_rate)
		.filter((m) => m > 0 && m < 1)
		.sort((a, b) => a - b);

	if (matched.length === 0) return { median: 0, sampleSize: 0 };
	const mid = Math.floor(matched.length / 2);
	const median =
		matched.length % 2 === 0 ? (matched[mid - 1] + matched[mid]) / 2 : matched[mid];
	return { median, sampleSize: matched.length };
}

function confidenceFromSample(sampleSize: number): Confidence {
	if (sampleSize >= 10) return "high";
	if (sampleSize >= 3) return "medium";
	return "low";
}

export async function estimateWholesale(
	retailJpy: number,
	category: string | null | undefined,
): Promise<WholesaleEstimate> {
	const baseline = matchBaselineCategory(category);
	const stats = await loadMediaWorksStats(category);

	let blendedMargin: number;
	let method: WholesaleEstimate["method"];
	if (stats.sampleSize >= 3) {
		blendedMargin = 0.6 * baseline + 0.4 * stats.median;
		method = "blended";
	} else {
		blendedMargin = baseline;
		method = "baseline";
	}

	const cost = Math.round(retailJpy * (1 - blendedMargin));
	return {
		retail_jpy: retailJpy,
		estimated_cost_jpy: cost,
		estimated_margin_rate: Number(blendedMargin.toFixed(3)),
		method,
		sample_size: stats.sampleSize,
		confidence: confidenceFromSample(stats.sampleSize),
	};
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/discovery/wholesale-rules.ts
git commit -m "feat(discovery): add wholesale estimator (baseline + MediaWorks blend)"
```

---

## Task 3: `lib/discovery/tools/fetch-meta.ts` — URL 메타 추출 도구

**Files:**
- Create: `lib/discovery/tools/fetch-meta.ts`

- [ ] **Step 1: 파일 생성**

Write to `lib/discovery/tools/fetch-meta.ts`:

```typescript
/**
 * Fetch a URL and extract basic meta + contact hints from HTML.
 * Used by enrichment agent for manufacturer official-site verification.
 */

export interface UrlMeta {
	url: string;
	title: string | null;
	description: string | null;
	contact_hints: string[];
	fetched: boolean;
}

const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const PHONE_RE = /(?:\+?81[-.\s]?)?(?:\(?0\)?[0-9]{1,4}[-.\s]?[0-9]{1,4}[-.\s]?[0-9]{3,4})/g;

export async function fetchUrlMeta(url: string): Promise<UrlMeta> {
	if (!url.startsWith("http")) {
		return { url, title: null, description: null, contact_hints: [], fetched: false };
	}

	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(8000),
			headers: {
				"User-Agent":
					"Mozilla/5.0 (compatible; MediaWorksBot/1.0; +https://mediaworks-six.vercel.app)",
				Accept: "text/html,*/*",
			},
			redirect: "follow",
		});
		if (!res.ok) {
			return { url, title: null, description: null, contact_hints: [], fetched: false };
		}
		const html = (await res.text()).slice(0, 200_000);

		const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
		const descMatch = html.match(
			/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i,
		);

		const bodyText = html
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " ");

		const emails = Array.from(new Set(bodyText.match(EMAIL_RE) ?? [])).slice(0, 3);
		const phones = Array.from(new Set(bodyText.match(PHONE_RE) ?? []))
			.filter((p) => p.replace(/\D/g, "").length >= 9)
			.slice(0, 3);

		return {
			url,
			title: titleMatch ? decodeEntities(titleMatch[1].trim()).slice(0, 200) : null,
			description: descMatch ? decodeEntities(descMatch[1].trim()).slice(0, 300) : null,
			contact_hints: [...emails, ...phones],
			fetched: true,
		};
	} catch (err) {
		console.warn(
			`[fetchUrlMeta] ${url} failed:`,
			err instanceof Error ? err.message : String(err),
		);
		return { url, title: null, description: null, contact_hints: [], fetched: false };
	}
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/discovery/tools/fetch-meta.ts
git commit -m "feat(discovery): add fetch-meta tool for URL title/description/contacts"
```

---

## Task 4: `lib/discovery/tools/rakuten-page.ts` — Rakuten 판매자 정보 추출

**Files:**
- Create: `lib/discovery/tools/rakuten-page.ts`

- [ ] **Step 1: 파일 생성**

Write to `lib/discovery/tools/rakuten-page.ts`:

```typescript
/**
 * Fetch a Rakuten item page and extract seller/shop info.
 * Rakuten shop pages carry 店舗名 (shop), 会社名 (company), 所在地 (address)
 * in predictable locations when present. We use lightweight regex — pages
 * vary, so fields are best-effort.
 */

export interface RakutenShopInfo {
	productUrl: string;
	shopName: string | null;
	companyName: string | null;
	address: string | null;
	shopUrl: string | null;
	manufacturerHint: string | null;
	fetched: boolean;
}

const SHOP_URL_RE = /https?:\/\/www\.rakuten\.co\.jp\/[a-z0-9-]+\//i;

export async function fetchRakutenPage(productUrl: string): Promise<RakutenShopInfo> {
	if (!productUrl.includes("rakuten.co.jp")) {
		return {
			productUrl,
			shopName: null,
			companyName: null,
			address: null,
			shopUrl: null,
			manufacturerHint: null,
			fetched: false,
		};
	}

	try {
		const res = await fetch(productUrl, {
			signal: AbortSignal.timeout(8000),
			headers: {
				"User-Agent":
					"Mozilla/5.0 (compatible; MediaWorksBot/1.0)",
				Accept: "text/html,*/*",
				"Accept-Language": "ja,en;q=0.9",
			},
			redirect: "follow",
		});
		if (!res.ok) {
			return {
				productUrl,
				shopName: null,
				companyName: null,
				address: null,
				shopUrl: null,
				manufacturerHint: null,
				fetched: false,
			};
		}
		const html = (await res.text()).slice(0, 500_000);

		const shopUrlMatch = html.match(SHOP_URL_RE);
		const shopName = extractFieldAfterLabel(html, [
			"店舗名",
			"ショップ名",
			"運営会社",
		]);
		const companyName = extractFieldAfterLabel(html, ["会社名", "法人名"]);
		const address = extractFieldAfterLabel(html, ["所在地", "住所"]);
		const manufacturerHint = extractFieldAfterLabel(html, [
			"メーカー",
			"製造元",
			"製造販売元",
			"製造国",
		]);

		return {
			productUrl,
			shopName,
			companyName,
			address,
			shopUrl: shopUrlMatch ? shopUrlMatch[0] : null,
			manufacturerHint,
			fetched: true,
		};
	} catch (err) {
		console.warn(
			`[fetchRakutenPage] ${productUrl} failed:`,
			err instanceof Error ? err.message : String(err),
		);
		return {
			productUrl,
			shopName: null,
			companyName: null,
			address: null,
			shopUrl: null,
			manufacturerHint: null,
			fetched: false,
		};
	}
}

/**
 * Lightweight label-based extractor: finds `<label>...` in table rows or
 * definition lists. Returns plaintext up to 120 chars.
 */
function extractFieldAfterLabel(html: string, labels: string[]): string | null {
	for (const label of labels) {
		// Pattern: <th>label</th><td>value</td>
		const tableRe = new RegExp(
			`<(th|dt)[^>]*>\\s*${escapeRe(label)}[\\s　:：]*<\\/(?:th|dt)>\\s*<(?:td|dd)[^>]*>([\\s\\S]{1,400}?)<\\/(?:td|dd)>`,
			"i",
		);
		const m = html.match(tableRe);
		if (m) {
			const plain = stripTags(m[2]).trim();
			if (plain) return plain.slice(0, 120);
		}
		// Pattern: "label：value" or "label:value" in plain text
		const plainRe = new RegExp(
			`${escapeRe(label)}[\\s　]*[:：][\\s　]*([^\\n<]{1,120})`,
			"i",
		);
		const m2 = html.match(plainRe);
		if (m2) {
			const plain = stripTags(m2[1]).trim();
			if (plain) return plain.slice(0, 120);
		}
	}
	return null;
}

function stripTags(s: string): string {
	return s
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&nbsp;/g, " ")
		.trim();
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/discovery/tools/rakuten-page.ts
git commit -m "feat(discovery): add rakuten-page tool for seller/company/address extraction"
```

---

## Task 5: `lib/discovery/tools/tv-script.ts` — TV 방송 스크립트 초안

**Files:**
- Create: `lib/discovery/tools/tv-script.ts`

- [ ] **Step 1: 파일 생성**

Write to `lib/discovery/tools/tv-script.ts`:

```typescript
/**
 * Generate a 30-second TV home-shopping broadcast script draft (Japanese).
 * Separate Gemini call so the enrichment agent doesn't waste tool-call budget.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = "gemini-3-flash-preview";

export interface TvScriptInput {
	productName: string;
	priceJpy: number | null;
	reviewCount: number | null;
	reviewAvg: number | null;
	tvFitReason: string | null;
}

export async function generateTvScriptDraft(input: TvScriptInput): Promise<string> {
	const prompt = `日本のテレビ通販向け30秒放送スクリプトを作成してください。

【商品情報】
- 商品名: ${input.productName}
${input.priceJpy ? `- 価格: ¥${input.priceJpy.toLocaleString()}` : ""}
${input.reviewAvg ? `- 楽天レビュー: ★${input.reviewAvg} (${input.reviewCount ?? 0}件)` : ""}
${input.tvFitReason ? `- TV適合性: ${input.tvFitReason}` : ""}

【スクリプト構成 (30秒目安)】
1. フック (0-5秒): 視聴者の課題・ペインに直接訴える問いかけ
2. 商品提示 (5-15秒): 商品名と主要ベネフィット、実演ポイント
3. 社会的証拠 (15-20秒): レビュー数・評価
4. オファー (20-28秒): 価格と限定性（「今なら」「限定○名様」等）
5. コール (28-30秒): 注文アクション喚起

【出力】
スクリプト本文のみ（日本語）、番号付きセクション形式で300字以内。`;

	try {
		const model = genAI.getGenerativeModel({ model: MODEL_ID });
		const res = await model.generateContent(prompt);
		return res.response.text().trim();
	} catch (err) {
		console.warn(
			"[tvScript] generation failed:",
			err instanceof Error ? err.message : String(err),
		);
		return "(スクリプト生成失敗)";
	}
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/discovery/tools/tv-script.ts
git commit -m "feat(discovery): add tv-script tool for 30-sec broadcast draft"
```

---

## Task 6: `lib/discovery/enrich-agent.ts` — Gemini tool-calling 에이전트

**Files:**
- Create: `lib/discovery/enrich-agent.ts`

**Depends on:** Tasks 1-5.

- [ ] **Step 1: 파일 생성**

Write to `lib/discovery/enrich-agent.ts`:

```typescript
/**
 * Enrichment agent — Gemini 3-Flash with function calling.
 * Given a discovered product, orchestrates tools to build a C package:
 *  - manufacturer identification
 *  - wholesale estimate
 *  - MOQ hint
 *  - TV script
 *  - SNS trend signal
 *
 * Ref: spec §5 Stage 2.
 *
 * Contract: throws on unrecoverable failure; returns partial=true if
 * timeout hit before completion. Caller handles DB persistence.
 */

import {
	FunctionDeclarationSchemaType,
	GoogleGenerativeAI,
	type FunctionCall,
} from "@google/generative-ai";
import { braveSearchItems } from "@/lib/brave";
import { fetchUrlMeta } from "./tools/fetch-meta";
import { fetchRakutenPage } from "./tools/rakuten-page";
import { generateTvScriptDraft } from "./tools/tv-script";
import { estimateWholesale } from "./wholesale-rules";
import type {
	CPackage,
	Confidence,
	ManufacturerInfo,
	WholesaleEstimate,
} from "./types";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_ID = "gemini-3-flash-preview";
const MAX_TOOL_CALLS = 8;
const TIMEOUT_MS = 55_000;

export interface EnrichInput {
	productUrl: string;
	name: string;
	priceJpy: number | null;
	category: string | null;
	sellerName: string | null;
	reviewCount: number | null;
	reviewAvg: number | null;
	tvFitReason: string | null;
}

const TOOL_DECLARATIONS = [
	{
		name: "fetch_rakuten_page",
		description:
			"Fetches a Rakuten product/shop page and extracts seller info (shop name, company, address, manufacturer hint).",
		parameters: {
			type: FunctionDeclarationSchemaType.OBJECT,
			properties: {
				url: {
					type: FunctionDeclarationSchemaType.STRING,
					description: "Rakuten item URL",
				},
			},
			required: ["url"],
		},
	},
	{
		name: "search_brave",
		description:
			"Web search (Brave) for supplementary info — manufacturer official site, reviews, SNS mentions.",
		parameters: {
			type: FunctionDeclarationSchemaType.OBJECT,
			properties: {
				query: {
					type: FunctionDeclarationSchemaType.STRING,
					description: "Search query (Japanese or English)",
				},
				count: {
					type: FunctionDeclarationSchemaType.NUMBER,
					description: "Number of results (1-10, default 5)",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "fetch_url_meta",
		description:
			"Fetch a URL and extract page title, description, and contact info (emails, phones).",
		parameters: {
			type: FunctionDeclarationSchemaType.OBJECT,
			properties: {
				url: {
					type: FunctionDeclarationSchemaType.STRING,
					description: "HTTP(S) URL",
				},
			},
			required: ["url"],
		},
	},
	{
		name: "estimate_wholesale",
		description:
			"Estimate wholesale cost from retail price using industry baseline + MediaWorks historical data blend.",
		parameters: {
			type: FunctionDeclarationSchemaType.OBJECT,
			properties: {
				retail_jpy: {
					type: FunctionDeclarationSchemaType.NUMBER,
					description: "Retail price in JPY",
				},
				category: {
					type: FunctionDeclarationSchemaType.STRING,
					description: "Product category (e.g. 美容家電, 健康食品)",
				},
			},
			required: ["retail_jpy", "category"],
		},
	},
];

const SYSTEM_PROMPT = `あなたは日本のテレビ通販ソーシング会社のアシスタントエージェントです。
発掘された商品1件について、以下のC パッケージ情報を収集してください。

【収集項目】
1. manufacturer: 製造元の特定 (名称, 公式サイト, 住所, 連絡ヒント, 信頼度)
   - Rakuten販売者が製造元か判定 (会社名に「メーカー」「製造」を含むか、公式サイト有無など)
   - 販売者 ≠ 製造元の場合は search_brave + fetch_url_meta で追跡
2. wholesale_estimate: 小売→卸売 推定 (estimate_wholesale ツール使用)
3. moq_hint: MOQ情報 (公式サイトやB2B情報に明記があれば)
4. sns_trend: TikTok / Instagram / X 等でのトレンド信号 (search_brave で確認)

【制約】
- 最大ツール呼び出し: 8回
- 連絡先を捏造しないこと。不明な場合は null, confidence='low'
- 自然言語出力はすべて日本語

【最終出力】
ツール実行を終えたら、次のJSON形式で結果を返してください (JSONのみ、前置き/後書きなし):

{
  "manufacturer": {
    "name": "...or null",
    "is_seller_same_as_manufacturer": true,
    "official_site": "...or null",
    "address": "...or null",
    "contact_hints": ["email", "phone"],
    "confidence": "high|medium|low"
  },
  "moq_hint": "...or null",
  "sns_trend": {
    "signal_strength": "high|medium|low|none",
    "sources": ["tiktok", "instagram"]
  }
}

※ wholesale_estimate と tv_script_draft はエージェント外で自動生成されるため、このJSON出力には含めないこと。`;

interface ToolResult {
	name: string;
	response: Record<string, unknown>;
}

async function executeTool(call: FunctionCall): Promise<ToolResult> {
	try {
		switch (call.name) {
			case "fetch_rakuten_page": {
				const url = (call.args as { url?: string }).url ?? "";
				const info = await fetchRakutenPage(url);
				return { name: call.name, response: info as unknown as Record<string, unknown> };
			}
			case "search_brave": {
				const { query, count } = call.args as { query?: string; count?: number };
				const results = await braveSearchItems(query ?? "", count ?? 5);
				return { name: call.name, response: { results } };
			}
			case "fetch_url_meta": {
				const { url } = call.args as { url?: string };
				const meta = await fetchUrlMeta(url ?? "");
				return { name: call.name, response: meta as unknown as Record<string, unknown> };
			}
			case "estimate_wholesale": {
				const { retail_jpy, category } = call.args as {
					retail_jpy?: number;
					category?: string;
				};
				const est = await estimateWholesale(retail_jpy ?? 0, category ?? null);
				return { name: call.name, response: est as unknown as Record<string, unknown> };
			}
			default:
				return { name: call.name, response: { error: "unknown tool" } };
		}
	} catch (err) {
		return {
			name: call.name,
			response: {
				error: err instanceof Error ? err.message : String(err),
			},
		};
	}
}

function emptyCPackage(reason: string): CPackage {
	return {
		manufacturer: {
			name: null,
			is_seller_same_as_manufacturer: false,
			official_site: null,
			address: null,
			contact_hints: [],
			confidence: "low",
		},
		wholesale_estimate: {
			retail_jpy: 0,
			estimated_cost_jpy: null,
			estimated_margin_rate: null,
			method: "baseline",
			sample_size: 0,
			confidence: "low",
		},
		moq_hint: null,
		tv_script_draft: "(スクリプト生成失敗)",
		sns_trend: { signal_strength: "none", sources: [] },
		enriched_at: new Date().toISOString(),
		tool_calls_used: 0,
		partial: true,
		error: reason,
	};
}

interface AgentCoreResult {
	manufacturer: ManufacturerInfo;
	moq_hint: string | null;
	sns_trend: { signal_strength: "high" | "medium" | "low" | "none"; sources: string[] };
	tool_calls_used: number;
}

async function runAgentCore(
	input: EnrichInput,
	deadline: number,
): Promise<AgentCoreResult> {
	const model = genAI.getGenerativeModel({
		model: MODEL_ID,
		tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
	});
	const chat = model.startChat({
		systemInstruction: { role: "system", parts: [{ text: SYSTEM_PROMPT }] },
	});

	const initialPrompt = `商品情報:
- 商品名: ${input.name}
- URL: ${input.productUrl}
${input.priceJpy ? `- 価格: ¥${input.priceJpy}` : ""}
${input.category ? `- カテゴリ: ${input.category}` : ""}
${input.sellerName ? `- 販売者: ${input.sellerName}` : ""}
${input.reviewAvg ? `- レビュー: ★${input.reviewAvg} (${input.reviewCount ?? 0})` : ""}

上記商品のC パッケージ情報を収集してください。まず fetch_rakuten_page ツールで販売者情報を確認することから始めてください。`;

	let result = await chat.sendMessage(initialPrompt);
	let toolCalls = 0;

	while (toolCalls < MAX_TOOL_CALLS && Date.now() < deadline) {
		const calls = result.response.functionCalls();
		if (!calls || calls.length === 0) break;

		const responses = await Promise.all(calls.map(executeTool));
		toolCalls += calls.length;

		result = await chat.sendMessage(
			responses.map((r) => ({
				functionResponse: { name: r.name, response: r.response },
			})),
		);
	}

	// Final text should be JSON
	const text = result.response.text();
	const match = text.match(/\{[\s\S]+\}/);
	if (!match) {
		throw new Error(`no final JSON in agent response: ${text.slice(0, 200)}`);
	}
	const parsed = JSON.parse(match[0]) as {
		manufacturer?: Partial<ManufacturerInfo>;
		moq_hint?: string | null;
		sns_trend?: { signal_strength?: string; sources?: string[] };
	};

	return {
		manufacturer: {
			name: parsed.manufacturer?.name ?? null,
			is_seller_same_as_manufacturer:
				parsed.manufacturer?.is_seller_same_as_manufacturer ?? false,
			official_site: parsed.manufacturer?.official_site ?? null,
			address: parsed.manufacturer?.address ?? null,
			contact_hints: parsed.manufacturer?.contact_hints ?? [],
			confidence: (parsed.manufacturer?.confidence as Confidence) ?? "low",
		},
		moq_hint: parsed.moq_hint ?? null,
		sns_trend: {
			signal_strength:
				(parsed.sns_trend?.signal_strength as
					| "high"
					| "medium"
					| "low"
					| "none") ?? "none",
			sources: parsed.sns_trend?.sources ?? [],
		},
		tool_calls_used: toolCalls,
	};
}

/**
 * Main entry: returns a complete C package (or partial on timeout/error).
 */
export async function enrichProduct(input: EnrichInput): Promise<CPackage> {
	const start = Date.now();
	const deadline = start + TIMEOUT_MS;

	let wholesale: WholesaleEstimate = {
		retail_jpy: input.priceJpy ?? 0,
		estimated_cost_jpy: null,
		estimated_margin_rate: null,
		method: "baseline",
		sample_size: 0,
		confidence: "low",
	};
	let tvScript = "(スクリプト生成失敗)";

	// Run wholesale + TV script in parallel with the agent to save time
	const [coreResult, wholesaleResult, scriptResult] = await Promise.allSettled([
		runAgentCore(input, deadline),
		input.priceJpy
			? estimateWholesale(input.priceJpy, input.category)
			: Promise.resolve(wholesale),
		generateTvScriptDraft({
			productName: input.name,
			priceJpy: input.priceJpy,
			reviewCount: input.reviewCount,
			reviewAvg: input.reviewAvg,
			tvFitReason: input.tvFitReason,
		}),
	]);

	if (wholesaleResult.status === "fulfilled") wholesale = wholesaleResult.value;
	if (scriptResult.status === "fulfilled") tvScript = scriptResult.value;

	if (coreResult.status !== "fulfilled") {
		const err =
			coreResult.reason instanceof Error
				? coreResult.reason.message
				: String(coreResult.reason);
		const partial = emptyCPackage(err);
		partial.wholesale_estimate = wholesale;
		partial.tv_script_draft = tvScript;
		return partial;
	}

	const core = coreResult.value;
	return {
		manufacturer: core.manufacturer,
		wholesale_estimate: wholesale,
		moq_hint: core.moq_hint,
		tv_script_draft: tvScript,
		sns_trend: core.sns_trend,
		enriched_at: new Date().toISOString(),
		tool_calls_used: core.tool_calls_used,
		partial: Date.now() > deadline,
	};
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add lib/discovery/enrich-agent.ts
git commit -m "feat(discovery): add enrich-agent with Gemini tool-calling"
```

---

## Task 7: Enrichment API routes (POST/GET + worker)

**Files:**
- Create: `app/api/discovery/enrich/[productId]/route.ts`
- Create: `app/api/discovery/enrich/[productId]/worker/route.ts`

- [ ] **Step 1: `route.ts` — POST (202) + GET (poll) 생성**

Write to `app/api/discovery/enrich/[productId]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 30;

/**
 * POST: queue enrichment for a productId. Returns 202 immediately.
 * Triggers internal worker via `after()` (Vercel Fluid Compute).
 */
export async function POST(
	req: NextRequest,
	ctx: { params: Promise<{ productId: string }> },
) {
	const { productId } = await ctx.params;
	const sb = getServiceClient();

	// Check if product exists + current status
	const { data: product, error: prodErr } = await sb
		.from("discovered_products")
		.select("id, enrichment_status, c_package")
		.eq("id", productId)
		.maybeSingle();

	if (prodErr) {
		return NextResponse.json({ error: prodErr.message }, { status: 500 });
	}
	if (!product) {
		return NextResponse.json({ error: "product not found" }, { status: 404 });
	}

	// Idempotency: if already running or queued, return existing state
	if (
		product.enrichment_status === "queued" ||
		product.enrichment_status === "running"
	) {
		return NextResponse.json(
			{ productId, status: product.enrichment_status },
			{ status: 202 },
		);
	}

	// If completed, return cached package unless client explicitly forces refresh
	const force = req.nextUrl.searchParams.get("force") === "1";
	if (product.enrichment_status === "completed" && !force) {
		return NextResponse.json(
			{ productId, status: "completed", cached: true },
			{ status: 200 },
		);
	}

	// Mark as queued
	const { error: updErr } = await sb
		.from("discovered_products")
		.update({
			enrichment_status: "queued",
			enrichment_started_at: new Date().toISOString(),
			enrichment_error: null,
		})
		.eq("id", productId);
	if (updErr) {
		return NextResponse.json({ error: updErr.message }, { status: 500 });
	}

	// Trigger worker via after() — keeps the function alive post-response
	const workerUrl = new URL(
		`/api/discovery/enrich/${productId}/worker`,
		req.nextUrl.origin,
	);
	const secret = process.env.CRON_SECRET ?? "";

	after(async () => {
		try {
			await fetch(workerUrl, {
				method: "POST",
				headers: secret ? { Authorization: `Bearer ${secret}` } : {},
				signal: AbortSignal.timeout(62_000),
			});
		} catch (err) {
			console.error(
				`[enrich trigger] worker fetch failed for ${productId}:`,
				err instanceof Error ? err.message : String(err),
			);
		}
	});

	return NextResponse.json({ productId, status: "queued" }, { status: 202 });
}

/**
 * GET: poll current enrichment status + c_package (if completed).
 */
export async function GET(
	_req: NextRequest,
	ctx: { params: Promise<{ productId: string }> },
) {
	const { productId } = await ctx.params;
	const sb = getServiceClient();

	const { data, error } = await sb
		.from("discovered_products")
		.select("id, enrichment_status, c_package, enrichment_error, enrichment_completed_at")
		.eq("id", productId)
		.maybeSingle();

	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
	if (!data) {
		return NextResponse.json({ error: "product not found" }, { status: 404 });
	}

	return NextResponse.json({
		productId,
		status: data.enrichment_status,
		c_package: data.c_package,
		error: data.enrichment_error,
		completed_at: data.enrichment_completed_at,
	});
}
```

Note: Next.js 15 `after()` is available in route handlers (stable as of 15.1). If the project uses a version that doesn't have it, fall back to fire-and-forget `fetch()` (don't await).

- [ ] **Step 2: `worker/route.ts` 생성**

Write to `app/api/discovery/enrich/[productId]/worker/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { enrichProduct } from "@/lib/discovery/enrich-agent";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 60;

/**
 * Internal worker — NEVER called by browser. Invoked via fetch from the
 * POST handler's `after()` callback. Protected by CRON_SECRET.
 */
export async function POST(
	req: NextRequest,
	ctx: { params: Promise<{ productId: string }> },
) {
	const secret = process.env.CRON_SECRET;
	if (secret) {
		const header = req.headers.get("authorization");
		if (header !== `Bearer ${secret}`) {
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		}
	}

	const { productId } = await ctx.params;
	const sb = getServiceClient();

	// Load product
	const { data: product, error: prodErr } = await sb
		.from("discovered_products")
		.select(
			"id, name, product_url, price_jpy, category, seller_name, review_count, review_avg, tv_fit_reason",
		)
		.eq("id", productId)
		.maybeSingle();

	if (prodErr || !product) {
		return NextResponse.json(
			{ error: prodErr?.message ?? "product not found" },
			{ status: 404 },
		);
	}

	// Mark running
	await sb
		.from("discovered_products")
		.update({ enrichment_status: "running" })
		.eq("id", productId);

	try {
		const pkg = await enrichProduct({
			productUrl: product.product_url,
			name: product.name,
			priceJpy: product.price_jpy,
			category: product.category,
			sellerName: product.seller_name,
			reviewCount: product.review_count,
			reviewAvg: product.review_avg,
			tvFitReason: product.tv_fit_reason,
		});

		await sb
			.from("discovered_products")
			.update({
				enrichment_status: "completed",
				enrichment_completed_at: new Date().toISOString(),
				c_package: pkg,
				enrichment_error: pkg.error ?? null,
			})
			.eq("id", productId);

		return NextResponse.json({ ok: true, productId, partial: pkg.partial });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[enrich worker] ${productId} failed:`, msg);
		await sb
			.from("discovered_products")
			.update({
				enrichment_status: "failed",
				enrichment_error: msg.slice(0, 500),
				enrichment_completed_at: new Date().toISOString(),
			})
			.eq("id", productId);
		return NextResponse.json({ ok: false, productId, error: msg }, { status: 500 });
	}
}
```

- [ ] **Step 3: `vercel.json` 업데이트 — worker 함수 타임아웃**

Add inside the `functions` block:
```json
"app/api/discovery/enrich/[productId]/route.ts": { "maxDuration": 30 },
"app/api/discovery/enrich/[productId]/worker/route.ts": { "maxDuration": 60 }
```

- [ ] **Step 4: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add app/api/discovery/enrich/ vercel.json
git commit -m "feat(discovery): add enrichment API (POST 202 + GET poll + worker)"
```

---

## Task 8: i18n enrichment.* keys

**Files:**
- Modify: `messages/ja.json`
- Modify: `messages/en.json`

- [ ] **Step 1: discovery 블록에 enrichment 키 추가**

In `messages/ja.json`, add to the `discovery` block (merge these keys):

```json
"deepDive": "深掘り",
"deepDiveRunning": "製造元を追跡中...",
"deepDiveFailed": "分析失敗",
"manufacturer": "製造元",
"manufacturerUnknown": "(情報なし)",
"wholesaleEstimate": "卸値推定",
"wholesaleMethod": "算出方法",
"wholesaleMethodBaseline": "業界平均",
"wholesaleMethodBlended": "業界×自社実績",
"confidenceHigh": "信頼度: 高",
"confidenceMedium": "信頼度: 中",
"confidenceLow": "信頼度: 低",
"moqHint": "MOQヒント",
"tvScript": "TV放送スクリプト",
"copyScript": "コピー",
"scriptCopied": "コピーしました",
"snsTrend": "SNSトレンド",
"snsStrong": "強い",
"snsMedium": "中程度",
"snsWeak": "弱い",
"snsNone": "シグナルなし",
"officialSite": "公式サイト",
"address": "所在地",
"contactHints": "連絡先ヒント",
"partialResult": "部分結果 (タイムアウト)",
"viewDetails": "詳細を見る",
"hideDetails": "閉じる"
```

In `messages/en.json`, add parallel English keys:
```json
"deepDive": "Deep Dive",
"deepDiveRunning": "Tracing manufacturer...",
"deepDiveFailed": "Analysis failed",
"manufacturer": "Manufacturer",
"manufacturerUnknown": "(unknown)",
"wholesaleEstimate": "Wholesale Estimate",
"wholesaleMethod": "Method",
"wholesaleMethodBaseline": "Industry baseline",
"wholesaleMethodBlended": "Industry × MediaWorks data",
"confidenceHigh": "Confidence: High",
"confidenceMedium": "Confidence: Medium",
"confidenceLow": "Confidence: Low",
"moqHint": "MOQ hint",
"tvScript": "TV Script",
"copyScript": "Copy",
"scriptCopied": "Copied",
"snsTrend": "SNS Trend",
"snsStrong": "Strong",
"snsMedium": "Medium",
"snsWeak": "Weak",
"snsNone": "No signal",
"officialSite": "Official site",
"address": "Address",
"contactHints": "Contact hints",
"partialResult": "Partial (timeout)",
"viewDetails": "Details",
"hideDetails": "Close"
```

Ensure JSON remains valid (comma placement).

- [ ] **Step 2: 커밋**

```bash
git add messages/ja.json messages/en.json
git commit -m "feat(discovery): add i18n keys for enrichment UI"
```

---

## Task 9: `components/discovery/EnrichmentProgress.tsx`

**Files:**
- Create: `components/discovery/EnrichmentProgress.tsx`

- [ ] **Step 1: 파일 생성**

Write to `components/discovery/EnrichmentProgress.tsx`:

```tsx
"use client";
import { useTranslations } from "next-intl";
import { Loader2, AlertTriangle, Sparkles } from "lucide-react";

type Status = "idle" | "queued" | "running" | "completed" | "failed";

export function EnrichmentProgress({
	status,
	onTrigger,
	onToggleDetails,
	hasPackage,
	showDetails,
	error,
}: {
	status: Status;
	onTrigger: () => void;
	onToggleDetails: () => void;
	hasPackage: boolean;
	showDetails: boolean;
	error?: string | null;
}) {
	const t = useTranslations("discovery");

	if (status === "queued" || status === "running") {
		return (
			<button
				type="button"
				disabled
				className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-amber-50 border border-amber-200 text-amber-800 text-xs font-semibold rounded-lg"
			>
				<Loader2 size={12} className="animate-spin" />
				{t("deepDiveRunning")}
			</button>
		);
	}

	if (status === "failed") {
		return (
			<div className="space-y-1">
				<div className="flex items-center gap-1 text-[10px] text-red-600">
					<AlertTriangle size={10} />
					{t("deepDiveFailed")}
					{error && <span className="truncate max-w-[200px]" title={error}>({error.slice(0, 40)})</span>}
				</div>
				<button
					type="button"
					onClick={onTrigger}
					className="w-full px-4 py-2 bg-white hover:bg-amber-50 border border-amber-300 text-amber-800 text-xs font-semibold rounded-lg"
				>
					<Sparkles size={12} className="inline mr-1" />
					{t("deepDive")}
				</button>
			</div>
		);
	}

	if (status === "completed" && hasPackage) {
		return (
			<button
				type="button"
				onClick={onToggleDetails}
				className="w-full px-4 py-2 bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-800 text-xs font-semibold rounded-lg"
			>
				{showDetails ? t("hideDetails") : t("viewDetails")}
			</button>
		);
	}

	// idle
	return (
		<button
			type="button"
			onClick={onTrigger}
			className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-800 text-xs font-semibold rounded-lg"
		>
			<Sparkles size={12} />
			{t("deepDive")}
		</button>
	);
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add components/discovery/EnrichmentProgress.tsx
git commit -m "feat(discovery): add EnrichmentProgress component (button + spinner)"
```

---

## Task 10: `components/discovery/CPackageDrawer.tsx`

**Files:**
- Create: `components/discovery/CPackageDrawer.tsx`

- [ ] **Step 1: 파일 생성**

Write to `components/discovery/CPackageDrawer.tsx`:

```tsx
"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
	Building2,
	DollarSign,
	Package,
	Tv,
	TrendingUp,
	ExternalLink,
	Copy,
	CheckCircle2,
	AlertCircle,
} from "lucide-react";
import type { CPackage, Confidence } from "@/lib/discovery/types";

function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
	const t = useTranslations("discovery");
	const colorMap = {
		high: "bg-green-100 text-green-800 border-green-200",
		medium: "bg-yellow-100 text-yellow-800 border-yellow-200",
		low: "bg-gray-100 text-gray-600 border-gray-200",
	};
	const labelMap = {
		high: t("confidenceHigh"),
		medium: t("confidenceMedium"),
		low: t("confidenceLow"),
	};
	return (
		<span className={`text-[9px] px-1.5 py-0.5 rounded border ${colorMap[confidence]}`}>
			{labelMap[confidence]}
		</span>
	);
}

export function CPackageDrawer({ pkg }: { pkg: CPackage }) {
	const t = useTranslations("discovery");
	const [copied, setCopied] = useState(false);

	const m = pkg.manufacturer;
	const w = pkg.wholesale_estimate;
	const s = pkg.sns_trend;

	const snsLabel = {
		high: t("snsStrong"),
		medium: t("snsMedium"),
		low: t("snsWeak"),
		none: t("snsNone"),
	}[s.signal_strength];
	const snsColor = {
		high: "text-red-700 bg-red-50 border-red-200",
		medium: "text-orange-700 bg-orange-50 border-orange-200",
		low: "text-yellow-700 bg-yellow-50 border-yellow-200",
		none: "text-gray-500 bg-gray-50 border-gray-200",
	}[s.signal_strength];

	async function copyScript() {
		try {
			await navigator.clipboard.writeText(pkg.tv_script_draft);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			/* ignore */
		}
	}

	return (
		<div className="mt-3 pt-3 border-t border-gray-100 space-y-3">
			{pkg.partial && (
				<div className="flex items-center gap-1 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
					<AlertCircle size={10} />
					{t("partialResult")}
				</div>
			)}

			{/* Manufacturer */}
			<div className="bg-blue-50 border border-blue-100 rounded p-2 space-y-1">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-1">
						<Building2 size={11} className="text-blue-600" />
						<span className="text-[10px] font-bold text-blue-700 uppercase tracking-wide">
							{t("manufacturer")}
						</span>
					</div>
					<ConfidenceBadge confidence={m.confidence} />
				</div>
				{m.name ? (
					<div className="text-[11px] text-gray-800 font-medium">{m.name}</div>
				) : (
					<div className="text-[11px] text-gray-400">{t("manufacturerUnknown")}</div>
				)}
				{m.official_site && (
					<a
						href={m.official_site}
						target="_blank"
						rel="noopener noreferrer"
						className="text-[10px] text-blue-600 hover:underline inline-flex items-center gap-0.5"
					>
						<ExternalLink size={9} />
						{t("officialSite")}
					</a>
				)}
				{m.address && (
					<div className="text-[10px] text-gray-600">
						<span className="font-semibold">{t("address")}:</span> {m.address}
					</div>
				)}
				{m.contact_hints.length > 0 && (
					<div className="text-[10px] text-gray-600">
						<span className="font-semibold">{t("contactHints")}:</span>{" "}
						{m.contact_hints.join(", ")}
					</div>
				)}
			</div>

			{/* Wholesale */}
			<div className="bg-green-50 border border-green-100 rounded p-2 space-y-1">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-1">
						<DollarSign size={11} className="text-green-600" />
						<span className="text-[10px] font-bold text-green-700 uppercase tracking-wide">
							{t("wholesaleEstimate")}
						</span>
					</div>
					<ConfidenceBadge confidence={w.confidence} />
				</div>
				{w.estimated_cost_jpy !== null ? (
					<>
						<div className="text-[11px] text-gray-800">
							¥{w.retail_jpy.toLocaleString()} →{" "}
							<strong className="text-green-700">
								¥{w.estimated_cost_jpy.toLocaleString()}
							</strong>{" "}
							<span className="text-gray-500">
								({Math.round((w.estimated_margin_rate ?? 0) * 100)}%)
							</span>
						</div>
						<div className="text-[10px] text-gray-600">
							<span className="font-semibold">{t("wholesaleMethod")}:</span>{" "}
							{w.method === "blended"
								? t("wholesaleMethodBlended")
								: t("wholesaleMethodBaseline")}
							{w.sample_size > 0 && ` (n=${w.sample_size})`}
						</div>
					</>
				) : (
					<div className="text-[11px] text-gray-400">—</div>
				)}
			</div>

			{/* MOQ */}
			{pkg.moq_hint && (
				<div className="flex items-start gap-1.5 text-[11px] text-gray-700">
					<Package size={11} className="text-gray-400 mt-0.5 shrink-0" />
					<span>
						<span className="font-semibold">{t("moqHint")}:</span> {pkg.moq_hint}
					</span>
				</div>
			)}

			{/* TV Script */}
			<div className="bg-purple-50 border border-purple-100 rounded p-2 space-y-1">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-1">
						<Tv size={11} className="text-purple-600" />
						<span className="text-[10px] font-bold text-purple-700 uppercase tracking-wide">
							{t("tvScript")}
						</span>
					</div>
					<button
						type="button"
						onClick={copyScript}
						className="text-[10px] text-purple-600 hover:text-purple-800 inline-flex items-center gap-0.5"
					>
						{copied ? (
							<>
								<CheckCircle2 size={10} />
								{t("scriptCopied")}
							</>
						) : (
							<>
								<Copy size={10} />
								{t("copyScript")}
							</>
						)}
					</button>
				</div>
				<pre className="text-[10px] text-gray-700 whitespace-pre-wrap font-sans leading-relaxed">
					{pkg.tv_script_draft}
				</pre>
			</div>

			{/* SNS */}
			<div className={`flex items-center gap-1.5 text-[11px] border rounded px-2 py-1 ${snsColor}`}>
				<TrendingUp size={11} />
				<span className="font-semibold">{t("snsTrend")}:</span>
				<span>{snsLabel}</span>
				{s.sources.length > 0 && (
					<span className="text-[10px] opacity-70">({s.sources.join(", ")})</span>
				)}
			</div>
		</div>
	);
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add components/discovery/CPackageDrawer.tsx
git commit -m "feat(discovery): add CPackageDrawer (manufacturer/wholesale/script/SNS)"
```

---

## Task 11: `ProductCard.tsx` — enrichment 통합

**Files:**
- Modify: `components/discovery/ProductCard.tsx`

- [ ] **Step 1: 타입에 enrichment 필드 추가 + 버튼 + drawer 통합**

Open `components/discovery/ProductCard.tsx`. Replace entire file content:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Sparkles, Star, TrendingUp, ShoppingBag, Tv, Compass } from "lucide-react";
import { EnrichmentProgress } from "./EnrichmentProgress";
import { CPackageDrawer } from "./CPackageDrawer";
import type { CPackage } from "@/lib/discovery/types";

type EnrichmentStatus = "idle" | "queued" | "running" | "completed" | "failed";

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
};

function scoreColor(score: number): string {
	if (score >= 80) return "text-green-700 bg-green-100 border-green-300";
	if (score >= 60) return "text-blue-700 bg-blue-100 border-blue-300";
	if (score >= 40) return "text-yellow-700 bg-yellow-100 border-yellow-300";
	return "text-red-700 bg-red-100 border-red-300";
}

export function ProductCard({ product }: { product: DiscoveredProductRow }) {
	const t = useTranslations("discovery");
	const score = product.tv_fit_score ?? 0;
	const isTV = product.track === "tv_proven";

	const [status, setStatus] = useState<EnrichmentStatus>(
		product.enrichment_status ?? "idle",
	);
	const [pkg, setPkg] = useState<CPackage | null>(product.c_package ?? null);
	const [err, setErr] = useState<string | null>(product.enrichment_error ?? null);
	const [showDetails, setShowDetails] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const stopPolling = useCallback(() => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	}, []);

	const pollOnce = useCallback(async () => {
		const res = await fetch(`/api/discovery/enrich/${product.id}`, {
			cache: "no-store",
		});
		if (!res.ok) return;
		const data = await res.json();
		setStatus(data.status);
		if (data.c_package) setPkg(data.c_package);
		if (data.error) setErr(data.error);
		if (data.status === "completed" || data.status === "failed") {
			stopPolling();
			if (data.status === "completed") setShowDetails(true);
		}
	}, [product.id, stopPolling]);

	const startPolling = useCallback(() => {
		stopPolling();
		pollRef.current = setInterval(pollOnce, 2000);
	}, [pollOnce, stopPolling]);

	useEffect(() => {
		return () => stopPolling();
	}, [stopPolling]);

	const triggerEnrichment = useCallback(async () => {
		setErr(null);
		setStatus("queued");
		startPolling();
		try {
			await fetch(`/api/discovery/enrich/${product.id}`, { method: "POST" });
		} catch (error) {
			console.error("enrich POST failed", error);
		}
	}, [product.id, startPolling]);

	const broadcastBadge =
		product.broadcast_tag === "broadcast_confirmed"
			? { label: t("broadcastConfirmed"), color: "bg-red-100 text-red-700 border-red-200", icon: <Tv size={10} /> }
			: product.broadcast_tag === "broadcast_likely"
			? { label: t("broadcastLikely"), color: "bg-orange-100 text-orange-700 border-orange-200", icon: <Tv size={10} /> }
			: null;

	return (
		<article className="bg-white border border-amber-200 rounded-xl p-4 shadow-sm flex flex-col hover:shadow-md transition-shadow">
			{/* Header: source badge + name + score */}
			<div className="flex items-start justify-between gap-2 mb-2">
				<div className="flex items-center gap-2 flex-1 min-w-0">
					<span
						className={`text-[10px] px-2 py-0.5 rounded-full font-bold shrink-0 ${
							product.source === "rakuten"
								? "bg-red-100 text-red-700"
								: "bg-blue-100 text-blue-700"
						}`}
					>
						{product.source === "rakuten" ? "楽天" : "Web"}
					</span>
					<h3 className="font-bold text-sm text-gray-900 line-clamp-2" title={product.name}>
						{product.name}
					</h3>
				</div>
				<span
					className={`text-xs font-bold px-2 py-0.5 rounded-full border shrink-0 ${scoreColor(score)}`}
				>
					{score}
				</span>
			</div>

			{/* Thumbnail + metadata row */}
			<div className="flex gap-3 mb-3">
				<div className="flex-shrink-0 w-20 h-20 bg-gray-100 rounded-lg overflow-hidden border border-gray-200">
					{product.thumbnail_url ? (
						<img
							src={product.thumbnail_url}
							alt={product.name}
							className="w-full h-full object-cover"
						/>
					) : (
						<div className="w-full h-full flex items-center justify-center text-gray-300">
							<ShoppingBag size={24} />
						</div>
					)}
				</div>
				<div className="flex-1 flex flex-col justify-between min-w-0">
					<div className="flex flex-wrap gap-1.5 text-[10px]">
						<span className="bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5 text-gray-600">
							価格{" "}
							<strong className="text-gray-900">
								{product.price_jpy ? `¥${product.price_jpy.toLocaleString()}` : "¥?"}
							</strong>
						</span>
						{product.review_avg !== null && (
							<span className="bg-yellow-50 border border-yellow-200 rounded px-1.5 py-0.5 text-yellow-800 flex items-center gap-0.5">
								<Star size={9} className="fill-yellow-500 text-yellow-500" />
								<strong>{product.review_avg}</strong>
								<span className="text-yellow-600">({product.review_count ?? 0})</span>
							</span>
						)}
					</div>
					<div className="flex flex-wrap gap-1 items-center">
						<span
							className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold ${
								isTV
									? "bg-purple-50 text-purple-700 border border-purple-200"
									: "bg-emerald-50 text-emerald-700 border border-emerald-200"
							}`}
						>
							{isTV ? <Tv size={10} /> : <Compass size={10} />}
							{isTV ? t("trackTvProven") : t("trackExploration")}
						</span>
						{broadcastBadge && (
							<span
								className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border ${broadcastBadge.color}`}
							>
								{broadcastBadge.icon}
								{broadcastBadge.label}
							</span>
						)}
					</div>
					{product.seller_name && (
						<div className="text-[10px] text-gray-500 truncate" title={product.seller_name}>
							{product.seller_name}
						</div>
					)}
				</div>
			</div>

			{/* TV fit reason */}
			{product.tv_fit_reason && (
				<div className="bg-amber-50 border border-amber-100 rounded px-3 py-2 mb-3">
					<div className="flex items-center gap-1 mb-0.5">
						<TrendingUp size={11} className="text-amber-600" />
						<span className="text-[10px] font-bold text-amber-700 uppercase tracking-wide">
							TV適合性
						</span>
					</div>
					<p className="text-[11px] text-amber-900 leading-relaxed">
						{product.tv_fit_reason}
					</p>
				</div>
			)}

			{/* External link */}
			<div className="pb-2 border-b border-gray-100 mb-3">
				<a
					href={product.product_url}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium"
				>
					<Sparkles size={11} />
					{t("goLive")} →
				</a>
			</div>

			{/* Enrichment control */}
			<EnrichmentProgress
				status={status}
				hasPackage={!!pkg}
				showDetails={showDetails}
				onTrigger={triggerEnrichment}
				onToggleDetails={() => setShowDetails((v) => !v)}
				error={err}
			/>

			{/* C Package (when expanded) */}
			{showDetails && pkg && <CPackageDrawer pkg={pkg} />}
		</article>
	);
}
```

- [ ] **Step 2: 타입 체크 + 커밋**

```bash
npx tsc --noEmit
git add components/discovery/ProductCard.tsx
git commit -m "feat(discovery): integrate enrichment button + drawer into ProductCard"
```

---

## Task 12: 조회 API에 enrichment 필드 포함 검증

**Files:**
- (변경 없음, 검증만)

- [ ] **Step 1: 기존 API `select('*')` 확인**

Read `app/api/discovery/today/route.ts` and `app/api/discovery/sessions/[id]/route.ts`.

Both use `select("*")` from `discovered_products` → `enrichment_status`, `c_package`, `enrichment_error` 필드가 이미 포함됨. 추가 변경 불필요.

만약 select가 특정 컬럼만 하는 경우 `enrichment_status, c_package, enrichment_error` 추가 필요. 현재 `*` 이므로 괜찮음.

- [ ] **Step 2: 검증 후 진행 (commit 없음)**

---

## Task 13: Manual verification — 深掘り 클릭 → C 패키지 표시

**Files:** (실행만)

**Depends on:** Tasks 1-11.

- [ ] **Step 1: Dev 서버 실행**

```bash
npm run dev
```

서버는 보통 3000 포트 사용 중 → 3001 로 올라감. 로그 확인.

- [ ] **Step 2: 브라우저 접속**

`http://localhost:<port>/ja/analytics/発掘`

- [ ] **Step 3: "深掘り" 클릭 → 폴링 관찰**

카드 하단 "深掘り" 버튼 클릭 → 버튼이 "製造元を追跡中..." 스피너로 변경 → 약 15-45초 후 "詳細を見る" 버튼으로 전환 → 자동으로 drawer 펼침.

확인 사항:
- [ ] POST `/api/discovery/enrich/<id>` 가 202 반환
- [ ] GET `/api/discovery/enrich/<id>` 가 status='running' → 'completed' 로 전환
- [ ] DB `discovered_products.c_package` 에 jsonb 저장됨
- [ ] UI에 製造元 / 卸値 / TV스크립트 / SNS 블록 모두 표시
- [ ] "コピー" 버튼으로 TV 스크립트 클립보드 복사 동작
- [ ] 公式サイト 링크 클릭 → 외부 사이트 오픈

- [ ] **Step 4: 실패 케이스 테스트 (옵션)**

`enrich-agent.ts` 에서 일시적으로 throw하도록 수정 → 새 제품에서 深掘り → status='failed' + 에러 메시지 표시 확인 → 복구.

- [ ] **Step 5: DB 직접 검증**

Supabase SQL Editor:
```sql
SELECT id, name, enrichment_status, enrichment_completed_at, 
       c_package->>'manufacturer' as mfr,
       c_package->>'wholesale_estimate' as wholesale
FROM discovered_products
WHERE enrichment_status = 'completed'
ORDER BY enrichment_completed_at DESC
LIMIT 5;
```

- [ ] **Step 6: Phase 3 완료 선언**

```bash
git log --oneline main..HEAD | head -15
```

Phase 3 완료. PR #7 업데이트 됨.

---

## Self-Review

**Spec coverage:**
- §5.1 POST 202 + GET poll → Task 7 ✓
- §5.2 agent 8 tool calls + 55s timeout → Task 6 ✓
- §5.3 6개 tools — `fetch_rakuten_page`, `search_brave`, `extract_manufacturer`(agent 내 Gemini 추출로 흡수), `fetch_url_meta`, `estimate_wholesale`, `generate_tv_script` → Tasks 3-6 ✓
  - Note: `extract_manufacturer` 별도 tool 대신 agent 내부에서 `fetch_rakuten_page` 결과 manufacturerHint + Gemini 자체 파싱으로 수행. 단순화.
- §5.4 wholesale blend (0.6×baseline + 0.4×mediaworks, n≥3) → Task 2 ✓
- §5.5 agent 프롬프트 → Task 6 SYSTEM_PROMPT ✓
- §5.6 C package schema → Task 1 types ✓
- §5.7 fail-open + partial → Task 6 emptyCPackage + Task 7 worker ✓
- §5.8 cache → Task 7 force=1 파라미터 ✓
- UI: EnrichmentProgress + CPackageDrawer + ProductCard 통합 → Tasks 9-11 ✓

**Placeholder scan:** 모든 step 구체 코드 포함.

**Type consistency:**
- `CPackage`, `Confidence`, `ManufacturerInfo`, `WholesaleEstimate`, `SnsTrend` 모두 `types.ts` 에 정의 → `enrich-agent.ts`, `wholesale-rules.ts`, `CPackageDrawer.tsx` 에서 일관 사용.
- `EnrichmentStatus` 는 ProductCard 내부 로컬 타입 (types.ts 의 `EnrichmentStatus`와 매치).
- `enrichment_status`, `c_package`, `enrichment_error` 필드가 `DiscoveredProductRow` 에 추가됨 (optional — 과거 row 호환).

**Gaps / 주의:**
- Rakuten 페이지 스크래핑은 regex 기반 best-effort. 페이지 구조 변경 시 manufacturerHint 획득률 하락 가능. 실패 시 Gemini가 search_brave 로 보완 가능.
- `extract_manufacturer` tool을 별도 함수로 안 만들고 agent의 reasoning 으로 처리 (단순화). 필요 시 Phase 4에서 추가.
- `after()` API는 Next.js 15.1+ 에 stable. 프로젝트가 16.x 사용 중이면 OK. 아니면 `fetch().catch(...)` fire-and-forget 로 대체.
- Cost 예측: 일 사용자 클릭 5-10회 × agent ~6 tool calls + 2 Gemini calls (wholesale 없음) ≈ 월 $3-8. 낮은 편.
